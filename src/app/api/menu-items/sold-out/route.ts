import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { loadSoldOutBoard } from '@/server/services/menu-admin.service'

/** The Sold out board (Story 8.3): every active dish, its options, and each switch. */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    return NextResponse.json({ success: true, data: await loadSoldOutBoard(db, actor.tenantId) })
  } catch (error) {
    console.error('[api/menu-items/sold-out] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the menu', 500)
  }
}
