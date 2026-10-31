import 'server-only'
import { and, asc, eq, gte, isNull, or } from 'drizzle-orm'
import { db } from '@/server/db'
import { orderSessions, tenants } from '@/server/db/schema'
import { startOfDayInZone } from '@/server/time'

/**
 * A bar tab's number — the 7 in "Tab 7 · white shirt" (code review UI-P12).
 *
 * The SAME rule `GET /api/sessions` numbers the Bar list by: every counter-
 * origin session opened since the start of the restaurant's day, plus any
 * still open from before it, oldest first, id breaking ties. The floor showed
 * "Tab 7 · white shirt" while the order and bill screens showed "Tab · white
 * shirt", so two guests in white shirts — an ordinary evening — read the same
 * there. If the list's rule ever changes, this changes with it.
 *
 * Null for a session that is not in that set (a table order).
 */
export async function tabSequence(sessionId: string): Promise<number | null> {
  const [tenant] = await db.select({ timezone: tenants.timezone }).from(tenants).limit(1)
  const startOfDay = startOfDayInZone(tenant?.timezone ?? 'Asia/Colombo')

  const rows = await db
    .select({ id: orderSessions.id })
    .from(orderSessions)
    .where(
      and(
        eq(orderSessions.kind, 'counter'),
        or(gte(orderSessions.openedAt, startOfDay), isNull(orderSessions.closedAt)),
      ),
    )
    .orderBy(asc(orderSessions.openedAt), asc(orderSessions.id))

  const index = rows.findIndex((row) => row.id === sessionId)
  return index < 0 ? null : index + 1
}

/** "Tab 7 · white shirt", "Tab 7", or the bare nickname if unnumbered. */
export function tabName(sequence: number | null, tabLabel: string | null): string {
  const number = sequence === null ? 'Tab' : `Tab ${sequence}`
  return tabLabel ? `${number} · ${tabLabel}` : sequence === null ? 'Bar tab' : number
}
