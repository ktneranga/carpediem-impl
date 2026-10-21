'use client'

import { Ban, SlidersHorizontal } from 'lucide-react'
import { createElement } from 'react'
import type { MenuItemRow } from '@/app/api/menu/route'
import { routeForDestination } from '@/lib/design'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * One dish on the order screen's menu grid.
 *
 * ── THE CARD IS THE BUTTON (2026-10-21 design) ───────────────────────────────
 * It used to end in a 56px footer holding a wide `Add` and a narrow `Opts`.
 * The design has no footer: the card itself adds the dish, and options are a
 * small glyph in the bottom corner.
 *
 * That is a bigger target for the common action, not a smaller one. The old
 * `Add` was a 56px strip across the bottom third; the card is the whole thing.
 * What it costs is the WORD "Add", so the accessible name carries it in full —
 * "Add Devilled Cashew, LKR 950" — and the pressed state is on the card.
 *
 * Nested buttons are invalid, so Add is an absolutely positioned button
 * covering the card and the options button sits above it on the z-axis. Both
 * are real buttons: keyboard order is Add, then Options, per card.
 *
 * ── Size is unchanged, deliberately ──────────────────────────────────────────
 * Teran: "keep the card size same. do not make it smaller." Dropping the footer
 * would have taken ~56px off, so `min-h-39` holds the card at the footprint it
 * already had and the three rows space out into it. The design draws a shorter
 * card; this one is his call, and the layout inside is the design's.
 *
 * ── Built on the design system, not beside it ────────────────────────────────
 * - Corner: `rounded-waiter` (14px), the system's radius for "waiter buttons
 *   and menu cards"; `rounded-card` (20px) is the TABLE card's.
 * - Colour: the eyebrow uses the route's INK, which is the route colour for
 *   Pizza and Bar but `brand-700` for Kitchen, because Kitchen blue is 4.00:1
 *   on white and fails AA at 12px.
 * - Greys: only the system's five, and never `slate-400` for text that carries
 *   meaning — it is 2.56:1 on white.
 *
 * ── Text-first, no photograph ────────────────────────────────────────────────
 * Teran's 2026-09-16 design is text-only for density. `menu_items.image_url`
 * is still stored and still returned by `/api/menu`; restoring photos is a
 * change to this file alone.
 */
export function MenuItemCard({
  item,
  stagedCount = 0,
  onAdd,
  onOpenModifiers,
}: {
  item: MenuItemRow
  /**
   * How many of this dish the SELECTED SEAT already has in the staged round.
   *
   * Scoped to the selected seat so the badge answers "does THIS guest have it".
   */
  stagedCount?: number
  /** Stages the item as-is on the selected seat. One tap. */
  onAdd?: (item: MenuItemRow) => void
  /** Opens the modifier sheet. Tap 1 of the 2 NFR-P6 allows. */
  onOpenModifiers?: (item: MenuItemRow) => void
}) {
  const route = routeForDestination(item.productionDestination)
  const isStaged = stagedCount > 0
  const price = lkrFromPaisa(item.pricePaisa)
  const addable = item.available && Boolean(onAdd)

  return (
    <article
      className={cn(
        'relative flex min-h-39 flex-col justify-between gap-sp-2 overflow-hidden rounded-waiter border p-sp-4',
        // The staged card is outlined in brand, not banded across the top. One
        // ring reads at a glance across a grid of twenty; a 6px bar at the top
        // of a card disappears the moment the card above it has one too.
        item.available
          ? isStaged
            ? 'border-brand-500 bg-white shadow-el-2'
            : 'border-slate-200 bg-white shadow-el-1'
          : // Off today: flat, no shadow. It is not a surface you can act on.
            'border-slate-200 bg-slate-100',
        addable && 'transition-transform duration-80 ease-standard active:scale-[0.98]',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand-500',
      )}
    >
      {/* THE WHOLE CARD. Behind everything, so the options glyph wins its own
          few pixels; `inset-0` rather than a stretched-link pseudo-element so
          it is a real focusable button with a real accessible name. */}
      {addable ? (
        <button
          type="button"
          onClick={() => onAdd?.(item)}
          className="absolute inset-0 z-0 cursor-pointer focus:outline-none"
        >
          {/* The only text this button has. "Add another" because that is what
              a second tap does — it raises the existing line's quantity. */}
          <span className="sr-only">
            {isStaged ? `Add another ${item.name}, ${price}` : `Add ${item.name}, ${price}`}
          </span>
        </button>
      ) : null}

      {/* ── Top row: where it is made, and how many are staged ───────────── */}
      <div className="pointer-events-none relative z-10 flex items-start justify-between gap-sp-2">
        <p
          className={cn(
            'flex items-center gap-sp-1 text-fs-12 font-bold tracking-micro uppercase',
            item.available ? route.ink : 'text-slate-600',
          )}
        >
          {/* `createElement`, not `<Icon />` — the route record HOLDS a
              component, and using it as JSX from a lookup is what the
              compiler's "cannot create components during render" rule
              catches. Same reason as table-card.tsx. */}
          {item.available ? (
            createElement(route.icon, {
              'aria-hidden': 'true',
              strokeWidth: 2.4,
              className: 'size-3.5 shrink-0',
            })
          ) : (
            <Ban aria-hidden="true" strokeWidth={2.4} className="size-3.5 shrink-0" />
          )}
          {item.available ? route.short : 'Off today'}
        </p>

        {isStaged ? (
          // The digit is decoration; the words are for assistive tech. An
          // `aria-label` on a bare span is not reliably exposed.
          <span
            className={cn(
              'flex size-7 shrink-0 items-center justify-center rounded-pill',
              'bg-brand-800 text-fs-14 font-bold tabular-nums text-white',
            )}
          >
            <span aria-hidden="true">{stagedCount}</span>
            <span className="sr-only">{stagedCount} for the selected seat</span>
          </span>
        ) : null}
      </div>

      <h3
        className={cn(
          'pointer-events-none relative z-10 text-fs-18 font-bold',
          // An 86'd dish stays READABLE — slate-600 is 7.57:1 — and is struck
          // through, which says "not today" without making the name a guess.
          item.available ? 'text-slate-900' : 'text-slate-600 line-through',
        )}
      >
        {item.name}
      </h3>

      {/* ── Bottom row: the price, and the way to anything but one plain one ─ */}
      <div className="relative z-10 flex items-end justify-between gap-sp-2">
        {/* `lkrFromPaisa`, not `lkr(paisa / 100)` — `lkr` rounds, and a menu
            price is already exact. */}
        <p
          className={cn(
            'pointer-events-none text-fs-16 font-semibold tabular-nums',
            item.available ? 'text-slate-900' : 'text-slate-600',
          )}
        >
          {price}
        </p>

        {onOpenModifiers && item.available ? (
          <button
            type="button"
            onClick={() => onOpenModifiers(item)}
            aria-label={`Add ${item.name} with a note or a quantity`}
            className={cn(
              // 44px — the standard touch floor. Smaller than the old 56px
              // `Opts` button, and that is the trade the design makes: the
              // common action grew from a strip to the whole card, and the
              // rare one shrank to a corner. It is still a full standard
              // target, and the card behind it is the 56px one.
              'flex size-touch-standard shrink-0 items-center justify-center rounded-control',
              '-m-sp-2 text-slate-600',
              'transition-[transform,background-color] duration-80 ease-standard',
              'active:scale-[0.94] active:bg-slate-100',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            <SlidersHorizontal aria-hidden="true" strokeWidth={2.2} className="size-5" />
          </button>
        ) : null}
      </div>
    </article>
  )
}
