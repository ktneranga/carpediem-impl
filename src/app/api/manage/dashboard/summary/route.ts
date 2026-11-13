import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { loadSummary } from '@/server/services/dashboard.service'

/** The dashboard's cards in one response (Story 9.3): cash check, comps, sold out, long-open orders. */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    return NextResponse.json({ success: true, data: await loadSummary(db, actor.tenantId) })
  } catch (error) {
    console.error('[api/manage/dashboard/summary] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the dashboard', 500)
  }
}
