import { NextResponse } from 'next/server'
import { z } from 'zod'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { loadOrderStory } from '@/server/services/audit.service'

/**
 * One order's story for Manage → Orders (Story 7.7) — the same story as
 * Audit's, served under the Orders area so `manage_orders` alone opens it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!z.string().uuid().safeParse(sessionId).success) return menuFail('INVALID_ID', 'Order id must be a UUID', 400)
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const story = await loadOrderStory(actor.tenantId, sessionId)
    if (!story) return menuFail('NOT_FOUND', 'No such order', 404)
    return NextResponse.json({ success: true, data: story })
  } catch (error) {
    console.error('[api/manage/orders/:id] Failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the order', 500)
  }
}
