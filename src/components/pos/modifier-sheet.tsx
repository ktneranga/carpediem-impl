'use client'

import { Minus, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { MenuItemRow } from '@/app/api/menu/route'
import { commitButtonClass } from '@/components/pos/action-strip-chrome'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Matches nothing in the database — `modifier_text` has no CHECK, deliberately. */
const MAX_MODIFIER_TEXT = 120

/**
 * Bottom sheet for a modifier and a quantity (FR8, NFR-P6).
 *
 * ── A sheet, not a page ──────────────────────────────────────────────────────
 * `ux:309` and `ux:427`: "Item modifiers appear in a bottom sheet — no full-page
 * navigation, no context break." The waiter is mid-sentence with a guest; losing
 * the menu behind a route change is the moment the verbal bypass wins.
 *
 * ── Two taps, and the second one is the commit ───────────────────────────────
 * Tap 1 opened this from the card. Tap 2 is **Add to Order**. That is NFR-P6's
 * budget exactly, which is why nothing in here is required: the text may stay
 * empty, the quantity defaults to 1, and neither blocks the commit.
 *
 * ── Free text, not chip groups ───────────────────────────────────────────────
 * `ux:427` draws modifier GROUPS ("Spice: Mild / Medium / Hot") with required
 * options above optional ones. That needs a modifier model — groups, options,
 * per-item associations, an owner surface to configure them — and none of it has
 * an FR or an epic AC. FR8 asks for "modifiers or special instructions" and the
 * epic's own examples are "no ice" and "extra spicy". The structured version is
 * logged against Epic 10 in deferred-work.md.
 */
export function ModifierSheet({
  item,
  seatLabel,
  onCancel,
  onAdd,
}: {
  item: MenuItemRow
  /** The seat this will land on. Named, because the sheet hides the chip row. */
  seatLabel: string
  onCancel: () => void
  onAdd: (input: { quantity: number; modifierText: string }) => void
}) {
  const [quantity, setQuantity] = useState(1)
  const [modifierText, setModifierText] = useState('')

  const lineTotal = lkrFromPaisa(item.pricePaisa * quantity)

  return (
    // The scrim. Tapping it cancels — the sheet must be dismissible WITHOUT
    // adding, or a waiter who opened it by mistake has no way out but to order
    // something.
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Add ${item.name}`}
        // Stops a tap inside the sheet reaching the scrim's cancel.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Escape cancels and must NOT stage anything.
          if (event.key === 'Escape') onCancel()
        }}
        className={cn(
          'flex w-full max-w-2xl flex-col gap-sp-4 rounded-t-card bg-white p-sp-4 shadow-el-2',
          'max-h-[85vh] overflow-y-auto',
        )}
      >
        <div className="flex items-start justify-between gap-sp-3">
          <div className="flex flex-col gap-sp-1">
            <h2 className="text-fs-24 font-extrabold tracking-title text-slate-900">
              {item.name}
            </h2>
            {/* Which person this lands on. The chip row is behind the scrim, so
                without this the waiter is committing blind on a table of six. */}
            <p className="text-fs-14 font-semibold text-slate-600">
              For {seatLabel} · {lkrFromPaisa(item.pricePaisa)} each
            </p>
          </div>

          <button
            type="button"
            onClick={onCancel}
            aria-label="Close without adding"
            className={cn(
              'flex size-touch-waiter shrink-0 items-center justify-center rounded-waiter',
              'border border-slate-200 bg-white text-slate-600',
              'transition-[transform,box-shadow] duration-80 ease-standard',
              'active:scale-[0.97] active:shadow-pressed',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            <X aria-hidden="true" strokeWidth={2} className="size-6" />
          </button>
        </div>

        {/* `ux:427` — "Quantity stepper (+/−) always visible." */}
        <div className="flex items-center justify-between gap-sp-3">
          <span className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
            Quantity
          </span>
          <div className="flex items-center gap-sp-3">
            <button
              type="button"
              // Never below 1. Zero is what Cancel is for, and a zero-quantity
              // line would submit an order_event for nothing.
              disabled={quantity <= 1}
              onClick={() => setQuantity((current) => Math.max(1, current - 1))}
              aria-label="One fewer"
              className={cn(
                'flex size-touch-waiter shrink-0 items-center justify-center rounded-waiter',
                'border border-slate-200 bg-white text-slate-900',
                'transition-[transform,box-shadow] duration-80 ease-standard',
                'active:scale-[0.97] active:shadow-pressed',
                'disabled:opacity-40 disabled:active:scale-100',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              <Minus aria-hidden="true" strokeWidth={2.5} className="size-6" />
            </button>

            <output
              aria-live="polite"
              className="min-w-12 text-center text-fs-24 font-extrabold tabular-nums text-slate-900"
            >
              {quantity}
            </output>

            <button
              type="button"
              onClick={() => setQuantity((current) => current + 1)}
              aria-label="One more"
              className={cn(
                'flex size-touch-waiter shrink-0 items-center justify-center rounded-waiter',
                'border border-slate-200 bg-white text-slate-900',
                'transition-[transform,box-shadow] duration-80 ease-standard',
                'active:scale-[0.97] active:shadow-pressed',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              <Plus aria-hidden="true" strokeWidth={2.5} className="size-6" />
            </button>
          </div>
        </div>

        <label className="flex flex-col gap-sp-1">
          <span className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
            Note for the kitchen
          </span>
          <input
            type="text"
            value={modifierText}
            maxLength={MAX_MODIFIER_TEXT}
            placeholder="no ice, extra spicy, well done…"
            // Focused on open: the waiter opened this sheet FOR the note, so the
            // keyboard should already be up. The one-tap path never comes here.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onChange={(event) => setModifierText(event.target.value)}
            className={cn(
              'h-touch-waiter rounded-control border border-slate-200 bg-white px-sp-3',
              'text-fs-16 text-slate-900 placeholder:text-slate-600',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          />
        </label>

        {/* Full-width commit — the one thing kept verbatim from the UX spec's
            action-strip table, and the same rule the strips follow. */}
        <button
          type="button"
          onClick={() => onAdd({ quantity, modifierText })}
          className={cn(commitButtonClass, 'w-full')}
        >
          Add to Order · {lineTotal}
        </button>
      </div>
    </div>
  )
}
