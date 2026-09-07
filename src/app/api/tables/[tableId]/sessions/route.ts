import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderSessions, tables } from '@/server/db/schema'
import { openSession, TableWentUnavailableError } from '@/server/services/table-session.service'
import { emitTableStatusChanged } from '@/server/socket/events'

/** PostgreSQL unique_violation. This is the concurrency control, see below. */
const PG_UNIQUE_VIOLATION = '23505'

/**
 * The one index whose violation means "someone else got this table first".
 *
 * Matched by name, not just by error code. Today the whole schema has exactly
 * two unique indexes and neither other one is reachable from this insert, so
 * code alone would be correct — but the day `order_sessions` gains a second
 * unique index (a session number, an idempotency key), a collision on THAT
 * would have been reported to the waiter as "table already occupied" while the
 * real cause never reached a log, because the 409 branch does not log.
 */
const OPEN_SESSION_INDEX = 'idx_order_sessions_one_open_per_table'


const tableIdSchema = z.string().uuid()

/**
 * True when the error (or anything it wraps) is a unique-constraint violation.
 *
 * Drizzle sometimes surfaces the driver error directly and sometimes wraps it in
 * `cause`, so checking only the top level misses the wrapped case — and missing
 * it turns the concurrency path into an unhandled 500.
 */
function isOpenSessionConflict(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && 'code' in current && current.code === PG_UNIQUE_VIOLATION) {
      // `constraint` sits on the same driver error object as `code`. If a future
      // driver stops populating it, fall back to treating any unique violation
      // here as the open-session conflict — the previous behaviour.
      const constraint = (current as { constraint?: unknown }).constraint
      return constraint === undefined || constraint === OPEN_SESSION_INDEX
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
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
 * The partial unique index `idx_order_sessions_one_open_per_table` — on
 * `table_id WHERE closed_at IS NULL` — makes the second insert impossible at the
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

  try {
    // tenantId comes from the table row, not a separate tenants lookup — that
    // would let a table belonging to one tenant be opened under another's id.
    const [table] = await db
      .select({
        id: tables.id,
        tenantId: tables.tenantId,
        status: tables.status,
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

    // Fast path only — see the concurrency note above. Returns the same body as
    // the 23505 branch so a client cannot tell which one fired; they are the
    // same fact arriving by two routes.
    const [existing] = await db
      .select({ id: orderSessions.id })
      .from(orderSessions)
      .where(and(eq(orderSessions.tableId, tableId), isNull(orderSessions.closedAt)))
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
    emitTableStatusChanged({
      tableId: table.id,
      status: 'occupied',
      sessionId: session.id,
      openedAt,
      itemCount: 0,
    })

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
