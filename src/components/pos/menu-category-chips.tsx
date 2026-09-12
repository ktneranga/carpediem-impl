'use client'

import { LayoutGrid } from 'lucide-react'
import { menuCategoryIcon } from '@/lib/design'
import { cn } from '@/lib/utils'

/**
 * Category filter chips for the menu (Story 4.2 Task 5).
 *
 * A sibling of `ZoneChipBar`, not a reuse of it: that component is typed to
 * `Zone`, carries per-zone open counts and a Counter pill, and none of those
 * mean anything here. The visual idiom is shared deliberately — a waiter has
 * already learned it on the floor screen — but the props are not.
 *
 * Each chip keeps its TEXT label alongside the icon. An icon alone is a guess,
 * and this design system already refuses to let shape or colour carry meaning
 * without a word (see `STATUS_TONES.label`).
 */
export function MenuCategoryChips({
  categories,
  activeCategoryId,
  onSelect,
}: {
  categories: { id: string; name: string }[]
  /** Null is the "All items" chip. */
  activeCategoryId: string | null
  onSelect: (categoryId: string | null) => void
}) {
  const chipClass = cn(
    'flex h-touch-waiter shrink-0 items-center gap-sp-2 rounded-control border px-sp-4',
    'text-fs-16 font-semibold whitespace-nowrap',
    'transition-[transform,box-shadow] duration-120 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  // `brand-700`, not `brand-500`. White on 500 is 3.9:1 at this size and fails
  // AA — the same correction made to `primaryButtonClass` on 2026-09-12, and the
  // same reason: selection must never be carried by an unreadable pair.
  const activeChip = 'border-brand-700 bg-brand-700 text-white shadow-el-2 inset-shadow-top'
  const inactiveChip = 'border-slate-200 bg-white text-slate-900 shadow-el-1'

  return (
    <div
      role="group"
      aria-label="Filter the menu by category"
      className="no-scrollbar flex shrink-0 gap-sp-3 overflow-x-auto py-sp-1"
    >
      <button
        type="button"
        aria-pressed={activeCategoryId === null}
        onClick={() => onSelect(null)}
        className={cn(chipClass, activeCategoryId === null ? activeChip : inactiveChip)}
      >
        <LayoutGrid
          aria-hidden="true"
          strokeWidth={2}
          className={cn(
            'size-5 shrink-0',
            activeCategoryId === null ? 'text-white' : 'text-slate-600',
          )}
        />
        All items
      </button>

      {categories.map((category) => {
        const isActive = category.id === activeCategoryId
        // Resolved once per CATEGORY. It used to be called once per item, from
        // inside the card map — the same lookup repeated for every dish.
        const Icon = menuCategoryIcon(category.name)

        return (
          <button
            key={category.id}
            type="button"
            aria-pressed={isActive}
            // Tap to filter, tap again to clear — "dismiss to return to full
            // list" (ux:417). No navigation happens either way.
            onClick={() => onSelect(isActive ? null : category.id)}
            className={cn(chipClass, isActive ? activeChip : inactiveChip)}
          >
            <Icon
              aria-hidden="true"
              strokeWidth={2}
              className={cn('size-5 shrink-0', isActive ? 'text-white' : 'text-slate-600')}
            />
            {category.name}
          </button>
        )
      })}
    </div>
  )
}
