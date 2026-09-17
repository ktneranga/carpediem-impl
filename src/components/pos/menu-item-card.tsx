'use client'

import type { MenuItemRow } from '@/app/api/menu/route'
import { routeForDestination } from '@/lib/design'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * One dish on the order screen's menu grid.
 *
 * ── Built on the design system, not beside it ────────────────────────────────
 * - Corner: `rounded-waiter` (14px), the system's radius for "waiter buttons
 *   and menu cards"; `rounded-card` (20px) is the TABLE card's.
 * - Colour: the staged band is the dish's route colour from `ROUTES` — Kitchen
 *   blue, Pizza orange, Bar violet. The eyebrow uses the route's INK, which is
 *   the route colour for Pizza and Bar but `brand-700` for Kitchen, because
 *   Kitchen blue is 4.00:1 on white and fails AA at 12px.
 * - Greys: only the system's five, and never `slate-400` for text that
 *   carries meaning — it is 2.56:1 on white.
 * - Touch: the footer is the 56px `touch-kitchen` token, the floor for every
 *   waiter control.
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
   * How many of this dish the SELECTED SEAT already has in the staged round.
   *
   * Shown as a badge, and it turns `Add` into `Add another` — which is what the
   * tap does: the same dish for the same seat raises that line's quantity.
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
  // The footer exists when there is something to say: an action to offer, or
  // the fact that the dish is off. A card with no staging context and an
  // available dish shows no footer — it used to say "Unavailable", because the
  // branch tested "orderable here" instead of "available".
  const showFooter = !item.available || Boolean(onAdd) || Boolean(onOpenModifiers)

  return (
    <article
      className={cn(
        'relative flex flex-col overflow-hidden rounded-waiter border border-slate-200 bg-white',
        isStaged ? 'shadow-el-2' : 'shadow-el-1',
      )}
    >
      {/* The staged band, in the dish's route colour. `overflow-hidden` on the
          card lets it meet the 14px corner cleanly — the table card's band uses
          the same technique. */}
      {isStaged ? (
        <span aria-hidden="true" className={cn('h-1.5 w-full shrink-0', route.band)} />
      ) : null}

      {isStaged ? (
        // The digit is decoration; the words are for assistive tech. An
        // `aria-label` on a bare span is not reliably exposed.
        <span
          className={cn(
            'absolute top-sp-4 right-sp-3 flex size-8 items-center justify-center rounded-pill',
            'bg-brand-700 text-fs-14 font-bold tabular-nums text-white',
          )}
        >
          <span aria-hidden="true">{stagedCount}</span>
          <span className="sr-only">{stagedCount} for the selected seat</span>
        </span>
      ) : null}

      {/* When staged, the body reserves 48px on the right. The badge is 32px
          wide and sits 12px in, so it covers the rightmost 44px — neither the
          eyebrow nor a long name may run under it. */}
      <div
        className={cn(
          'flex flex-1 flex-col gap-sp-1 pt-sp-4 pb-sp-3 pl-sp-4',
          isStaged ? 'pr-sp-7' : 'pr-sp-4',
        )}
      >
        {/* Where it is made — or, for an 86'd dish, the unavailable ink and
            words, so the state never rests on colour. */}
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
            'text-fs-18 font-bold',
            // An 86'd dish stays READABLE — slate-600 is 7.57:1 — and is struck
            // through, which says "not today" without making the name a guess.
            item.available ? 'text-slate-900' : 'text-slate-600 line-through',
          )}
        >
          {item.name}
        </h3>

        {/* `lkrFromPaisa`, not `lkr(paisa / 100)` — `lkr` rounds, and a menu
            price is already exact. */}
        <p className="mt-auto pt-sp-1 text-fs-16 font-semibold tabular-nums text-slate-600">
          {price}
        </p>
      </div>

      {/* One footer row, split unequally. For an unavailable dish the left half
          is a static word in the system's unavailable tones — never a disabled
          button, which invites a tap and teaches nothing. */}
      {showFooter ? (
        <div className="flex h-touch-kitchen shrink-0 border-t border-slate-200">
          {!item.available ? (
            <span className="flex flex-1 items-center justify-center bg-unavailable-chip text-fs-16 font-bold text-unavailable-ink">
              Unavailable
            </span>
          ) : onAdd ? (
            <button
              type="button"
              onClick={() => onAdd(item)}
              aria-label={
                isStaged ? `Add another ${item.name}, ${price}` : `Add ${item.name}, ${price}`
              }
              className={cn(
                'flex-1 text-fs-16 font-bold',
                'transition-[transform,background-color] duration-80 ease-standard',
                'active:scale-[0.98]',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
                // `brand-050` is the system's tint. (`brand-50` is not a token;
                // an earlier version of this card used it and rendered no fill.)
                isStaged ? 'bg-brand-700 text-white' : 'bg-brand-050 text-brand-700',
              )}
            >
              {isStaged ? 'Add another' : 'Add'}
            </button>
          ) : (
            <span className="flex-1" />
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
      ) : null}
    </article>
  )
}
