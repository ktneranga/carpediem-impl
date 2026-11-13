import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { actorOf, menuFail, readBody } from '@/server/menu-admin/route'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { recordCashCount } from '@/server/services/dashboard.service'

/** Records the cash the owner counted for today's business date (Story 9.3). A recount adds a row. */
export async function POST(request: Request) {
  const body = await readBody(request, z.object({ countedPaisa: z.number() }))
  if (!body) return menuFail('INVALID_BODY', 'Enter the cash counted', 400)
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const count = await recordCashCount(db, { ...actor, countedPaisa: body.countedPaisa })
    return NextResponse.json({ success: true, data: count }, { status: 201 })
  } catch (error) {
    if (error instanceof MenuRuleError) return menuFail('INVALID', error.message, 422)
    console.error('[api/manage/dashboard/cash-count] Save failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not save the count', 500)
  }
}
