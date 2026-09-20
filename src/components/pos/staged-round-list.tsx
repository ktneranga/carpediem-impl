'use client'

import { AlertTriangle, Minus, Plus, Trash2 } from 'lucide-react'
import type { SeatSlot } from '@/components/pos/seat-selector'
import type { StagedLine } from '@/components/pos/use-staged-round'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Why a staged line cannot be sent, or absent when it can.
 *
 * Computed by the caller on every render from the LIVE seat and menu queries —
 * not stored on the line when it was staged. The point is to notice a change
 * that happens afterwards: a seat removed on the other tablet, a dish 86'd or
 * deleted by the owner while the round was being built.
 */
export type StagedLineProblem =
  | { kind: 'seat-gone' }
  | { kind: 'item-unavailable' }
  | { kind: 'item-gone' }
  /** The menu price moved after the dish was staged (Story 4.5, AC-9). */
  | { kind: 'price-changed'; currentPricePaisa: number }

/**
 * The round the waiter is building, before anybody sends it (FR11).
 *
 * ── Compact rows ─────────────────────────────────────────────────────────────
 * Teran, 2026-09-16: the first cards were about 110px each, so a round of more
 * than three or four dishes scrolled and could not be checked at a glance.
 * Each line is now two lines of text and a stepper, about 60px:
 *
 *     Devilled Cashew                 [🗑 1 +]
 *     SEAT 1 · no chilli · LKR 950
 *
 * "NOT SENT" moved from every card to ONE heading over the list. The amber
 * unsent tint stays on every row, so the state is still on each line — the
 * word is simply not repeated six times.
 *
 * The stepper uses the `touch-standard` token (44px), not the 56px
 * `touch-kitchen` floor the rest of the screen uses. That is a deliberate
 * trade for density, asked for; 44px is the WCAG target size and the system's
 * own token for it.
 *
 * ── Ordered by seat ──────────────────────────────────────────────────────────
 * A flat list, ordered by seat, each row naming its seat — Teran's design. The
 * seat cards above carry the per-seat counts a heading would have.
 *
 * ── Nothing here has been written anywhere ───────────────────────────────────
 * Remove and the stepper are free, instant and local. Story 4.5's send is the
 * commit point.
 */
export function StagedRoundList({
  showSeats = true,
  lines,
  seats,
  problems,
  onRemove,
  onSetQuantity,
  onReassign,
  onAcceptPrice,
}: {
  /** False outside the Tables zone: every line is on Seat 1, so naming it is noise. */
  showSeats?: boolean
  lines: StagedLine[]
  /** The LIVE seats, in selector order. */
  seats: SeatSlot[]
  /** Keyed by `lineId`. Absent means the line is fine. */
  problems: Map<string, StagedLineProblem>
  onRemove: (lineId: string) => void
  onSetQuantity: (lineId: string, quantity: number) => void
  onReassign: (lineId: string, seat: SeatSlot) => void
  /** Takes the new menu price onto every line of that dish. */
  onAcceptPrice: (menuItemId: string, pricePaisa: number) => void
}) {
  if (lines.length === 0) {
    return (
      <p className="rounded-waiter border border-dashed border-slate-200 p-sp-4 text-center text-fs-14 text-slate-600">
        Tap a dish to start the round.
      </p>
    )
  }

  const liveSeatName = new Map(seats.map((seat) => [seat.id, seat.seatNote ?? seat.seatLabel]))

  // Seat order first, then anything whose seat is gone — those need attention
  // and should not be buried between two healthy lines.
  const ordered = [
    ...seats.flatMap((seat) => lines.filter((line) => line.seatSlotId === seat.id)),
    ...lines.filter((line) => !liveSeatName.has(line.seatSlotId)),
  ]

  const dishCount = lines.reduce((total, line) => total + line.quantity, 0)

  const stepperButton = cn(
    'flex size-touch-standard items-center justify-center rounded-control text-slate-900',
    'transition-transform duration-80 ease-standard active:scale-[0.92]',
    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
  )

  return (
    <section aria-label="Items not yet sent" className="flex flex-col gap-sp-2">
      <h2 className="text-fs-12 font-bold tracking-micro text-unsent-ink uppercase">
        Not sent · {dishCount} item{dishCount === 1 ? '' : 's'}
      </h2>

      <ul className="flex flex-col gap-sp-1">
        {ordered.map((line) => {
          const problem = problems.get(line.lineId) ?? null
          // The live name when the seat still exists (its note may have
          // changed); otherwise the name it had when the dish was staged, so a
          // vanished seat is still identified.
          const seatName =
            liveSeatName.get(line.seatSlotId) ?? (line.seatLabel || 'A removed seat')

          const details = [
            showSeats ? seatName : null,
            line.modifierText || null,
            lkrFromPaisa(line.pricePaisa * line.quantity),
          ].filter(Boolean)

          return (
            <li
              key={line.lineId}
              className={cn(
                'flex flex-col gap-sp-2 rounded-control border px-sp-3 py-sp-2',
                problem
                  ? 'border-2 border-unavailable-edge bg-unavailable-body'
                  : 'border-unsent-edge bg-unsent-body',
              )}
            >
              <div className="flex items-center gap-sp-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <p className="truncate text-fs-16 font-bold text-slate-900">{line.name}</p>
                  {/* Seat, the kitchen note and the line total on one small
                      line. The note is here so it can be checked before it
                      goes; it wraps rather than truncates, because a clipped
                      "no nuts — sev…" is worse than a taller row. */}
                  <p className="text-fs-12 font-semibold text-slate-600">
                    {details.map((detail, index) => (
                      <span key={index}>
                        {index > 0 ? ' · ' : ''}
                        <span className={index === 0 && showSeats ? 'uppercase tracking-micro' : undefined}>
                          {detail}
                        </span>
                      </span>
                    ))}
                  </p>
                </div>

                <div className="flex shrink-0 items-center rounded-control border border-slate-200 bg-white">
                  <button
                    type="button"
                    onClick={() =>
                      // At 1, the minus removes the line. Nothing is written yet.
                      line.quantity <= 1
                        ? onRemove(line.lineId)
                        : onSetQuantity(line.lineId, line.quantity - 1)
                    }
                    aria-label={
                      line.quantity <= 1 ? `Remove ${line.name}` : `One fewer ${line.name}`
                    }
                    className={stepperButton}
                  >
                    {line.quantity <= 1 ? (
                      <Trash2 aria-hidden="true" strokeWidth={2} className="size-4" />
                    ) : (
                      <Minus aria-hidden="true" strokeWidth={2.5} className="size-4" />
                    )}
                  </button>

                  <output
                    aria-label={`Quantity of ${line.name}`}
                    className="min-w-5 text-center text-fs-16 font-bold tabular-nums text-slate-900"
                  >
                    {line.quantity}
                  </output>

                  <button
                    type="button"
                    onClick={() => onSetQuantity(line.lineId, line.quantity + 1)}
                    aria-label={`One more ${line.name}`}
                    className={stepperButton}
                  >
                    <Plus aria-hidden="true" strokeWidth={2.5} className="size-4" />
                  </button>
                </div>
              </div>

              {problem ? (
                <div className="flex flex-col gap-sp-2">
                  <p className="flex items-start gap-sp-2 text-fs-14 font-bold text-unavailable-ink">
                    <AlertTriangle aria-hidden="true" strokeWidth={2} className="mt-0.5 size-4 shrink-0" />
                    {problem.kind === 'seat-gone'
                      ? // AC-7: names the seat that vanished, from the label
                        // captured when the dish was staged.
                        `${line.seatLabel || 'This seat'} was removed. Move this to someone else, or take it off.`
                      : problem.kind === 'item-gone'
                        ? `${line.name} is no longer on the menu. Take it off to send the round.`
                        : problem.kind === 'price-changed'
                          ? `${line.name} now costs ${lkrFromPaisa(problem.currentPricePaisa)} each (was ${lkrFromPaisa(line.pricePaisa)}). Confirm with the guest before sending.`
                          : `${line.name} is no longer available. Take it off to send the round.`}
                  </p>

                  {/* The repair, in place — a blocked round with no way to fix
                      it from the same screen is a dead end mid-service. These
                      keep the 56px floor: they are the only way out. */}
                  {/* The waiter accepts the new price explicitly — the server
                      never charges a price the waiter did not see. */}
                  {problem.kind === 'price-changed' ? (
                    <button
                      type="button"
                      onClick={() => onAcceptPrice(line.menuItemId, problem.currentPricePaisa)}
                      className={cn(
                        'h-touch-kitchen self-start rounded-control bg-brand-700 px-sp-4',
                        'text-fs-14 font-bold whitespace-nowrap text-white',
                        'transition-transform duration-80 ease-standard active:scale-[0.97]',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      Accept {lkrFromPaisa(problem.currentPricePaisa)}
                    </button>
                  ) : null}

                  {problem.kind === 'seat-gone' && seats.length > 0 ? (
                    <div className="flex flex-wrap gap-sp-2">
                      {seats.map((seat) => (
                        <button
                          key={seat.id}
                          type="button"
                          onClick={() => onReassign(line.lineId, seat)}
                          className={cn(
                            'h-touch-kitchen rounded-control border border-slate-200 bg-white px-sp-3',
                            'text-fs-14 font-semibold whitespace-nowrap text-slate-900',
                            'transition-transform duration-80 ease-standard active:scale-[0.97]',
                            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                          )}
                        >
                          Move to {seat.seatNote ?? seat.seatLabel}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
