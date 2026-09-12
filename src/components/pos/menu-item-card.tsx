'use client'

import type { LucideIcon } from 'lucide-react'
import type { MenuItemRow } from '@/app/api/menu/route'
import { useState } from 'react'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * One dish on the order screen's menu grid.
 *
 * ── Images, and why most of them are not there ───────────────────────────────
 * `ux-design-specification.md:411` ruled product photography out: "restaurants
 * configure their own menus and cannot be expected to photograph 100+ items."
 * Teran reversed that on 2026-09-12 for this design — but the original reasoning
 * is still true of most menus, so `imageUrl` is optional and the fallback is a
 * FIRST-CLASS rendering: a category-tinted tile carrying that category's icon.
 *
 * A restaurant that photographs nothing gets a menu that looks deliberate. One
 * that photographs its best dishes gets those, on the same card.
 *
 * ── Why a plain `<img>` and not `next/image` ─────────────────────────────────
 * These URLs are owner-supplied and arbitrary. `next/image` would require every
 * host to be in `remotePatterns` at build time, which a per-restaurant
 * deployment cannot know. `loading="lazy"` and a fixed aspect box get the part
 * that actually matters on a tablet over LAN.
 */
export function MenuItemCard({
  item,
  icon: Icon,
  onAdd,
}: {
  item: MenuItemRow
  /**
   * The category's icon, for the fallback tile.
   *
   * Passed in rather than looked up here, so the chip and every card beneath it
   * render the SAME component instance — and because resolving a component
   * inside a component body is what the React Compiler lint rule refuses, with
   * good reason.
   */
  icon: LucideIcon
  /**
   * Staging an item is Story 4.4. Until it exists this is undefined and the card
   * renders NO add control at all — not a disabled one, which is the dead
   * "Switch user" control this project has already shipped once.
   */
  onAdd?: (itemId: string) => void
}) {
  // A URL that failed to load, or one that is only whitespace — `text('image_url')`
  // has no CHECK, and `src=" "` resolves to the current page, so the browser
  // tries to decode the HTML document as an image. Both fall back to the tile.
  const [imageFailed, setImageFailed] = useState(false)
  const imageUrl = item.imageUrl?.trim() ? item.imageUrl : null
  const showImage = imageUrl !== null && !imageFailed

  const price = lkrFromPaisa(item.pricePaisa)

  return (
    <article
      className={cn(
        'flex flex-col overflow-hidden rounded-card border bg-white text-left',
        'transition-[transform,box-shadow] duration-120 ease-standard',
        item.available ? 'border-slate-200 shadow-el-1' : 'border-slate-200 shadow-none',
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-100">
        {showImage ? (
          // Reason in the file header: owner-supplied arbitrary URLs cannot be
          // pre-declared in `next/image`'s remotePatterns per deployment.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            // Falls back to the designed tile rather than leaving a blank box.
            // These URLs are owner-supplied; a 404 is an ordinary outcome.
            onError={() => setImageFailed(true)}
            className={cn(
              'size-full object-cover',
              // Desaturated rather than hidden — an 86'd dish must still be
              // recognisable, because the waiter's next sentence is "we've run
              // out of the crab curry", not "we've run out of something".
              !item.available && 'grayscale',
            )}
          />
        ) : (
          // The designed fallback. Not a placeholder for a missing image — for
          // most items there will never be an image.
          <div
            className={cn(
              'flex size-full items-center justify-center',
              item.available ? 'bg-brand-100' : 'bg-slate-100',
            )}
          >
            <Icon
              aria-hidden="true"
              strokeWidth={1.5}
              className={cn('size-12', item.available ? 'text-brand-700' : 'text-slate-400')}
            />
          </div>
        )}

        {!item.available ? (
          <span
            className={cn(
              'absolute top-sp-2 left-sp-2 rounded-control px-sp-2 py-sp-1',
              'bg-unavailable-band text-fs-12 font-bold tracking-micro text-white uppercase',
            )}
          >
            Unavailable
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col gap-sp-2 p-sp-3">
        <h3
          className={cn(
            'text-fs-16 font-semibold',
            item.available ? 'text-slate-900' : 'text-slate-600 line-through',
          )}
        >
          {item.name}
        </h3>

        <div className="mt-auto flex items-center justify-between gap-sp-2">
          {/* `lkrFromPaisa`, not `lkr(paisa / 100)`. `lkr` rounds, which is
              right for a bill total decided once — but a menu price is already
              exact, and rounding it showed LKR 951 for an item priced 950.50. */}
          <span className="text-fs-16 font-bold tabular-nums text-brand-700">{price}</span>
        </div>

        {/* NO button when there is nothing to do.
            `action-strip-chrome.tsx` states the rule: "NO buttons at all, never
            disabled ones: a disabled control invites a tap and teaches nothing."
            This shipped the opposite at scale — every card carried a greyed 80px
            "Add to order" whose aria-label still promised the action, and
            `disabled` removed them all from the tab order, leaving the whole menu
            keyboard-inert. Until Story 4.4 passes `onAdd` there is no control;
            an unavailable item gets a plain badge, which informs without
            inviting. */}
        {onAdd && item.available ? (
          <button
            type="button"
            onClick={() => onAdd(item.id)}
            aria-label={`Add ${item.name}, ${price}`}
            className={cn(
              'h-touch-waiter w-full rounded-waiter text-fs-16 font-bold tracking-title',
              'bg-brand-100 text-brand-700',
              'transition-[transform,box-shadow] duration-80 ease-standard',
              'active:scale-[0.97] active:shadow-pressed',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            Add to order
          </button>
        ) : !item.available ? (
          <p className="text-fs-14 font-semibold text-slate-600">Not available today</p>
        ) : null}
      </div>
    </article>
  )
}
