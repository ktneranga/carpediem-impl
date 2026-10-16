'use client'

import { createElement } from 'react'
import { Ban, SlidersHorizontal } from 'lucide-react'
import { routeForDestination, routeIcon } from '@/lib/design'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { MenuItemRow } from '@/app/api/menu/route'

/**
 * One dish on the menu grid.
 *
 * ── The 2026-10-16 design ────────────────────────────────────────────────────
 * Tapping ANYWHERE on the card adds one. The separate "Add" and "Opts" buttons
 * are gone: on a five-column grid they were two 44px targets inside a card the
 * waiter was already aiming at, and the common action — one of this dish —
 * deserved the whole card rather than a third of it.
 *
 * Modifiers moved to a small icon button in the corner. It stops the tap from
 * reaching the card (`stopPropagation`), because "add one" and "add one with
 * no ice" are different intentions and the second must not also do the first.
 *
 * ── The card does NOT fill when staged ──────────────────────────────────────
 * It gains a count badge and nothing else. The previous version turned the
 * whole card dark blue, which read as "selected" on a grid where nothing is
 * selectable, and made the price harder to read on exactly the dishes the
 * waiter was working with.
 *
 * ── Unavailable is GREY, not red ─────────────────────────────────────────────
 * Red is this system's colour for "needs attention". A dish being off today is
 * ordinary. It is dimmed, not tappable, and the grid sorts it to the end of its
 * category so it stops occupying a position the waiter's hand has learned.
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
   * Scoped to the selected seat so the badge answers "does THIS guest have
   * it", not "is it anywhere on the table".
   */
  stagedCount?: number
  /** Stages the item as-is on the selected seat. One tap, anywhere on the card. */
  onAdd?: (item: MenuItemRow) => void
  /** Opens the modifier sheet. Tap 1 of the 2 NFR-P6 allows. */
  onOpenModifiers?: (item: MenuItemRow) => void
}) {
  const route = routeForDestination(item.productionDestination)
  const orderable = item.available && Boolean(onAdd)

  return (
    <button
      type="button"
      disabled={!orderable}
      onClick={orderable ? () => onAdd?.(item) : undefined}
      aria-label={
        item.available
          ? `${item.name}, ${lkrFromPaisa(item.pricePaisa)}, to ${route.label}${
              stagedCount > 0 ? `, ${stagedCount} on this seat` : ''
            }`
          : `${item.name}, off today`
      }
      className={cn(
        'relative flex min-h-28 flex-col justify-between gap-sp-2 rounded-waiter border p-sp-3 text-left',
        'transition-[transform,box-shadow] duration-120 ease-standard',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        item.available
          ? 'border-slate-200 bg-white shadow-el-1 active:scale-[0.97] active:shadow-pressed'
          : // Grey and flat. Not red: a dish being off is ordinary, and red is
            // reserved for things that need acting on.
            'cursor-not-allowed border-dashed border-slate-200 bg-slate-50',
        // A staged dish keeps its white card and gains a badge. The brand ring
        // is the lightest possible "you have some of these".
        stagedCount > 0 && item.available && 'border-brand-300',
      )}
    >
      <span className="flex items-start justify-between gap-sp-2">
        {item.available ? (
          // Which station this goes to, in that station's colour. The waiter
          // reads it to predict the Send button's wording.
          <span
            className={cn(
              'flex items-center gap-sp-1 rounded-chip border px-sp-2 py-0.5',
              'text-fs-12 font-bold tracking-micro uppercase',
              'border-current/25',
              route.ink,
            )}
          >
            {createElement(routeIcon(item.productionDestination), {
              'aria-hidden': 'true',
              strokeWidth: 2.5,
              className: 'size-3.5 shrink-0',
            })}
            {route.short}
          </span>
        ) : (
          <span className="flex items-center gap-sp-1 rounded-chip border border-slate-200 px-sp-2 py-0.5 text-fs-12 font-bold tracking-micro text-slate-400 uppercase">
            <Ban aria-hidden="true" strokeWidth={2.5} className="size-3.5 shrink-0" />
            Off today
          </span>
        )}

        {stagedCount > 0 ? (
          <span
            aria-hidden="true"
            className={cn(
              'flex size-6 shrink-0 items-center justify-center rounded-pill',
              'bg-brand-700 text-fs-12 font-extrabold tabular-nums text-white',
            )}
          >
            {stagedCount}
          </span>
        ) : null}
      </span>

      <span className="flex flex-col gap-0.5">
        <span
          className={cn(
            'line-clamp-2 text-fs-16 font-bold',
            item.available ? 'text-slate-900' : 'text-slate-400',
          )}
        >
          {item.name}
        </span>
        <span className="flex items-end justify-between gap-sp-2">
          <span
            className={cn(
              'text-fs-14 font-semibold tabular-nums',
              item.available ? 'text-slate-600' : 'text-slate-400',
            )}
          >
            {lkrFromPaisa(item.pricePaisa)}
          </span>

          {/* Modifiers. A nested interactive element inside a button is invalid
              HTML, so this is a span with a button role — it carries the same
              keyboard behaviour and does not nest. */}
          {orderable && onOpenModifiers ? (
            <span
              role="button"
              tabIndex={0}
              aria-label={`Options for ${item.name}`}
              onClick={(event) => {
                // "Add one" and "add one with no ice" are different intentions.
                event.stopPropagation()
                onOpenModifiers(item)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                event.stopPropagation()
                onOpenModifiers(item)
              }}
              className={cn(
                'flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-control',
                'text-slate-400 transition-colors duration-80 ease-standard',
                'hover:bg-slate-100 hover:text-slate-600 active:bg-slate-200',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              <SlidersHorizontal aria-hidden="true" strokeWidth={2.2} className="size-4" />
            </span>
          ) : null}
        </span>
      </span>
    </button>
  )
}
