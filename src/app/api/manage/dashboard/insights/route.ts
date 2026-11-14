import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { checkPeriod, loadInsights } from '@/server/services/insights.service'

/**
 * The dashboard for a period: `?period=today|yesterday|week|month` (default
 * today), or `?period=day&date=YYYY-MM-DD` for any day up to today. Behind both Manage gates.
 */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const params = new URL(request.url).searchParams
    const period = checkPeriod(params.get('period'))
    return NextResponse.json({ success: true, data: await loadInsights(db, actor.tenantId, period, params.get('date')) })
  } catch (error) {
    if (error instanceof MenuRuleError) return menuFail('INVALID', error.message, 422)
    console.error('[api/manage/dashboard/insights] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the dashboard', 500)
  }
}
