import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { menuItems, orderEvents, seatSlots } from '@/server/db/schema'

/** One submitted item, as the history renders it. */
export type SubmittedItemRow = {
  id: string
  name: string
  quantity: number
  /** Integer paisa, AS QUOTED — read from the event row, never from the menu. */
  unitPricePaisa: number | null
  modifierText: string | null
  seatLabel: string | null
  submittedAt: string
}

/** One round of a session's ordering, oldest first. */
export type SubmittedRoundRow = {
  roundNumber: number
  items: SubmittedItemRow[]
}

/** What a history row says when its menu item has since been deleted. */
const MISSING_ITEM_NAME = 'Item no longer on the menu'

/**
 * A session's already-submitted items, grouped by round (Story 4.4, AC-6).
 *
 * ── One implementation, two callers ──────────────────────────────────────────
 * The order page renders this in its first paint and `GET .../orders` returns
 * it on refetch. They used to be two copies of the query and the grouping, with
 * a comment claiming the compiler would notice if they drifted — but sharing the
 * row TYPE shares nothing about the NULL bucketing, the sort or the fallback
 * name. A drift would have shown the waiter a history that rearranged itself on
 * the first window-focus refetch.
 *
 * ── Rows from before migration 0014 ──────────────────────────────────────────
 * They have no `round_number` and are bucketed as round 1 rather than dropped —
 * a guest may be about to be billed for them. The SORT uses the same
 * `coalesce(round_number, 1)`: a plain `ORDER BY round_number` puts NULLs last,
 * which placed the oldest items at the END of round 1.
 *
 * ── Prices come from the EVENT ───────────────────────────────────────────────
 * `menu_items` is joined for the name only. Joining it for the price would let a
 * re-price rewrite history.
 */
export async function loadSubmittedRounds(sessionId: string): Promise<SubmittedRoundRow[]> {
  const roundOrder = sql<number>`coalesce(${orderEvents.roundNumber}, 1)`

  const rows = await db
    .select({
      id: orderEvents.id,
      roundNumber: roundOrder,
      quantity: orderEvents.quantity,
      unitPricePaisa: orderEvents.unitPricePaisa,
      modifierText: orderEvents.modifierText,
      createdAt: orderEvents.createdAt,
      itemName: menuItems.name,
      seatLabel: seatSlots.seatLabel,
    })
    .from(orderEvents)
    // LEFT joins: a deleted dish or a seat removed after its round was sent must
    // not make history rows vanish. They are the record.
    .leftJoin(menuItems, eq(menuItems.id, orderEvents.menuItemId))
    .leftJoin(seatSlots, eq(seatSlots.id, orderEvents.seatSlotId))
    .where(
      and(
        eq(orderEvents.sessionId, sessionId),
        // Items only. Session-level audit rows share this table and belong to
        // no round.
        eq(orderEvents.eventType, 'ITEM_ADDED'),
      ),
    )
    .orderBy(asc(roundOrder), asc(orderEvents.createdAt), asc(orderEvents.id))

  const rounds: SubmittedRoundRow[] = []
  for (const row of rows) {
    // `coalesce` comes back from the driver as whatever pg makes of an int4 —
    // a number — but a numeric type would arrive as a string. Normalise once.
    const roundNumber = Number(row.roundNumber)
    let round = rounds.at(-1)
    if (!round || round.roundNumber !== roundNumber) {
      round = { roundNumber, items: [] }
      rounds.push(round)
    }
    round.items.push({
      id: row.id,
      name: row.itemName ?? MISSING_ITEM_NAME,
      quantity: row.quantity,
      unitPricePaisa: row.unitPricePaisa,
      modifierText: row.modifierText,
      seatLabel: row.seatLabel,
      submittedAt: row.createdAt.toISOString(),
    })
  }

  return rounds
}
