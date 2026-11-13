import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/server/db'
import { actorOf, menuFail, readBody } from '@/server/menu-admin/route'
import { wakePrintQueue } from '@/server/print/wake'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { printTakings } from '@/server/services/takings.service'

/** Prints the day's takings on the receipt printer (Story 9.5). 202: a request to the printer. */
export async function POST(request: Request) {
  const body = await readBody(request, z.object({ date: z.string().max(10) }))
  if (!body) return menuFail('INVALID_BODY', 'Which day?', 400)
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const result = await db.transaction((tx) =>
      printTakings(tx, { tenantId: actor.tenantId, staffId: actor.staffId, businessDate: body.date }))
    wakePrintQueue()
    return NextResponse.json({ success: true, data: result }, { status: 202 })
  } catch (error) {
    if (error instanceof MenuRuleError) return menuFail('INVALID', error.message, 422)
    console.error('[api/manage/end-of-day/print] Print failed:', error)
    return menuFail('INTERNAL_ERROR', 'Could not send it to the printer', 500)
  }
}
