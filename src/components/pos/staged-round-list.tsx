'use client'

import { AlertTriangle, Minus, Plus, Trash2 } from 'lucide-react'
import type { SeatSlot } from '@/components/pos/seat-selector'
import type { StagedLine } from '@/components/pos/use-staged-round'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Why a staged line cannot be submitted, or null when it can.
 *
 * Computed by the caller on every render from the LIVE seat and menu queries —
 * not stored on the line when it was staged. The whole point is to notice a
 * change that happens afterwards: a seat removed on the other tablet, an item
 * 86'd by the owner while the round was being built.
 */
export type StagedLineProblem =
  | { kind: 'seat-gone' }
  | { kind: 'item-unavailable' }

/**
 * The round the waiter is building, before anybody submits it (FR11).
 *
 * ── Every line says NOT SENT ─────────────────────────────────────────────────
 * The single most expensive misunderstanding on this screen is believing the
 * kitchen has something it does not. So the state is on each line, in the
 * unsent tint, rather than inferred from which part of the column a line is in.
 * The bottom bar repeats it, because that is where the eye goes before the tap
 * that would send it.
 *
 * ── Nothing here has been written anywhere ───────────────────────────────────
 * Staged items produce no database writes. Remove is free, instant and local;
 * the quantity stepper is too. Story 4.5's submit is the commit point.
 */
export function StagedRoundList({
  lines,
  seats,
  problems,
  onRemove,
  onSetQuantity,
  onReassign,
}: {
  lines: StagedLine[]
  /** The LIVE seats, in selector order. */
  seats: SeatSlot[]
  /** Keyed by `lineId`. Absent means the line is fine. */
  problems: Map<string, StagedLineProblem>
  onRemove: (lineId: string) => void
  onSetQuantity: (lineId: string, quantity: number) => void
  onReassign: (lineId: string, seatSlotId: string) => void
}) {
  if (lines.length === 0) {
    return (
      <p className="rounded-waiter border border-dashed border-slate-200 p-sp-4 text-center text-fs-14 text-slate-600">
        Tap a dish to start the round.
      </p>
    )
  }

  // Seat order first, then anything whose seat is gone — those need attention
  // and should not be buried between two healthy groups.
  const seatLabelFor = new Map(seats.map((seat) => [seat.id, seat.seatNote ?? seat.seatLabel]))

  const ordered = [
    ...seats.flatMap((seat) => lines.filter((line) => line.seatSlotId === seat.id)),
    ...lines.filter((line) => !seatLabelFor.has(line.seatSlotId)),
  ]

  return (
    <ul aria-label="Items not yet sent" className="flex flex-col gap-sp-2">
      {ordered.map((line) => {
        const problem = problems.get(line.lineId) ?? null
        const seatLabel = seatLabelFor.get(line.seatSlotId) ?? 'Seat removed'

        return (
          <li
            key={line.lineId}
            className={cn(
              'flex flex-col gap-sp-2 rounded-waiter border p-sp-3',
              problem
                ? 'border-2 border-unavailable-edge bg-unavailable-body'
                : 'border-unsent-edge bg-unsent-body',
            )}
          >
            <div className="flex items-baseline gap-sp-2">
              <span className="text-fs-12 font-bold tracking-micro text-unsent-ink uppercase">
                Not sent
              </span>
              <span className="truncate text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
                {seatLabel}
              </span>
            </div>

            <div className="flex items-start justify-between gap-sp-3">
              <div className="flex min-w-0 flex-col gap-sp-1">
                <p className="text-fs-16 font-bold text-slate-900">{line.name}</p>
                {/* The modifier sits with the item: the kitchen gets it, so the
                    waiter has to be able to check it before it goes. */}
                {line.modifierText ? (
                  <p className="text-fs-14 text-slate-600">{line.modifierText}</p>
                ) : null}
                <p className="text-fs-14 font-semibold tabular-nums text-slate-600">
                  {lkrFromPaisa(line.pricePaisa * line.quantity)}
                </p>
              </div>

              {/* The stepper lives on the LINE, not only in the sheet. "One
                  more of those" is the commonest correction at a table and it
                  should not cost a trip back to the menu. */}
              <div className="flex shrink-0 items-center gap-sp-1 rounded-control border border-slate-200 bg-white p-sp-1">
                <button
                  type="button"
                  onClick={() =>
                    // At 1, one more tap means "I did not want this" — so the
                    // minus removes the line rather than refusing. Nothing is
                    // written yet, so nothing is lost by being wrong.
                    line.quantity <= 1
                      ? onRemove(line.lineId)
                      : onSetQuantity(line.lineId, line.quantity - 1)
                  }
                  aria-label={
                    line.quantity <= 1 ? `Remove ${line.name}` : `One fewer ${line.name}`
                  }
                  className={cn(
                    'flex size-11 items-center justify-center rounded-control text-slate-900',
                    'transition-transform duration-80 ease-standard active:scale-[0.92]',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
                  )}
                >
                  {line.quantity <= 1 ? (
                    <Trash2 aria-hidden="true" strokeWidth={2} className="size-5" />
                  ) : (
                    <Minus aria-hidden="true" strokeWidth={2.5} className="size-5" />
                  )}
                </button>

                <output className="min-w-6 text-center text-fs-16 font-bold tabular-nums text-slate-900">
                  {line.quantity}
                </output>

                <button
                  type="button"
                  onClick={() => onSetQuantity(line.lineId, line.quantity + 1)}
                  aria-label={`One more ${line.name}`}
                  className={cn(
                    'flex size-11 items-center justify-center rounded-control text-slate-900',
                    'transition-transform duration-80 ease-standard active:scale-[0.92]',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
                  )}
                >
                  <Plus aria-hidden="true" strokeWidth={2.5} className="size-5" />
                </button>
              </div>
            </div>

            {problem ? (
              <div className="flex flex-col gap-sp-2">
                <p className="flex items-start gap-sp-2 text-fs-14 font-bold text-unavailable-ink">
                  <AlertTriangle aria-hidden="true" strokeWidth={2} className="mt-0.5 size-5 shrink-0" />
                  {problem.kind === 'seat-gone'
                    ? 'That seat was removed. Move this to someone else, or take it off.'
                    : `${line.name} is no longer available. Take it off to send the round.`}
                </p>

                {/* The repair, in place. A blocked submission with no way to fix
                    it from the same screen is a dead end mid-service. */}
                {problem.kind === 'seat-gone' && seats.length > 0 ? (
                  <div className="flex flex-wrap gap-sp-2">
                    {seats.map((seat) => (
                      <button
                        key={seat.id}
                        type="button"
                        onClick={() => onReassign(line.lineId, seat.id)}
                        className={cn(
                          'h-12 rounded-control border border-slate-200 bg-white px-sp-3',
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
  )
}
