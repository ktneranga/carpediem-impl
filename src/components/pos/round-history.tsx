'use client'

import type { SubmittedRoundRow } from '@/types/orders'
import { clockTime, lkrFromPaisa, quantity as formatQuantity } from '@/lib/format'

/**
 * What has already gone to the kitchen, grouped by round (AC-6).
 *
 * ── Read-only, with no controls at all ───────────────────────────────────────
 * Not "disabled controls" — none. These rows live in `order_events`, which is
 * append-only by database trigger: they cannot be edited or removed, and a
 * Remove button that always failed would be the dead-control defect this
 * codebase has shipped twice. Correcting a submitted item is a new event and
 * Epic 7 owns that flow.
 *
 * ── "Round 2" is the vocabulary the whole system already speaks ──────────────
 * `ux:455` puts `Table 7 · Round 2` on the kitchen ticket and `ux:101` puts
 * "Item ordered at 7:42pm · Round 2" in front of a disputing customer. The same
 * word has to mean the same thing here, which is why `round_number` is a column
 * rather than a count of submissions inferred at render time.
 */
export function RoundHistory({
  rounds,
  showSeats = true,
}: {
  rounds: SubmittedRoundRow[]
  /** False outside the Tables zone, where every item is on Seat 1. */
  showSeats?: boolean
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
          (sum, item) => sum + (item.unitPricePaisa ?? 0) * item.quantity,
          0,
        )
        const hasUnpricedLine = round.items.some((item) => item.unitPricePaisa === null)
        const sentAt = round.items[0]?.submittedAt

        return (
          <div
            key={round.roundNumber}
            className="flex flex-col gap-sp-2 rounded-waiter border border-slate-200 bg-slate-100 p-sp-3"
          >
            <div className="flex items-baseline justify-between gap-sp-3">
              <h2 className="text-fs-14 font-bold text-slate-600">
                Round {round.roundNumber}
                {sentAt ? (
                  // The time is formatted in the RENDERING environment's
                  // timezone, and the server's need not be the tablet's. The
                  // client's value is the right one; the warning is suppressed
                  // for this text only, rather than letting a mismatch discard
                  // the server tree.
                  <span className="font-semibold text-slate-600" suppressHydrationWarning>
                    {' '}
                    · sent {clockTime(sentAt)}
                  </span>
                ) : null}
              </h2>
              <span className="text-fs-14 font-bold tabular-nums text-slate-600">
                {hasUnpricedLine ? 'at least ' : ''}
                {lkrFromPaisa(total)}
              </span>
            </div>

            {hasUnpricedLine ? (
              <p className="text-fs-12 font-semibold text-unavailable-ink">
                Some items in this round have no recorded price.
              </p>
            ) : null}

            <ul className="flex flex-col gap-sp-1">
              {round.items.map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-sp-3">
                  <span className="min-w-0 text-fs-14 text-slate-600">
                    {item.quantity > 1 ? `${formatQuantity(item.quantity)} ` : ''}
                    {item.name}
                    {showSeats && item.seatLabel ? ` · ${item.seatLabel}` : ''}
                    {/* `slate-600`, not `slate-400`: the note is what the kitchen
                        acted on, and 400 is 2.34:1 on this panel's slate-100. */}
                    {item.modifierText ? ` · ${item.modifierText}` : ''}
                  </span>
                  <span className="shrink-0 text-fs-14 tabular-nums text-slate-600">
                    {item.unitPricePaisa === null
                      ? 'no price'
                      : lkrFromPaisa(item.unitPricePaisa * item.quantity)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
