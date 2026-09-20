import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { dishCount } from '@/server/orders/item-count'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import {
  closeSession,
  SessionAlreadyClosedError,
  CLIENT_CLOSE_REASONS,
} from '@/server/services/table-session.service'
import { emitTableStatusChanged } from '@/server/socket/events'

const tableIdSchema = z.string().uuid()

/**
 * `settled` is absent on purpose.
 *
 * It belongs to Story 6.5's payment flow, where the close happens in the same
 * transaction as the final payment record. Accepting it here would let any
 * client mark a table settled with no payment behind it — a hole straight
 * through the audit trail this product is built on.
 */
const closeBodySchema = z.object({
  reason: z.enum(CLIENT_CLOSE_REASONS),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Closes a table session without payment.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Until this route, a table could be occupied but never released: the only close
 * in the plan was a side effect of full payment (Story 6.5), gated on a settled
 * bill that an empty session can never produce. Mis-taps, parties leaving before
 * ordering, and walkouts all left a table permanently occupied.
 *
 * ── Concurrency ──────────────────────────────────────────────────────────────
 * The partial unique index does NOT help here — it constrains open sessions, not
 * closes. The guard is the conditional UPDATE inside `closeSession`
 * (`WHERE closed_at IS NULL`) and its row count. The read below is a fast path
 * for a good error message, exactly as on the open route; it is not the
 * correctness mechanism.
 *
 * RBAC is already enforced: `/api/tables` is owner + waiter for every method
 * except GET/HEAD (src/server/auth/permissions.ts), and this is a POST beneath
 * that prefix. No policy change was needed for this route.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ tableId: string }> },
) {
  const { tableId: rawTableId } = await params

  const parsedTableId = tableIdSchema.safeParse(rawTableId)
  if (!parsedTableId.success) {
    return fail('INVALID_TABLE_ID', 'Table id must be a UUID', 400)
  }
  const tableId = parsedTableId.data

  const staffId = request.headers.get('x-staff-id')
  if (!staffId) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }

  const parsedBody = closeBodySchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'reason must be "abandoned" or "walkout"', 400)
  }
  const { reason } = parsedBody.data

  try {
    const [table] = await db
      .select({ id: tables.id })
      .from(tables)
      .where(eq(tables.id, tableId))
      .limit(1)

    if (!table) {
      return fail('TABLE_NOT_FOUND', 'No such table', 404)
    }

    const [session] = await db
      .select({ id: orderSessions.id })
      .from(orderSessions)
      // Through the join table: a session no longer belongs to one table, and
      // order_sessions.table_id is only the PRIMARY. Matching on that alone
      // would fail to find the session from any other table in a merged group.
      .innerJoin(orderSessionTables, eq(orderSessionTables.sessionId, orderSessions.id))
      .where(
        and(
          eq(orderSessionTables.tableId, tableId),
          isNull(orderSessionTables.releasedAt),
          isNull(orderSessions.closedAt),
        ),
      )
      .limit(1)

    // 409, not 404: the table exists, there is simply nothing open on it. Either
    // it was never opened or another device closed it first — both are the same
    // fact from the caller's point of view.
    if (!session) {
      return fail('SESSION_ALREADY_CLOSED', 'This table has no open session', 409)
    }

    // Sums ITEM_ADDED quantities (dishes, not rows) without subtracting ITEM_REMOVED, matching the
    // simplification /api/tables already documents. Removal does not exist until
    // Epic 4; when it does, both places change together.
    const [items] = await db
      .select({ total: dishCount })
      .from(orderEvents)
      .where(and(eq(orderEvents.sessionId, session.id), eq(orderEvents.eventType, 'ITEM_ADDED')))

    const itemCount = Number(items?.total ?? 0)

    // A session with orders in it is a walkout or a bill — never an
    // abandonment. Refusing here keeps the audit trail honest: "abandoned"
    // must always mean "nothing was ever ordered".
    if (reason === 'abandoned' && itemCount > 0) {
      return fail(
        'SESSION_HAS_ITEMS',
        'This table has orders on it. Close it as a walkout, or settle the bill.',
        409,
      )
    }

    let closedAt: Date
    let releasedTableIds: string[]
    try {
      const result = await db.transaction((tx) =>
        closeSession(tx, { sessionId: session.id, staffId, reason }),
      )
      closedAt = result.closedAt
      releasedTableIds = result.releasedTableIds
    } catch (error) {
      if (error instanceof SessionAlreadyClosedError) {
        // Another device won the race between our read and the UPDATE.
        return fail('SESSION_ALREADY_CLOSED', 'This table has no open session', 409)
      }
      throw error
    }

    // One event per RELEASED table, after the commit — never inside it.
    //
    // `closeSession` releases every table on the session, but this emitted once
    // for the table the URL named. Closing a merged group therefore left every
    // other table in it occupied on every device except the one that acted —
    // stale sessionId, running timer, and a phantom group card — until an
    // unrelated refetch, because nothing on the grid refetches on its own.
    for (const releasedTableId of releasedTableIds) {
      emitTableStatusChanged({
        tableId: releasedTableId,
        status: 'open',
        sessionId: null,
        openedAt: null,
        itemCount: 0,
        // A session change never alters availability; the table is not out of
        // service on either of these paths.
        unavailableReason: null,
        // No session, so no group.
        groupTableLabels: [],
      })
    }

    // 200, not 201: this closes a resource, it does not create one.
    return NextResponse.json(
      {
        success: true,
        data: {
          sessionId: session.id,
          tableId: table.id,
          closedAt: closedAt.toISOString(),
          reason,
        },
      },
      { status: 200 },
    )
  } catch (error) {
    console.error('[api/tables/:tableId/sessions/close] Failed to close session:', error)
    return fail('INTERNAL_ERROR', 'Could not close the table', 500)
  }
}
