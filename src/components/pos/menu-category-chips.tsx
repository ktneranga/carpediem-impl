'use client'

import { cn } from '@/lib/utils'

/**
 * Category filter chips for the menu (Story 4.2 Task 5, restyled 2026-09-16).
 *
 * A sibling of `ZoneChipBar`, not a reuse of it: that component is typed to
 * `Zone` and carries a Counter pill, neither of which means anything here.
 *
 * ── Words and counts, no icons ───────────────────────────────────────────────
 * The 2026-09-16 design dropped the category icons for an uppercase name and an
 * item count. The count is what makes a chip worth reading before tapping it:
 * "PIZZA 2" tells a waiter not to bother scrolling, and "MAINS 4" sets the
 * expectation for what the grid is about to show.
 */
export function MenuCategoryChips({
  categories,
  activeCategoryId,
  onSelect,
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
}) {
  const totalItemCount = categories.reduce((total, category) => total + category.itemCount, 0)

  const chips = [
    { id: null, name: 'All items', itemCount: totalItemCount },
    ...categories,
  ]

  return (
    <div
      role="group"
      aria-label="Filter the menu by category"
      className="no-scrollbar flex shrink-0 gap-sp-2 overflow-x-auto py-sp-1"
    >
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
              'flex h-touch-kitchen shrink-0 items-center gap-sp-2 rounded-pill border px-sp-5',
              'text-fs-14 font-bold tracking-micro whitespace-nowrap uppercase',
              'transition-[transform,box-shadow] duration-120 ease-standard',
              'active:scale-[0.97] active:shadow-pressed',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              // `brand-700`, not `brand-500`: white on 500 is 3.9:1 and fails AA.
              isActive
                ? 'border-brand-700 bg-brand-700 text-white shadow-el-2'
                : 'border-slate-200 bg-white text-slate-600 shadow-el-1',
            )}
          >
            {chip.name}
            {/* Visible, and part of the accessible name — "Mains 4" is the
                useful announcement, so it is not hidden from screen readers. */}
            <span
              className={cn(
                'tabular-nums font-semibold',
                // Full white on brand-700 (6.03:1) and slate-600 on white
                // (7.57:1). `white/70` was 3.85:1 and `slate-400` 2.56:1 — both
                // below AA for the number the chip exists to show.
                isActive ? 'text-white' : 'text-slate-600',
              )}
            >
              {chip.itemCount}
            </span>
          </button>
        )
      })}
    </div>
  )
}
