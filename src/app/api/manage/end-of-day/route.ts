import { NextResponse } from 'next/server'
import { db } from '@/server/db'
import { actorOf, menuFail } from '@/server/menu-admin/route'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { checkTakingsDate, loadTakings, todayBusinessDate } from '@/server/services/takings.service'

/**
 * Manage → End of day (Story 9.5): one business day's takings. `?date=` is
 * `YYYY-MM-DD`; none means today. Behind both Manage gates (`/api/manage`).
 * `today` comes back too, so the screen can stop at it.
 */
export async function GET(request: Request) {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const today = await todayBusinessDate(db, actor.tenantId)
    const asked = new URL(request.url).searchParams.get('date')
    const businessDate = asked ? await checkTakingsDate(db, actor.tenantId, asked) : today
    const takings = await loadTakings(db, { tenantId: actor.tenantId, businessDate })
    return NextResponse.json({ success: true, data: { today, takings } })
  } catch (error) {
    if (error instanceof MenuRuleError) return menuFail('INVALID', error.message, 422)
    console.error('[api/manage/end-of-day] Read failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not load the takings', 500)
  }
}
