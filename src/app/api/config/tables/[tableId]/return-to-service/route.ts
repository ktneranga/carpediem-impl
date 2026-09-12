import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { tables } from '@/server/db/schema'
import {
  InvalidAvailabilityTransitionError,
  setTableAvailability,
} from '@/server/services/table-session.service'
import { emitTableStatusChanged } from '@/server/socket/events'

const tableIdSchema = z.string().uuid()

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * Returns a table to service. OWNER ONLY.
 *
 * ── Why this route lives under /api/config ───────────────────────────────────
 * `{ prefix: '/api/config', roles: ['owner'] }` already exists in
 * src/server/auth/permissions.ts, so the owner-only rule is enforced by the
 * proxy before this handler runs. NO new policy was added — and none could have
 * worked under `/api/tables`, because prefix matching cannot distinguish
 * `/api/tables/:id/out-of-service` from `/api/tables/:id/return-to-service`: the
 * dynamic segment defeats longest-prefix specialisation. The namespace is what
 * carries the permission.
 *
 * Restoring is the risky direction — a broken table becomes bookable again —
 * which is why it is gated more tightly than taking one out of service. Any
 * staff member can do that, at POST /api/tables/:tableId/out-of-service.
 *
 * This is the first route under /api/config. Story 10.3 fills in the rest of
 * configuration.
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

  try {
    const [table] = await db
      .select({ id: tables.id, tenantId: tables.tenantId, status: tables.status })
      .from(tables)
      .where(eq(tables.id, tableId))
      .limit(1)

    if (!table) {
      return fail('TABLE_NOT_FOUND', 'No such table', 404)
    }

    if (table.status !== 'unavailable') {
      return fail('TABLE_NOT_UNAVAILABLE', 'This table is not out of service', 409)
    }

    try {
      await db.transaction((tx) =>
        setTableAvailability(tx, {
          tableId: table.id,
          tenantId: table.tenantId,
          staffId,
          toStatus: 'open',
          // Cleared, not carried over — the reason describes why a table is
          // currently out of service, and the history is in table_status_events.
          reason: null,
        }),
      )
    } catch (error) {
      if (error instanceof InvalidAvailabilityTransitionError) {
        return fail('TABLE_NOT_UNAVAILABLE', 'This table is no longer out of service', 409)
      }
      throw error
    }

    emitTableStatusChanged({
      tableId: table.id,
      status: 'open',
      sessionId: null,
      openedAt: null,
      itemCount: 0,
      // Cleared alongside the column, so a remote cache cannot keep showing the
      // previous outage's reason against a table that is back in service.
      unavailableReason: null,
      // No session on an availability change, so no group.
      groupTableLabels: [],
    })

    return NextResponse.json(
      { success: true, data: { tableId: table.id, status: 'open' } },
      { status: 200 },
    )
  } catch (error) {
    console.error('[api/config/tables/:tableId/return-to-service] Failed:', error)
    return fail('INTERNAL_ERROR', 'Could not return the table to service', 500)
  }
}
