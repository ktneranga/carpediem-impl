'use client'

import { Ban } from 'lucide-react'
import type { SubmittedItemRow, SubmittedRoundRow } from '@/types/orders'
import { clockTime, lkrFromPaisa, quantity as formatQuantity } from '@/lib/format'

/**
 * What has already gone to the kitchen, grouped by round (AC-6).
 *
 * ── One control: Void (Story 7.5) ────────────────────────────────────────────
 * These rows live in `order_events`, which is append-only by database trigger:
 * they cannot be edited or removed. A wrong item is corrected by a NEW event,
 * a void, from the small icon beside a line that still has units neither
 * billed nor voided. A rare action, so a small icon by the line it changes,
 * never a button in the action strip. No icon where nothing can be voided:
 * a control that always fails is the dead-control defect this codebase has
 * shipped twice. Prices and totals here count the units still ordered.
 *
 * ── "Round 2" is the vocabulary the whole system already speaks ──────────────
 * `ux:455` puts `Table 7 · Round 2` on the kitchen ticket and `ux:101` puts
 * "Item ordered at 7:42pm · Round 2" in front of a disputing customer. The same
 * word has to mean the same thing here, which is why `round_number` is a column
 * rather than a count of submissions inferred at render time.
 */
/** Units of a sent line still ordered (Story 7.5): sent minus voided. */
const liveQuantity = (item: SubmittedItemRow) => item.quantity - item.voidedQuantity

/** Units that can still be voided: neither billed nor voided. */
export const voidableUnits = (item: SubmittedItemRow) => item.quantity - item.voidedQuantity - item.billedQuantity

export function RoundHistory({
  rounds,
  showSeats = true,
  onVoid,
}: {
  rounds: SubmittedRoundRow[]
  /** False outside the Tables zone, where every item is on Seat 1. */
  showSeats?: boolean
  /** Opens the void sheet for a line (Story 7.5). Absent: no Void icons. */
  onVoid?: (item: SubmittedItemRow) => void
}) {
  if (rounds.length === 0) return null

  return (
    <section aria-label="Already sent" className="flex flex-col gap-sp-3">
      {rounds.map((round) => {
        // A null `unit_price_paisa` means the row predates Story 4.5 writing
        // it. Such a line contributes nothing to the sum, which makes the total
        // a LOWER BOUND — so it is marked as one, in words a screen reader and a
        // touch screen can both reach, rather than presented as a figure a
        // waiter could read out to a guest.
        const total = round.items.reduce(
          (sum, item) => sum + (item.unitPricePaisa ?? 0) * liveQuantity(item),
          0,
        )
        const hasUnpricedLine = round.items.some((item) => item.unitPricePaisa === null)
        const sentAt = round.items[0]?.submittedAt

        return (
          <div
            key={round.roundNumber}
            className="flex flex-col gap-sp-2 rounded-waiter border border-slate-200 bg-slate-100 p-sp-3 night:border-night-hairline night:bg-night-raised"
          >
            <div className="flex items-baseline justify-between gap-sp-3">
              <h2 className="text-fs-14 font-bold text-slate-600 night:text-night-second">
                {/* A custom charge is saved on its own, straight to the bill
                    (Teran, 2026-11-02) — it was never "sent", so it does not
                    read as a round of food. */}
                {round.items.every((item) => item.custom) ? 'Custom charge' : `Round ${round.roundNumber}`}
                {sentAt ? (
                  // The time is formatted in the RENDERING environment's
                  // timezone, and the server's need not be the tablet's. The
                  // client's value is the right one; the warning is suppressed
                  // for this text only, rather than letting a mismatch discard
                  // the server tree.
                  <span className="font-semibold text-slate-600 night:text-night-second" suppressHydrationWarning>
                    {' '}
                    · {round.items.every((item) => item.custom) ? 'added' : 'sent'} {clockTime(sentAt)}
                  </span>
                ) : null}
              </h2>
              <span className="text-fs-14 font-bold tabular-nums text-slate-600 night:text-night-second">
                {hasUnpricedLine ? 'at least ' : ''}
                {lkrFromPaisa(total)}
              </span>
            </div>

            {hasUnpricedLine ? (
              <p className="text-fs-12 font-semibold text-unavailable-ink night:text-red-300">
                Some items in this round have no recorded price.
              </p>
            ) : null}

            <ul className="flex flex-col gap-sp-1">
              {round.items.map((item) => {
                const live = liveQuantity(item)
                return (
                <li key={item.id} className="flex items-center justify-between gap-sp-3">
                  <span
                    className={
                      live === 0
                        ? 'min-w-0 text-fs-14 text-slate-500 line-through night:text-night-muted'
                        : 'min-w-0 text-fs-14 text-slate-600 night:text-night-second'
                    }
                  >
                    {live > 1 ? `${formatQuantity(live)} ` : live === 0 && item.quantity > 1 ? `${formatQuantity(item.quantity)} ` : ''}
                    {item.name}
                    {showSeats && item.seatLabel ? ` · ${item.seatLabel}` : ''}
                    {/* The options it went out with (Story 4.8), before the note. */}
                    {item.optionText ? ` · ${item.optionText}` : ''}
                    {/* `slate-600`, not `slate-400`: the note is what the kitchen
                        acted on, and 400 is 2.34:1 on this panel's slate-100. */}
                    {item.modifierText ? ` · ${item.modifierText}` : ''}
                    {item.voidedQuantity > 0 ? (
                      <span className="font-semibold text-unavailable-ink no-underline night:text-red-300">
                        {' '}
                        · {item.voidedQuantity === item.quantity ? 'voided' : `${formatQuantity(item.voidedQuantity)} voided`}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-sp-1">
                    <span className="text-fs-14 tabular-nums text-slate-600 night:text-night-second">
                      {item.unitPricePaisa === null
                        ? 'no price'
                        : lkrFromPaisa(item.unitPricePaisa * live)}
                    </span>
                    {onVoid && voidableUnits(item) > 0 ? (
                      <button
                        type="button"
                        onClick={() => onVoid(item)}
                        aria-label={`Void ${item.name}`}
                        title="Void"
                        className="relative -my-1 inline-flex size-6 items-center justify-center rounded-control after:absolute after:-inset-2.5 after:content-[''] text-slate-500 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 night:text-night-muted night:hover:bg-night-card"
                      >
                        <Ban aria-hidden="true" className="size-4" />
                      </button>
                    ) : null}
                  </span>
                </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
