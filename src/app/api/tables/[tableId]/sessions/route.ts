import { NextResponse } from 'next/server'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { isUniqueViolation } from '@/server/db/errors'
import { orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import { openSession, TableWentUnavailableError } from '@/server/services/table-session.service'
import { emitTableStatusChanged } from '@/server/socket/events'

/** PostgreSQL unique_violation. This is the concurrency control, see below. */

/**
 * The one index whose violation means "someone else got this table first".
 *
 * Matched by name, not just by error code. The index MOVED to
 * order_session_tables in Story 3.8 and was renamed — this constant moved with
 * it. Leaving the old name here would have made this function return false for
 * every real conflict, turning the concurrency path into a 500 with no compile,
 * lint or build signal.
 *
 * Matching on the name rather than the code alone also keeps a future second
 * unique index from being reported to the waiter as "table already occupied"
 * while its real cause never reaches a log — the 409 branch does not log.
 */
const OPEN_SESSION_INDEX = 'idx_one_open_session_per_table'


const tableIdSchema = z.string().uuid()

/**
 * Optional merge group (FR62 — within a zone only).
 *
 * Absent body is valid: opening one table is still the common case, and the
 * route predates merging. That is handled by `.optional()` plus the
 * `request.json().catch(() => ({}))` below — NOT by `.catch()` on the object.
 *
 * `.catch()` used to sit here, and it swallowed every validation failure inside
 * the object: one non-UUID id, or twelve entries instead of eleven, silently
 * became "no extra tables". The route then returned **201 having seated the
 * anchor alone**, the client took 201 as success and navigated to the order
 * screen, and the waiter believed a party of eight was merged while seven
 * tables sat free on the floor with nothing reporting it. Absent and invalid
 * are different answers and must not share a branch.
 */
const openBodySchema = z.object({
  additionalTableIds: z.array(z.string().uuid()).max(11).optional(),
})

/**
 * True when the error is the open-session unique violation.
 *
 * The walk itself lives in `@/server/db/errors` — the merge route needs exactly
 * the same check, and copying it by hand is how that route ended up matching on
 * `23505` alone and reporting an unrelated collision to the waiter as "table
 * already occupied".
 */
function isOpenSessionConflict(error: unknown): boolean {
  return isUniqueViolation(error, OPEN_SESSION_INDEX)
}

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Opens an order session on a table.
 *
 * ── Concurrency ──────────────────────────────────────────────────────────────
 * Two waiters tapping the same card at the same moment is ordinary during
 * service, and this route does NOT try to prevent it with a read-then-write
 * check. That would be check-then-act: both requests read "no open session",
 * both insert, and the result is either two open sessions or an unhandled 500.
 *
 * The partial unique index `idx_one_open_session_per_table` — on
 * `order_session_tables.table_id WHERE released_at IS NULL` — makes the second
 * insert impossible at the
 * database level. PostgreSQL serialises the two, one commits, the other raises
 * 23505, and we translate that into a 409. The pre-check below is only a fast
 * path for a good error message; the catch is the correctness mechanism.
 *
 * Authentication is handled by src/proxy.ts, which strips any client-sent
 * x-staff-id and re-sets it from the validated session. RBAC (kitchen staff are
 * excluded from writes here) is enforced by the method-scoped `/api/tables`
 * policy in src/server/auth/permissions.ts.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tableId: string }> },
) {
  const { tableId: rawTableId } = await params

  const parsedTableId = tableIdSchema.safeParse(rawTableId)
  if (!parsedTableId.success) {
    // Caught here so a malformed id is a 400, not a 500 from PostgreSQL's own
    // uuid parser rejecting the value mid-query.
    return fail('INVALID_TABLE_ID', 'Table id must be a UUID', 400)
  }
  const tableId = parsedTableId.data

  // Identity of record for the audit trail (NFR-S3). The proxy guarantees this
  // header reflects a validated session, so absence means something upstream is
  // wrong — never insert a session with unknown attribution.
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  // An ABSENT body is fine — `.catch(() => ({}))` turns "no body" into "{}",
  // which the schema accepts. An INVALID body is rejected.
  const parsedBody = openBodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsedBody.success) {
    return fail(
      'INVALID_BODY',
      'additionalTableIds must be an array of at most 11 table UUIDs',
      400,
    )
  }

  // Deduplicated, and the anchor removed if the client sent it in both places.
  //
  // Compared case-INSENSITIVELY against the validated `tableId`. PostgreSQL
  // compares `uuid` values case-insensitively and zod's `.uuid()` accepts either
  // case, so a JavaScript `!==` against the raw segment let the anchor through
  // in different casing. `allTableIds` then held it twice and the insert
  // violated the composite PRIMARY KEY rather than the open-session index — so
  // the name-matched conflict check returned false and it escaped as a 500.
  const normalisedAnchor = tableId.toLowerCase()
  const additionalTableIds = [
    ...new Map(
      (parsedBody.data.additionalTableIds ?? []).map((id) => [id.toLowerCase(), id]),
    ).values(),
  ].filter((id) => id.toLowerCase() !== normalisedAnchor)

  try {
    // tenantId comes from the table row, not a separate tenants lookup — that
    // would let a table belonging to one tenant be opened under another's id.
    const [table] = await db
      .select({
        id: tables.id,
        label: tables.label,
        tenantId: tables.tenantId,
        status: tables.status,
        zoneId: tables.zoneId,
      })
      .from(tables)
      .where(eq(tables.id, tableId))
      .limit(1)

    if (!table) {
      return fail('TABLE_NOT_FOUND', 'No such table', 404)
    }

    if (table.status === 'unavailable') {
      return fail('TABLE_NOT_AVAILABLE', 'This table is not in service', 422)
    }

    // Every table in a merge must share the anchor's zone (FR62 — cross-zone is
    // explicitly out of v1). Checked before anything is written.
    let additionalTableLabels: string[] = []

    if (additionalTableIds.length > 0) {
      const extras = await db
        .select({
          id: tables.id,
          label: tables.label,
          zoneId: tables.zoneId,
          status: tables.status,
        })
        .from(tables)
        .where(inArray(tables.id, additionalTableIds))

      if (extras.length !== additionalTableIds.length) {
        return fail('TABLE_NOT_FOUND', 'One of the tables does not exist', 404)
      }
      if (extras.some((t) => t.zoneId !== table.zoneId)) {
        return fail('CROSS_ZONE_MERGE', 'Tables can only be merged within one zone', 422)
      }
      if (extras.some((t) => t.status === 'unavailable')) {
        return fail('TABLE_NOT_AVAILABLE', 'One of the tables is not in service', 422)
      }

      additionalTableLabels = extras.map((t) => t.label)
    }

    // Fast path only — see the concurrency note above. Returns the same body as
    // the 23505 branch so a client cannot tell which one fired; they are the
    // same fact arriving by two routes.
    const [existing] = await db
      .select({ id: orderSessions.id })
      .from(orderSessions)
      // Through the join table — order_sessions.table_id is only the PRIMARY
      // table now, so matching on it alone misses merged groups.
      .innerJoin(orderSessionTables, eq(orderSessionTables.sessionId, orderSessions.id))
      .where(
        and(
          inArray(orderSessionTables.tableId, [tableId, ...additionalTableIds]),
          isNull(orderSessionTables.releasedAt),
          isNull(orderSessions.closedAt),
        ),
      )
      .limit(1)

    if (existing) {
      return fail('TABLE_ALREADY_OCCUPIED', 'This table already has an open session', 409)
    }

    let session: { id: string; openedAt: Date }

    try {
      // One transaction: the session, the table's status and the audit event
      // move together, or none of them does. A committed session beside a stale
      // table row is the exact divergence the read path was fixed to make
      // impossible — do not reintroduce it on the write path.
      //
      // The writes live in table-session.service.ts so Story 6.5's settled close
      // and this open share one implementation. This route keeps the policy —
      // which tables may be opened, what each failure returns — and the service
      // keeps the writes.
      session = await db.transaction((tx) =>
        openSession(tx, {
          tableId: table.id,
          tenantId: table.tenantId,
          staffId,
          additionalTableIds,
          additionalTableLabels,
        }),
      )
    } catch (error) {
      if (error instanceof TableWentUnavailableError) {
        return fail('TABLE_NOT_AVAILABLE', 'This table is not in service', 422)
      }
      if (isOpenSessionConflict(error)) {
        // Another device committed first, between our pre-check and our insert.
        return fail('TABLE_ALREADY_OCCUPIED', 'This table already has an open session', 409)
      }
      throw error
    }

    const openedAt = session.openedAt.toISOString()

    // Emitted AFTER the transaction commits, never inside it. Emitting inside
    // lets a client receive the event and refetch before the commit lands,
    // reading pre-commit state — rare, real, and miserable to debug.
    //
    // itemCount is 0 by definition: the session was created this instant and
    // order_events cannot reference it yet.
    // ONE EVENT PER TABLE. A merge changes several tables at once and the
    // client patches a single row per event — `architecture.md:381` documents
    // the event as per-table for exactly this reason.
    //
    // The payload carries `groupTableLabels`. It did not, originally, and the
    // comment here claimed "no client change was needed to support merging" —
    // which was wrong: the client decides whether to collapse a group SOLELY
    // from that array, so a pre-merged seating rendered as separate cards on
    // every device except the one that opened it.
    const groupTableLabels =
      additionalTableIds.length > 0
        ? [table.label, ...additionalTableLabels].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true }),
          )
        : [table.label]

    for (const id of [table.id, ...additionalTableIds]) {
      emitTableStatusChanged({
        tableId: id,
        status: 'occupied',
        sessionId: session.id,
        openedAt,
        itemCount: 0,
        groupTableLabels,
        // A session change never alters availability; none of these tables is
        // out of service, or the request would have been refused above.
        unavailableReason: null,
      })
    }

    return NextResponse.json(
      {
        success: true,
        data: { sessionId: session.id, tableId: table.id, openedAt, status: 'occupied' },
      },
      { status: 201 },
    )
  } catch (error) {
    console.error('[api/tables/:tableId/sessions] Failed to open session:', error)
    return fail('INTERNAL_ERROR', 'Could not open the table', 500)
  }
}
