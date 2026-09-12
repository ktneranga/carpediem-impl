import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import {
  InvalidAvailabilityTransitionError,
  setTableAvailability,
} from '@/server/services/table-session.service'
import { emitTableStatusChanged } from '@/server/socket/events'

const tableIdSchema = z.string().uuid()

/**
 * Trim BEFORE the length check, or "   " passes a bare `min(1)`.
 *
 * A reason is required because an unattributed "not in service" is precisely
 * what this story exists to prevent — the whole point is that someone can
 * answer "who took table 6 out, and why".
 */
const bodySchema = z.object({
  reason: z.string().trim().min(1).max(200),
})

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Takes a table out of service.
 *
 * ── Why this is owner + waiter, while returning to service is owner only ─────
 * The asymmetry matches how the risk runs. Taking a table out fails safe: the
 * worst case is a table sitting idle. Putting it back is the risky direction,
 * because a broken table becomes bookable again — so that lives at
 * POST /api/config/tables/:tableId/return-to-service, under the owner-only
 * `/api/config` policy.
 *
 * The namespace carries the permission because prefix matching cannot
 * distinguish `/api/tables/:id/x` from `/api/tables/:id/y` — the dynamic segment
 * defeats longest-prefix specialisation. No permissions.ts change was needed for
 * either route.
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

  const parsedBody = bodySchema.safeParse(body)
  if (!parsedBody.success) {
    return fail('INVALID_BODY', 'A reason is required (1-200 characters)', 400)
  }
  const { reason } = parsedBody.data

  try {
    const [table] = await db
      .select({ id: tables.id, tenantId: tables.tenantId, status: tables.status })
      .from(tables)
      .where(eq(tables.id, tableId))
      .limit(1)

    if (!table) {
      return fail('TABLE_NOT_FOUND', 'No such table', 404)
    }

    if (table.status === 'unavailable') {
      return fail('TABLE_NOT_AVAILABLE', 'This table is already out of service', 409)
    }

    // A table with guests at it cannot silently vanish from the floor plan.
    // Checked here for a clear message; the service's UPDATE predicate is the
    // backstop if this check is ever removed.
    const [openSession] = await db
      .select({ id: orderSessions.id })
      .from(orderSessions)
      // Through the join table — order_sessions.table_id is only the PRIMARY
      // table now, so matching on it alone misses merged groups.
      .innerJoin(orderSessionTables, eq(orderSessionTables.sessionId, orderSessions.id))
      .where(
        and(
          eq(orderSessionTables.tableId, tableId),
          isNull(orderSessionTables.releasedAt),
          isNull(orderSessions.closedAt),
        ),
      )
      .limit(1)

    if (openSession) {
      return fail(
        'TABLE_HAS_OPEN_SESSION',
        'This table has guests at it. Close or settle the session first.',
        409,
      )
    }

    try {
      await db.transaction((tx) =>
        setTableAvailability(tx, {
          tableId: table.id,
          tenantId: table.tenantId,
          staffId,
          toStatus: 'unavailable',
          reason,
        }),
      )
    } catch (error) {
      if (error instanceof InvalidAvailabilityTransitionError) {
        // Another device changed the table between our read and the UPDATE.
        return fail('TABLE_NOT_AVAILABLE', 'This table is no longer open', 409)
      }
      throw error
    }

    // After the commit, never inside — the same rule as every other route here.
    emitTableStatusChanged({
      tableId: table.id,
      status: 'unavailable',
      sessionId: null,
      openedAt: null,
      itemCount: 0,
      unavailableReason: reason,
      // No session on an availability change, so no group.
      groupTableLabels: [],
    })

    // 200, not 201: nothing was created from the caller's point of view.
    return NextResponse.json(
      { success: true, data: { tableId: table.id, status: 'unavailable', reason } },
      { status: 200 },
    )
  } catch (error) {
    console.error('[api/tables/:tableId/out-of-service] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not take the table out of service', 500)
  }
}
