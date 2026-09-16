'use client'

import type { MenuItemRow } from '@/app/api/menu/route'
import { routeForDestination } from '@/lib/design'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * One dish on the order screen's menu grid.
 *
 * ── Built on the design system, not beside it ────────────────────────────────
 * - Corner: `rounded-waiter` (14px). `globals.css` assigns that radius to
 *   "waiter buttons and menu cards"; `rounded-card` (20px) is the TABLE card's.
 * - Colour: the eyebrow and the staged band come from `ROUTES`, the system's
 *   only non-status accents — Kitchen blue, Pizza orange, Bar violet — so a
 *   dish's colour says where it is made, and says it the same way the kitchen
 *   ticket will.
 * - Greys: only the five the system defines.
 *
 * ── Text-first, no photograph ────────────────────────────────────────────────
 * Teran's 2026-09-16 design is text-only for density. `menu_items.image_url`
 * is still stored and still returned by `/api/menu`; restoring photos is a
 * change to this file alone.
 *
 * ── Two controls, deliberately unequal ───────────────────────────────────────
 * `Add` is wide and `Opts` is narrow because one of them is the answer almost
 * every time. NFR-P6 allows two taps for a modifier; it does not ask for two
 * taps for a plain dish.
 */
export function MenuItemCard({
  item,
  stagedCount = 0,
  onAdd,
  onOpenModifiers,
}: {
  item: MenuItemRow
  /**
   * How many of this dish are already in the staged round.
   *
   * Shown as a badge, and it turns `Add` into `Add another`. Without it a
   * waiter interrupted mid-round has to read the whole staged list to find out
   * whether they already tapped this — which they will not do, so they tap
   * again and the table gets two.
   */
  stagedCount?: number
  /** Stages the item as-is on the active seat. One tap. */
  onAdd?: (item: MenuItemRow) => void
  /** Opens the modifier sheet. Tap 1 of the 2 NFR-P6 allows. */
  onOpenModifiers?: (item: MenuItemRow) => void
}) {
  const route = routeForDestination(item.productionDestination)
  const isStaged = stagedCount > 0
  const canOrder = item.available && Boolean(onAdd)
  const price = lkrFromPaisa(item.pricePaisa)

  return (
    <article
      className={cn(
        'relative flex flex-col overflow-hidden rounded-waiter border border-slate-200 bg-white',
        isStaged ? 'shadow-el-2' : 'shadow-el-1',
      )}
    >
      {/* The staged band, in the dish's route colour. `overflow-hidden` on the
          card is what lets it meet the 14px corner cleanly — the same technique
          as the table card's status band. */}
      {isStaged ? <span aria-hidden="true" className={cn('h-1.5 w-full shrink-0', route.band)} /> : null}

      {isStaged ? (
        <span
          aria-label={`${stagedCount} in this round`}
          className={cn(
            'absolute right-sp-3 flex size-8 items-center justify-center rounded-pill',
            'bg-brand-700 text-fs-14 font-bold tabular-nums text-white',
            'top-sp-4',
          )}
        >
          {stagedCount}
        </span>
      ) : null}

      <div className="flex flex-1 flex-col gap-sp-1 px-sp-4 pt-sp-4 pb-sp-3">
        {/* Where it is made, in that route's colour — or, for an 86'd dish, the
            unavailable ink and words, so the state never rests on colour. */}
        <p
          className={cn(
            'text-fs-12 font-bold tracking-micro uppercase',
            item.available ? route.ink : 'text-unavailable-ink',
          )}
        >
          {item.available ? route.short : 'Off today'}
        </p>

        <h3
          className={cn(
            // Room for the badge, so a long name never runs under it.
            'pr-sp-6 text-fs-18 font-bold',
            item.available ? 'text-slate-900' : 'text-slate-400',
          )}
        >
          {item.name}
        </h3>

        {/* `lkrFromPaisa`, not `lkr(paisa / 100)` — `lkr` rounds, and a menu
            price is already exact. */}
        <p
          className={cn(
            'mt-auto pt-sp-1 text-fs-16 font-semibold tabular-nums',
            item.available ? 'text-slate-600' : 'text-slate-400',
          )}
        >
          {price}
        </p>
      </div>

      {/* One footer row, split unequally. Rendered even for an unavailable dish
          so the grid keeps one rhythm — but its left half is then a static word,
          never a disabled button: a disabled control invites a tap and teaches
          nothing. */}
      <div className="flex h-14 shrink-0 border-t border-slate-200">
        {canOrder ? (
          <button
            type="button"
            onClick={() => onAdd?.(item)}
            aria-label={isStaged ? `Add another ${item.name}, ${price}` : `Add ${item.name}, ${price}`}
            className={cn(
              'flex-1 text-fs-16 font-bold',
              'transition-[transform,background-color] duration-80 ease-standard',
              'active:scale-[0.98]',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
              // `brand-050` — the system's tint. (`brand-50` is not a token; an
              // earlier version of this card used it and rendered no fill.)
              isStaged ? 'bg-brand-700 text-white' : 'bg-brand-050 text-brand-700',
            )}
          >
            {isStaged ? 'Add another' : 'Add'}
          </button>
        ) : (
          <span className="flex flex-1 items-center justify-center bg-slate-100 text-fs-16 font-semibold text-slate-400">
            Unavailable
          </span>
        )}

        {onOpenModifiers && item.available ? (
          <button
            type="button"
            onClick={() => onOpenModifiers(item)}
            aria-label={`Add ${item.name} with a note or a quantity`}
            className={cn(
              'w-20 shrink-0 border-l border-slate-200 bg-white',
              'text-fs-14 font-semibold text-slate-600',
              'transition-[transform,background-color] duration-80 ease-standard',
              'active:scale-[0.98] active:bg-slate-100',
              'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            Opts
          </button>
        ) : null}
      </div>
    </article>
  )
}
