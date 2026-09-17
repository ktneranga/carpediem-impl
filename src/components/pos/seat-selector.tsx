'use client'

import { Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SeatSlot = {
  id: string
  seatLabel: string
  /** "red shirt", "curly hair" — shown here, never on a guest's bill. */
  seatNote: string | null
}

/**
 * Who the next tap is for (FR10).
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * An equal-width grid of seat buttons, as many across as the column fits, with
 * "+ Seat" as the last cell. Equal widths because a row of ragged, content-
 * sized buttons reads as a list of words; a grid reads as places at a table.
 * `rounded-waiter` — the system's radius for waiter buttons.
 *
 * ── The count is the point ───────────────────────────────────────────────────
 * "Seat 5 · 4 items" / "Seat 6 · empty" answers the question a waiter has
 * halfway through a table of eight: who have I not taken anything from yet.
 *
 * ── Editing: the pencil badge on the selected seat ───────────────────────────
 * Only the SELECTED seat carries it, on its top-right corner, so a waiter picks
 * the person first and then edits them. The badge sits inside the grid cell's
 * own box (a `relative` wrapper), so it overhangs the corner without pushing
 * the grid out of line. It only opens the note panel — removing a seat is a
 * further, confirmed step inside it, so a stray tap never destroys anything.
 * (Briefly replaced by "tap the selected seat again" on 2026-09-16; Teran asked
 * for the visible badge back, and a visible control is the better affordance.)
 *
 * ── A note replaces the number, and both stay in the accessible name ─────────
 * A waiter cannot ask strangers their names, so they write what they see. The
 * button shows the note when there is one; the label stays in the accessible
 * name either way.
 */
export function SeatSelector({
  seats,
  activeSeatId,
  stagedCountBySeat,
  editingSeatId = null,
  adding = false,
  onSelect,
  onEditSeat,
  onAddSeat,
}: {
  seats: SeatSlot[]
  activeSeatId: string | null
  /** Staged dishes per seat id. Absent means none. */
  stagedCountBySeat: Map<string, number>
  /** The seat whose note panel is open, so its button can say so. */
  editingSeatId?: string | null
  /** The ADD is in flight — not "some seat mutation is in flight". */
  adding?: boolean
  onSelect: (seatId: string) => void
  /** Toggles the note-and-remove panel. Drawn as a pencil on the selected seat. */
  onEditSeat?: (seatId: string) => void
  onAddSeat?: () => void
}) {
  const cell = cn(
    'flex h-18 min-w-0 flex-col items-center justify-center gap-sp-1 rounded-waiter px-sp-2',
    'transition-[transform,box-shadow] duration-120 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  return (
    <div className="flex flex-col gap-sp-2">
      <p className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
        Seat — items land on the selected seat
      </p>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-sp-2">
        <div role="group" aria-label="Seats on this order" className="contents">
          {seats.map((seat) => {
            const isActive = seat.id === activeSeatId
            const isEditing = seat.id === editingSeatId
            const count = stagedCountBySeat.get(seat.id) ?? 0
            // The note is what the waiter recognises; the number is the fallback.
            const shown = seat.seatNote ?? seat.seatLabel
            const name = seat.seatNote ? `${seat.seatLabel}, ${seat.seatNote}` : seat.seatLabel

            return (
              <div key={seat.id} className="relative min-w-0">
                <button
                  type="button"
                  aria-pressed={isActive}
                  aria-label={name}
                  onClick={() => onSelect(seat.id)}
                  className={cn(
                    cell,
                    'w-full',
                    // `brand-700` text, never `brand-500`: white-on-500 and
                    // 500-on-white are both below AA at these sizes.
                    isActive
                      ? 'border-2 border-brand-500 bg-brand-050 shadow-el-1'
                      : 'border border-slate-200 bg-white shadow-el-1',
                  )}
                >
                  <span
                    className={cn(
                      'max-w-full truncate text-fs-18 font-bold',
                      isActive ? 'text-brand-700' : 'text-slate-600',
                    )}
                  >
                    {shown}
                  </span>
                  <span
                    className={cn(
                      'text-fs-12 font-semibold',
                      // slate-600, not slate-400 (2.56:1): "empty" is the
                      // answer to "who haven't I served yet".
                      isActive ? 'text-brand-700' : 'text-slate-600',
                    )}
                  >
                    {count === 0 ? 'empty' : `${count} item${count === 1 ? '' : 's'}`}
                  </span>
                </button>

                {onEditSeat && isActive ? (
                  <button
                    type="button"
                    onClick={() => onEditSeat(seat.id)}
                    aria-expanded={isEditing}
                    aria-label={`${isEditing ? 'Close the note for' : 'Edit'} ${seat.seatLabel}`}
                    className={cn(
                      'absolute -top-sp-2 -right-sp-2 flex size-8 items-center justify-center rounded-pill',
                      'border shadow-el-1',
                      'transition-transform duration-80 ease-standard active:scale-[0.92]',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      // Filled while its panel is open, so the badge shows which
                      // seat the note editor below belongs to.
                      isEditing
                        ? 'border-brand-700 bg-brand-700 text-white'
                        : 'border-slate-200 bg-white text-brand-700',
                    )}
                  >
                    <Pencil aria-hidden="true" strokeWidth={2.5} className="size-4" />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>

        {onAddSeat ? (
          <button
            type="button"
            disabled={adding}
            onClick={onAddSeat}
            className={cn(
              cell,
              'border border-dashed border-slate-400 bg-white text-fs-16 font-semibold text-slate-600',
              'disabled:opacity-40 disabled:active:scale-100',
            )}
          >
            {adding ? 'Adding…' : '+ Seat'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
