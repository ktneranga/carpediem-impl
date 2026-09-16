'use client'

import type { SubmittedRoundRow } from '@/app/api/sessions/[sessionId]/orders/route'
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
export function RoundHistory({ rounds }: { rounds: SubmittedRoundRow[] }) {
  if (rounds.length === 0) return null

  return (
    <section aria-label="Already sent" className="flex flex-col gap-sp-3">
      {rounds.map((round) => {
        // A null `unit_price_paisa` means the row predates Story 4.5 writing
        // it. Such a line contributes nothing to the sum, which makes the total
        // a LOWER BOUND rather than the round's real value — so it is marked as
        // one rather than presented as a figure a waiter could read out to a
        // guest. (The first version of this comment said counting nulls as zero
        // would understate the total, and then counted them as zero.)
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
                  <span className="font-semibold text-slate-600"> · sent {clockTime(sentAt)}</span>
                ) : null}
              </h2>
              <span className="text-fs-14 font-bold tabular-nums text-slate-600">
                {lkrFromPaisa(total)}
                {hasUnpricedLine ? (
                  <span
                    title="One or more items on this round have no recorded price"
                    className="font-semibold text-unavailable-ink"
                  >
                    {' '}+
                  </span>
                ) : null}
              </span>
            </div>

            <ul className="flex flex-col gap-sp-1">
              {round.items.map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-sp-3">
                  <span className="min-w-0 text-fs-14 text-slate-600">
                    {item.quantity > 1 ? `${formatQuantity(item.quantity)} ` : ''}
                    {item.name}
                    {item.seatLabel ? ` · ${item.seatLabel}` : ''}
                    {item.modifierText ? (
                      <span className="text-slate-400"> · {item.modifierText}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-fs-14 tabular-nums text-slate-600">
                    {item.unitPricePaisa === null
                      ? '—'
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
