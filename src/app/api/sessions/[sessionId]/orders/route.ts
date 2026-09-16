import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { menuItems, orderEvents, seatSlots } from '@/server/db/schema'

const sessionIdSchema = z.string().uuid()

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

/** One round of this session's ordering, oldest first. */
export type SubmittedRoundRow = {
  roundNumber: number
  items: SubmittedItemRow[]
}

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * The session's already-submitted items, grouped by round (Story 4.4, AC-6).
 *
 * ── Read-only, and that is the whole point ───────────────────────────────────
 * These rows are in `order_events`, which is APPEND-ONLY — migration 0001's
 * trigger refuses UPDATE and DELETE. There is no PATCH and no DELETE on this
 * path and there never will be: correcting a submitted item is a new event, and
 * Epic 7 owns that flow.
 *
 * ── Prices come from the EVENT, not from the menu ────────────────────────────
 * `unit_price_paisa` is what the guest was quoted when the item was ordered.
 * Joining to `menu_items` for the price would make a mid-service re-price
 * rewrite history — the bill would show today's price for last hour's order,
 * and the audit row would agree with it. The join to `menu_items` here is for
 * the NAME only, and even that is a fallback the item row can outlive.
 *
 * ── POST is Story 4.5 ────────────────────────────────────────────────────────
 * `epics.md:1395` puts submission on this exact path. It is deliberately absent
 * here: Story 4.4 stages on the client and writes nothing.
 *
 * RBAC is inherited from `{ prefix: '/api/sessions', roles: ['owner','waiter'] }`
 * (Story 3.9). Verified as Kumar (4321, kitchen), not assumed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId: rawSessionId } = await params

  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId)
  if (!parsedSessionId.success) {
    return fail('INVALID_SESSION_ID', 'Session id must be a UUID', 400)
  }

  // Every other handler in this namespace checks this. The proxy refuses an
  // unauthenticated request first, so it is defence in depth — but one handler
  // quietly missing the check reads as either a bug or proof it is decorative,
  // and prefix RBAC here defaults to ALLOW on an unmatched prefix.
  if (!request.headers.get('x-staff-id')) {
    return fail('UNAUTHENTICATED', 'Sign in required', 401)
  }

  try {
    const rows = await db
      .select({
        id: orderEvents.id,
        roundNumber: orderEvents.roundNumber,
        quantity: orderEvents.quantity,
        unitPricePaisa: orderEvents.unitPricePaisa,
        modifierText: orderEvents.modifierText,
        createdAt: orderEvents.createdAt,
        itemName: menuItems.name,
        seatLabel: seatSlots.seatLabel,
      })
      .from(orderEvents)
      // LEFT, both of them. A menu item deleted after it was ordered, or a seat
      // removed after the round was submitted, must not make the history vanish
      // — these rows are the audit record and an INNER join would hide them.
      .leftJoin(menuItems, eq(menuItems.id, orderEvents.menuItemId))
      .leftJoin(seatSlots, eq(seatSlots.id, orderEvents.seatSlotId))
      .where(
        and(
          eq(orderEvents.sessionId, parsedSessionId.data),
          // Items only. Session-level audit rows — SESSION_OPENED, TABLE_MERGED
          // — share this table and belong to no round.
          eq(orderEvents.eventType, 'ITEM_ADDED'),
        ),
      )
      .orderBy(asc(orderEvents.roundNumber), asc(orderEvents.createdAt), asc(orderEvents.id))

    // Grouped in code rather than by SQL: the shape the client wants is nested,
    // and the row count here is one sitting's items — tens, not thousands.
    const rounds: SubmittedRoundRow[] = []

    for (const row of rows) {
      // Defensive. Nothing writes ITEM_ADDED without a round after Story 4.5,
      // but the 14 rows that predate migration 0014 have none, and one of them
      // was hand-inserted during 4.3's verification. Bucket them as round 1
      // rather than dropping items a guest may be about to be billed for.
      const roundNumber = row.roundNumber ?? 1

      let round = rounds.find((candidate) => candidate.roundNumber === roundNumber)
      if (!round) {
        round = { roundNumber, items: [] }
        rounds.push(round)
      }

      round.items.push({
        id: row.id,
        name: row.itemName ?? 'Item no longer on the menu',
        quantity: row.quantity,
        unitPricePaisa: row.unitPricePaisa,
        modifierText: row.modifierText,
        seatLabel: row.seatLabel,
        submittedAt: row.createdAt.toISOString(),
      })
    }

    rounds.sort((a, b) => a.roundNumber - b.roundNumber)

    return NextResponse.json({ success: true, data: rounds })
  } catch (error) {
    console.error('[api/sessions/:sessionId/orders] Failed to load rounds:', error)
    return fail('INTERNAL_ERROR', 'Could not load the order history', 500)
  }
}
