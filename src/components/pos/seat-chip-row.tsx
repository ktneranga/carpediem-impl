'use client'

import { Pencil, Plus, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SeatSlot = {
  id: string
  seatLabel: string
  /** "red shirt", "curly hair" — shown here, never on a guest's bill. */
  seatNote: string | null
}

/**
 * The people on this order (FR10).
 *
 * ── Why a note, and why it replaces the number ───────────────────────────────
 * A waiter cannot ask four strangers their names, so they record what they can
 * see. The chip shows the note when there is one, because the row should read as
 * PEOPLE — "Red shirt", "Curly hair" — which is what the waiter is actually
 * looking at across the table. A seat nobody labelled keeps its number.
 *
 * The label stays in the accessible name either way ("Seat 2, red shirt"), so
 * the chip is still identifiable when the note is absent, ambiguous, or when two
 * guests are both in red.
 *
 * ── Not extracted into a shared chip component, deliberately ─────────────────
 * This is the third horizontally scrollable chip row in the codebase, after
 * `ZoneChipBar` and `MenuCategoryChips`. They look alike and carry different
 * things: open counts, a category icon, a person's description and a delete
 * affordance. A shared component at this point would be parameterised into
 * uselessness. Worth revisiting if a fourth appears — noted in deferred-work.md.
 */
export function SeatChipRow({
  seats,
  activeSeatId,
  busy = false,
  onSelect,
  onEditSeat,
  onAddSeat,
}: {
  seats: SeatSlot[]
  activeSeatId: string | null
  busy?: boolean
  onSelect: (seatId: string) => void
  /** Opens the note-and-remove panel for the ACTIVE seat. */
  onEditSeat?: (seatId: string) => void
  /** Undefined until a parent can create seats; the button is then absent. */
  onAddSeat?: () => void
}) {
  const activeSeat = seats.find((seat) => seat.id === activeSeatId) ?? null
  const chipBase = cn(
    'flex h-touch-waiter shrink-0 items-center gap-sp-2 rounded-control border px-sp-4',
    'text-fs-16 font-semibold whitespace-nowrap',
    'transition-[transform,box-shadow] duration-120 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  // `brand-700`, never `brand-500`. White on 500 is 3.9:1 and fails AA — fixed
  // across the codebase on 2026-09-12, and the reason the active state of all
  // three chip rows now agrees.
  const activeChip = 'border-brand-700 bg-brand-700 text-white shadow-el-2 inset-shadow-top'
  const inactiveChip = 'border-slate-200 bg-white text-slate-900 shadow-el-1'

  return (
    <div
      role="group"
      aria-label="Seats on this order"
      className="no-scrollbar flex shrink-0 gap-sp-3 overflow-x-auto py-sp-1"
    >
      {seats.map((seat) => {
        const isActive = seat.id === activeSeatId
        // The note is what the waiter recognises; the number is the fallback.
        const shown = seat.seatNote ?? seat.seatLabel

        return (
          <button
            key={seat.id}
            type="button"
            aria-pressed={isActive}
            // Both facts, always — a screen-reader user gets the seat's identity
            // even when the visible text is only a description.
            aria-label={seat.seatNote ? `${seat.seatLabel}, ${seat.seatNote}` : seat.seatLabel}
            onClick={() => onSelect(seat.id)}
            className={cn(chipBase, isActive ? activeChip : inactiveChip)}
          >
            <UserRound
              aria-hidden="true"
              strokeWidth={2}
              className={cn('size-5 shrink-0', isActive ? 'text-white' : 'text-slate-600')}
            />
            <span className="max-w-40 truncate">{shown}</span>
          </button>
        )
      })}

      {/* No DELETE on the chip, and no note field on it either. A mis-tap must
          not destroy a seat, so removal lives TWO taps in: select the seat, then
          open this panel. That is the floor screen's select-then-act rule
          (Story 3.7), one step stricter because a seat cannot be recreated —
          it would be a new row with a new id, and `order_events` is
          append-only. Selecting a seat stays a single tap, because that is the
          thing a waiter does on every item. */}
      {onEditSeat && activeSeat ? (
        <button
          type="button"
          onClick={() => onEditSeat(activeSeat.id)}
          aria-label={`Edit ${activeSeat.seatLabel}`}
          className={cn(chipBase, inactiveChip, 'text-slate-600')}
        >
          <Pencil aria-hidden="true" strokeWidth={2} className="size-5 shrink-0" />
          Edit
        </button>
      ) : null}

      {onAddSeat ? (
        <button
          type="button"
          disabled={busy}
          onClick={onAddSeat}
          className={cn(
            chipBase,
            'border-dashed border-brand-500 bg-white text-brand-700',
            'disabled:opacity-40 disabled:active:scale-100',
          )}
        >
          <Plus aria-hidden="true" strokeWidth={2} className="size-5 shrink-0" />
          {busy ? 'Adding…' : 'Add Seat'}
        </button>
      ) : null}
    </div>
  )
}
