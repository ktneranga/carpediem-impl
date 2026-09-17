'use client'

import { Minus, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
 * navigation, no context break."
 *
 * ── A native modal `<dialog>` ────────────────────────────────────────────────
 * Task 3 asked for "a `<dialog>` or a focus-trapped overlay". The first version
 * was neither: a `div` with `aria-modal="true"` and nothing behind the claim —
 * Tab walked into the menu underneath, Escape stopped working once focus left
 * the panel, and focus was not returned to the Opts button that opened it.
 * `showModal()` gives all of that from the browser: the rest of the page is
 * inert, focus stays inside, Escape fires `cancel`, and focus goes back to the
 * opener on close.
 *
 * ── Two taps, and the second one is the commit ───────────────────────────────
 * Tap 1 opened this from the card. Tap 2 is **Add to Order**. Nothing in here
 * is required: the note may stay empty and the quantity defaults to 1.
 *
 * ── Free text, not chip groups ───────────────────────────────────────────────
 * `ux:427` draws modifier GROUPS ("Spice: Mild / Medium / Hot"), which need a
 * modifier model that has no FR or epic AC. Logged against Epic 10.
 */
export function ModifierSheet({
  item,
  seatLabel,
  onCancel,
  onAdd,
}: {
  item: MenuItemRow
  /**
   * The seat this will land on — named, because the sheet covers the seat
   * cards. Null where seats are not used (outside the Tables zone).
   */
  seatLabel: string | null
  onCancel: () => void
  onAdd: (input: { quantity: number; modifierText: string }) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const noteRef = useRef<HTMLInputElement>(null)
  /** Where the current pointer press began — see the backdrop click below. */
  const pressStartedOnBackdrop = useRef(false)

  const [quantity, setQuantity] = useState(1)
  const [modifierText, setModifierText] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    // Focus the note AFTER showModal: opening a modal dialog runs the browser's
    // own focusing steps, which would otherwise land on the Close button. The
    // waiter opened this sheet for the note, so the keyboard should be up.
    noteRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const lineTotal = lkrFromPaisa(item.pricePaisa * quantity)

  return (
    <dialog
      ref={dialogRef}
      aria-label={`Add ${item.name}`}
      // Escape. `preventDefault` keeps the browser from closing the element on
      // its own; the parent unmounts it instead, so state stays in one place.
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      onPointerDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // A click on the dialog element itself is a click on its backdrop — the
        // panel's content is a child. Both ends of the press must be there: the
        // first version cancelled when a press began in the note field and was
        // released past the edge, which threw away a half-typed note.
        if (event.target === event.currentTarget && pressStartedOnBackdrop.current) onCancel()
        pressStartedOnBackdrop.current = false
      }}
      className={cn(
        // Pinned to the bottom edge as a sheet, not centred as a dialog.
        'fixed inset-x-0 top-auto bottom-0 m-0 mx-auto w-full max-w-2xl p-0',
        'max-h-[85dvh] overflow-y-auto rounded-t-card bg-white shadow-el-4',
        'backdrop:bg-slate-900/50',
      )}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          // Enter in the note field adds, like the button. `method="dialog"`
          // would close the element; the parent owns closing, so prevent it.
          event.preventDefault()
          onAdd({ quantity, modifierText })
        }}
        className="flex flex-col gap-sp-4 p-sp-4"
      >
        <div className="flex items-start justify-between gap-sp-3">
          <div className="flex flex-col gap-sp-1">
            <h2 className="text-fs-24 font-extrabold tracking-title text-slate-900">{item.name}</h2>
            {/* Which person this lands on — the seat cards are behind the
                backdrop, so without this the waiter would commit blind. */}
            <p className="text-fs-14 font-semibold text-slate-600">
              {seatLabel ? `For ${seatLabel} · ` : ''}
              {lkrFromPaisa(item.pricePaisa)} each
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
              // Never below 1. Zero is what Close is for.
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
            ref={noteRef}
            type="text"
            value={modifierText}
            maxLength={MAX_MODIFIER_TEXT}
            placeholder="no ice, extra spicy, well done…"
            onChange={(event) => setModifierText(event.target.value)}
            className={cn(
              'h-touch-waiter rounded-control border border-slate-200 bg-white px-sp-3',
              'text-fs-16 text-slate-900 placeholder:text-slate-600',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          />
        </label>

        {/* Full-width commit, the same rule the action strips follow. */}
        <button type="submit" className={cn(commitButtonClass, 'w-full')}>
          Add to Order · {lineTotal}
        </button>
      </form>
    </dialog>
  )
}
