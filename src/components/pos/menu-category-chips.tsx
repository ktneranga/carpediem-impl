'use client'

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A chip that changes which set of chips is showing, rather than filtering. */
type NavChip = { label: string; icon?: LucideIcon; onClick: () => void }

/**
 * Category filter chips for the menu (Story 4.2 Task 5, restyled 2026-09-16).
 *
 * A sibling of `ZoneChipBar`, not a reuse of it: that component is typed to
 * `Zone` and carries a Counter pill, neither of which means anything here.
 *
 * ── The name, and nothing else (2026-10-21 design) ───────────────────────────
 * These read "PIZZA 2" in uppercase with a live item count. The design draws
 * "Pizza" in sentence case with no number.
 *
 * The count is a real loss and worth naming: it told a waiter not to bother
 * tapping a category with two items in it. What it cost was a row of chips
 * that each carried two things to read while the grid underneath carries the
 * same information in cards you can actually order from — and the count was
 * never live against 86'd dishes mid-service, only against the fetched menu.
 * Ask and it comes back; the caller still computes it.
 *
 * Still 56px, not the 48px drawn. 56 is the floor every waiter control in this
 * system clears, and a filter chip is tapped more than most.
 */
export function MenuCategoryChips({
  categories,
  activeCategoryId,
  onSelect,
  allLabel = 'All',
  leading,
  trailing,
}: {
  /**
   * Each category and how many items it currently offers. Supplied by the
   * caller, which already has the list — recounting here would be a second
   * answer to one question.
   */
  categories: { id: string; name: string; itemCount: number }[]
  /** Null is the "All items" chip. */
  activeCategoryId: string | null
  onSelect: (categoryId: string | null) => void
  /** "All drinks" on the drinks side. */
  allLabel?: string
  /** Before "All" — "‹ Food", back from the drinks. */
  leading?: NavChip
  /** After the categories — "Drinks", into them. */
  trailing?: NavChip
}) {
  // "All", not "All items": the row is all categories, so the longer label was
  // only ever disambiguating itself. "All drinks" on the drinks side.
  const chips = [{ id: null, name: allLabel }, ...categories]

  // Navigation chips are outlined in brand rather than filled, so they never
  // read as a selected category — they change the ROW, not the filter.
  const navChip = (chip: NavChip) => {
    const Icon = chip.icon
    return (
      <button
        type="button"
        onClick={chip.onClick}
        className={cn(
          'flex h-touch-kitchen shrink-0 items-center gap-sp-2 rounded-pill border px-sp-5',
          'border-brand-300 bg-brand-050 text-fs-16 font-bold whitespace-nowrap text-brand-700 night:border-brand-500/50 night:bg-night-raised night:text-brand-300',
          'transition-transform duration-120 ease-standard active:scale-[0.97]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        {Icon ? <Icon aria-hidden="true" className="size-5 shrink-0" /> : null}
        {chip.label}
      </button>
    )
  }

  return (
    <div
      role="group"
      aria-label="Filter the menu by category"
      className="no-scrollbar flex shrink-0 gap-sp-2 overflow-x-auto py-sp-1"
    >
      {leading ? navChip(leading) : null}
      {chips.map((chip) => {
        const isActive = chip.id === activeCategoryId

        return (
          <button
            key={chip.id ?? 'all'}
            type="button"
            aria-pressed={isActive}
            // Tap to filter, tap again to clear — "dismiss to return to full
            // list" (ux:417). "All items" is never a toggle.
            onClick={() => onSelect(isActive && chip.id !== null ? null : chip.id)}
            className={cn(
              // The 56px touch token — the floor for waiter controls — and the system's
              // pill radius, not Tailwind's `rounded-full`.
              'flex h-touch-kitchen shrink-0 items-center rounded-pill border px-sp-5',
              'text-fs-16 font-semibold whitespace-nowrap',
              'transition-[transform,background-color] duration-120 ease-standard',
              'active:scale-[0.97]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              // Flat, like the floor's zone tabs: a selected state, not a
              // control raised above the row. `brand-800`, not `brand-500`:
              // white on 500 is 3.9:1 and fails AA.
              isActive
                ? 'border-brand-800 bg-brand-800 text-white'
                : 'border-slate-200 bg-white text-slate-700 night:border-night-hairline night:bg-night-card night:text-night-second',
            )}
          >
            {chip.name}
          </button>
        )
      })}
      {trailing ? navChip(trailing) : null}
    </div>
  )
}
