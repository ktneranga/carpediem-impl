import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderEvents, orderSessions } from '@/server/db/schema'
import { isUniqueViolation } from '@/server/db/errors'
import { dishCount, dishTotalPaisa } from '@/server/orders/item-count'
import {
  MoveTargetNotFreeError,
  moveSessionToTable,
  SessionAlreadyClosedError,
  TableWentUnavailableError,
} from '@/server/services/table-session.service'
import { emitCounterSalesChanged, emitTableStatusChanged } from '@/server/socket/events'

const sessionIdSchema = z.string().uuid()
const bodySchema = z.object({ tableId: z.string().uuid() })

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Moves an order to another free table, in any zone (Teran, 2026-11-16).
 * Owner and waiters, like every order action (`/api/sessions`).
 */
export async function POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId: raw } = await params
  const sessionId = sessionIdSchema.safeParse(raw)
  if (!sessionId.success) return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return fail('UNAUTHENTICATED', 'Sign in required', 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail('INVALID_BODY', 'Request body must be JSON', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return fail('INVALID_BODY', 'Choose a table', 400)
  const toTableId = parsed.data.tableId

  let result: { toLabel: string; releasedTableIds: string[] }
  try {
    result = await db.transaction((tx) => moveSessionToTable(tx, { sessionId: sessionId.data, toTableId, staffId }))
  } catch (error) {
    if (error instanceof SessionAlreadyClosedError) return fail('SESSION_ALREADY_CLOSED', 'This order is not open', 409)
    if (
      error instanceof MoveTargetNotFreeError ||
      error instanceof TableWentUnavailableError ||
      isUniqueViolation(error, 'idx_one_open_session_per_table')
    ) {
      return fail('TABLE_NOT_FREE', 'That table is no longer free. Choose another.', 409)
    }
    console.error('[api/sessions/:sessionId/move] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not move the order', 500)
  }

  // Tell every tablet: the old tables are free, the new one has this order.
  try {
    const [session] = await db
      .select({ openedAt: orderSessions.openedAt, dailyNumber: orderSessions.dailyNumber })
      .from(orderSessions)
      .where(eq(orderSessions.id, sessionId.data))
      .limit(1)
    const [items] = await db
      .select({ total: dishCount, totalPaisa: dishTotalPaisa })
      .from(orderEvents)
      .where(and(eq(orderEvents.sessionId, sessionId.data), eq(orderEvents.eventType, 'ITEM_ADDED')))
    for (const tableId of result.releasedTableIds) {
      emitTableStatusChanged({
        tableId,
        status: 'open',
        sessionId: null,
        openedAt: null,
        dailyNumber: null,
        itemCount: 0,
        totalPaisa: 0,
        unavailableReason: null,
        groupTableLabels: [],
      })
    }
    emitTableStatusChanged({
      tableId: toTableId,
      status: 'occupied',
      sessionId: sessionId.data,
      openedAt: session!.openedAt.toISOString(),
      dailyNumber: session!.dailyNumber,
      itemCount: Number(items?.total ?? 0),
      totalPaisa: Number(items?.totalPaisa ?? 0),
      unavailableReason: null,
      groupTableLabels: [result.toLabel],
    })
    // A bar tab that was seated leaves the counter list.
    emitCounterSalesChanged()
  } catch (error) {
    // The move is committed; tablets resync on their next refetch.
    console.error('[api/sessions/:sessionId/move] Moved, but could not announce it:', error)
  }

  return NextResponse.json({ success: true, data: { tableLabel: result.toLabel } })
}
