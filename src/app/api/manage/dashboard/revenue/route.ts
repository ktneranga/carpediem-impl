import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { revenueByHour } from '@/server/services/dashboard.service'

/** Today's and yesterday's takings by hour (Story 9.2). Behind both Manage gates. */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    return NextResponse.json({ success: true, data: await revenueByHour(db, actor.tenantId) })
  } catch (error) {
    console.error('[api/manage/dashboard/revenue] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the takings', 500)
  }
}
