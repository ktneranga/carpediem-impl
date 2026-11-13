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
 * ── ONE SCROLLING ROW, not a grid (Teran, 2026-10-21) ────────────────────────
 * This was an equal-width grid of 72px two-line cards that wrapped. In the
 * separate-bills sidebar it came to 214px — as much as the order list it sits
 * above — and with four seats, three of its cards read "empty". Maximum space
 * for the least information, directly above the thing a waiter manages most.
 *
 * It is now a single 56px row that scrolls sideways, the same shape as the
 * floor's zone tabs and the menu's category chips. Roughly 150px goes back to
 * the order list.
 *
 * ── What the compact chip gave up, and what replaced it ──────────────────────
 * The second line is gone, so "empty" is no longer written on every untouched
 * seat. The count is a badge instead, and a seat with no badge is an empty
 * one: across a row of chips that is FASTER to scan for "who have I not taken
 * anything from yet" than reading the word four times. The word survives in
 * the accessible name, so a screen reader still hears "Seat 2, empty".
 *
 * ── Editing: the pencil follows the selected chip ────────────────────────────
 * It used to overhang the selected card's corner. At 56px in a scrolling row a
 * badge that overhangs would collide with the label above, so it is its own
 * button sitting immediately after the chip it edits — adjacent, which reads
 * as "this one", without nesting a button inside a button.
 *
 * It only opens the note panel. Removing a seat is a further, confirmed step
 * inside it, so a stray tap never destroys anything.
 *
 * ── A note replaces the number, and both stay in the accessible name ─────────
 * A waiter cannot ask strangers their names, so they write what they see. The
 * chip shows the note when there is one; the label stays in the accessible
 * name either way.
 */
export function SeatSelector({
  seats,
  activeSeatId,
  stagedCountBySeat,
  editingSeatId = null,
  adding = false,
  billedSeatIds,
  onSelect,
  onEditSeat,
  onAddSeat,
}: {
  seats: SeatSlot[]
  activeSeatId: string | null
  /**
   * Seats that already have a bill of their own (Story 6.4).
   *
   * A billed seat has paid and, usually, left. It is shown struck through and
   * greyed rather than removed, because the waiter needs to see that Seat 2
   * WAS here and is settled — a seat that simply vanished reads as a mistake.
   * It stays selectable: its items are still worth looking at.
   */
  billedSeatIds?: Set<string>
  /** Staged dishes per seat id. Absent means none. */
  stagedCountBySeat: Map<string, number>
  /** The seat whose note panel is open, so its chip can say so. */
  editingSeatId?: string | null
  /** The ADD is in flight — not "some seat mutation is in flight". */
  adding?: boolean
  onSelect: (seatId: string) => void
  /** Toggles the note-and-remove panel. Drawn as a pencil beside the selection. */
  onEditSeat?: (seatId: string) => void
  onAddSeat?: () => void
}) {
  const chip = cn(
    'flex h-14 shrink-0 items-center gap-sp-2 rounded-control border px-sp-4',
    'transition-[transform,background-color] duration-120 ease-standard',
    'active:scale-[0.97]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  return (
    // ── No caption above the row (Teran, 2026-10-21) ─────────────────────────
    // It read "ITEMS LAND ON THE SELECTED SEAT" and cost a line of the order
    // column on every render, to explain a rule a waiter learns on the first
    // table and never needs told again. The filled chip carries it now: one
    // seat is lit and the rest are not, which is the whole statement.
    //
    // `aria-label` on the group keeps it for a screen reader, where there is
    // no "lit" to see and the sighted shorthand does not exist.
    //
    // no-scrollbar: overflowing seats stay reachable by swipe without a
    // scrollbar eating vertical space on a tablet — the same treatment the
    // zone bar and the category chips use.
    <div
      role="group"
      aria-label="Seats on this order — items land on the selected one"
      className="no-scrollbar flex gap-sp-2 overflow-x-auto py-sp-1"
    >
      {seats.map((seat) => {
        const isActive = seat.id === activeSeatId
        const isEditing = seat.id === editingSeatId
        const count = stagedCountBySeat.get(seat.id) ?? 0
        const isBilled = billedSeatIds?.has(seat.id) ?? false
        // The note is what the waiter recognises; the number is the fallback.
        const shown = seat.seatNote ?? seat.seatLabel
        const spoken = seat.seatNote ? `${seat.seatLabel}, ${seat.seatNote}` : seat.seatLabel
        // Everything the chip now says with a badge or a strike-through, said
        // in words — struck-through text and a missing badge are both silent.
        const state = isBilled
          ? count === 0
            ? 'billed'
            : `billed, ${count} still staged`
          : count === 0
            ? 'empty'
            : `${count} item${count === 1 ? '' : 's'}`

        return (
          <div key={seat.id} className="flex shrink-0 items-center gap-sp-1">
            <button
              type="button"
              aria-pressed={isActive}
              aria-label={`${spoken}, ${state}`}
              onClick={() => onSelect(seat.id)}
              className={cn(
                chip,
                // Filled, like the floor's selected zone tab. "Items land
                // here" is a strong claim and wants a strong treatment.
                isActive
                  ? 'border-brand-800 bg-brand-800'
                  : 'border-slate-200 bg-white night:border-night-hairline night:bg-night-card',
                // Settled: dimmed, but still legible and still tappable.
                isBilled && !isActive && 'bg-slate-50 opacity-70 night:bg-night-raised',
              )}
            >
              <span
                className={cn(
                  'max-w-32 truncate text-fs-16 font-bold',
                  isActive ? 'text-white' : 'text-slate-700 night:text-night-second',
                  isBilled && 'line-through',
                )}
              >
                {shown}
              </span>

              {/* No badge means an empty seat. Across a row of chips the
                  absence scans faster than the word did, and the accessible
                  name above still says "empty" out loud.

                  A billed seat shows its staged count when it has one:
                  saying only "billed" hid the single thing a waiter needs
                  after a 409 — WHICH dishes are stuck on the seat that has
                  already paid (code review 2026-10-13). */}
              {count > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'rounded-pill px-sp-2 py-0.5 text-fs-12 font-bold tabular-nums',
                    isActive ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600 night:bg-night-raised night:text-night-second',
                  )}
                >
                  {count}
                </span>
              ) : isBilled ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'text-fs-12 font-semibold',
                    isActive ? 'text-white' : 'text-slate-600 night:text-night-second',
                  )}
                >
                  billed
                </span>
              ) : null}
            </button>

            {onEditSeat && isActive ? (
              <button
                type="button"
                onClick={() => onEditSeat(seat.id)}
                aria-expanded={isEditing}
                aria-label={`${isEditing ? 'Close the note for' : 'Edit'} ${seat.seatLabel}`}
                className={cn(
                  'flex size-touch-standard shrink-0 items-center justify-center rounded-control border',
                  'transition-transform duration-80 ease-standard active:scale-[0.92]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  // Filled while its panel is open, so it shows which seat
                  // the note editor below belongs to.
                  isEditing
                    ? 'border-brand-800 bg-brand-800 text-white'
                    : 'border-slate-200 bg-white text-brand-700 night:border-night-hairline night:bg-night-card night:text-brand-300',
                )}
              >
                <Pencil aria-hidden="true" strokeWidth={2.5} className="size-4" />
              </button>
            ) : null}
          </div>
        )
      })}

      {onAddSeat ? (
        <button
          type="button"
          disabled={adding}
          onClick={onAddSeat}
          className={cn(
            chip,
            'border-dashed border-slate-400 bg-white text-fs-16 font-semibold text-slate-600 night:border-night-muted night:bg-night-card night:text-night-second',
            'disabled:opacity-40 disabled:active:scale-100',
          )}
        >
          {adding ? 'Adding…' : '+ Seat'}
        </button>
    ) : null}
    </div>
  )
}
