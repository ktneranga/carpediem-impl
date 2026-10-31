'use client'

import { Minus, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MenuItemRow } from '@/app/api/menu/route'
import { commitButtonClass } from '@/components/pos/action-strip-chrome'
import { lkrFromPaisa, signedLkrFromPaisa } from '@/lib/format'
import {
  chosenOptions,
  defaultOptionIds,
  sortIds,
  unitPriceFor,
  validateSelection,
} from '@/lib/options'
import { cn } from '@/lib/utils'
// One limit, shared with the server's schema — the local copy that lived here
// could drift from it silently.
import { MAX_MODIFIER_TEXT } from '@/types/orders'

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
 * Tap 1 opened this from the card. Tap 2 is **Add to Order**. The defaults are
 * preselected, so a required group never forces a third tap unless it has no
 * default; the note may stay empty and the quantity defaults to 1.
 *
 * ── Priced options as chip groups (Story 4.8, `ux:427`) ─────────────────────
 * "Alcohol: No alcohol −LKR 1,000 / Single / Double shot +LKR 1,000". Required
 * groups first and marked; a `single` group behaves as radios, a `multi` group
 * as toggles. The header and the commit show the LIVE unit price and line
 * total, computed by `unitPriceFor` — the same function the server prices by.
 * The free-text note stays beside them: options are the owner's words, the
 * note is the waiter's.
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
  onAdd: (input: { quantity: number; modifierText: string; optionIds: string[] }) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const noteRef = useRef<HTMLInputElement>(null)
  /** Where the current pointer press began — see the backdrop click below. */
  const pressStartedOnBackdrop = useRef(false)

  const [quantity, setQuantity] = useState(1)
  const [modifierText, setModifierText] = useState('')

  // Required groups first (`ux:427`), each keeping the owner's order within.
  const groups = [...(item.modifierGroups ?? [])].sort(
    (a, b) => Number(b.required) - Number(a.required),
  )
  const [optionIds, setOptionIds] = useState<string[]>(() => defaultOptionIds(groups))
  const chosen = chosenOptions(groups, optionIds)
  const unitPrice = unitPriceFor(item.pricePaisa, chosen)
  const problem = validateSelection(groups, optionIds)
  const missingGroup =
    problem?.reason === 'required' ? groups.find((group) => group.id === problem.groupId) : null

  function toggle(groupId: string, optionId: string) {
    const group = groups.find((candidate) => candidate.id === groupId)
    if (!group) return
    setOptionIds((current) => {
      const inGroup = new Set(group.options.map((option) => option.id))
      const has = current.includes(optionId)
      if (group.selection === 'multi') {
        return sortIds(has ? current.filter((id) => id !== optionId) : [...current, optionId])
      }
      // Single: tapping the chosen chip keeps it in a REQUIRED group (there
      // must be one) and clears it in an optional one; another chip replaces it.
      if (has) return group.required ? current : current.filter((id) => id !== optionId)
      return sortIds([...current.filter((id) => !inGroup.has(id)), optionId])
    })
  }

  // Read once, at open: the effect below runs on mount only, and a menu refetch
  // while the sheet is up must not move the focus.
  const opensOnNoteRef = useRef(groups.length === 0)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    // Focus the note AFTER showModal: opening a modal dialog runs the browser's
    // own focusing steps, which would otherwise land on the Close button. A
    // dish WITHOUT options was opened for the note, so the keyboard comes up.
    // One WITH options was opened for them: raising the keyboard would cover
    // the chips the waiter came to tap.
    if (opensOnNoteRef.current) noteRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const lineTotal = lkrFromPaisa(unitPrice * quantity)

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
        // ── Centred, not a bottom sheet (Teran, 2026-10-21) ─────────────────
        // The dialog element is now the whole viewport and transparent; the
        // panel is the form inside it, centred by flex. Centring the dialog
        // itself with `top-1/2 -translate-y-1/2` would have landed it high and
        // left: percentages and viewport units resolve BEFORE the body's 0.9
        // zoom, so 50% paints at 45%. `h-app`/`w-app` divide the zoom back out
        // — the same correction the app shell uses.
        //
        // It also makes the backdrop press more honest. The handlers below
        // test `event.target === event.currentTarget`, which used to mean "the
        // strip of backdrop above the sheet"; it now means anywhere outside
        // the panel, which is what a waiter aiming to dismiss would hit.
        'fixed top-0 left-0 m-0 h-app w-app max-h-none max-w-none p-sp-4',
        'flex items-center justify-center bg-transparent',
        'backdrop:bg-slate-900/50',
      )}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          // Enter in the note field adds, like the button. `method="dialog"`
          // would close the element; the parent owns closing, so prevent it.
          event.preventDefault()
          // Enter in the note must not add a dish with a required group empty.
          if (problem) return
          onAdd({ quantity, modifierText, optionIds })
        }}
        // The panel. `max-h-full` against the padded dialog, so a long note
        // field scrolls inside the card rather than running off the screen.
        className={cn(
          'flex max-h-full w-full max-w-2xl flex-col gap-sp-4 overflow-y-auto',
          'rounded-card bg-white p-sp-4 shadow-el-4',
        )}
      >
        <div className="flex items-start justify-between gap-sp-3">
          <div className="flex flex-col gap-sp-1">
            <h2 className="text-fs-24 font-extrabold tracking-title text-slate-900">{item.name}</h2>
            {/* Which person this lands on — the seat cards are behind the
                backdrop, so without this the waiter would commit blind. */}
            <p className="text-fs-14 font-semibold text-slate-600">
              {seatLabel ? `For ${seatLabel} · ` : ''}
              {lkrFromPaisa(unitPrice)} each
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

        {/* ── The options, one row of chips per group ─────────────────────── */}
        {groups.map((group) => (
          <fieldset key={group.id} className="flex flex-col gap-sp-2">
            <legend className="mb-sp-2 flex items-center gap-sp-2 text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
              {group.name}
              {group.required ? (
                <span className="rounded-pill bg-occupied-chip px-sp-2 py-0.5 text-fs-12 font-bold text-occupied-ink normal-case tracking-normal">
                  Required
                </span>
              ) : (
                <span className="font-semibold normal-case tracking-normal text-slate-600">
                  {group.selection === 'multi' ? 'optional · any' : 'optional'}
                </span>
              )}
            </legend>
            <div className="flex flex-wrap gap-sp-2">
              {group.options.map((option) => {
                const isOn = optionIds.includes(option.id)
                const delta = signedLkrFromPaisa(option.priceDeltaPaisa)
                return (
                  <button
                    key={option.id}
                    type="button"
                    role={group.selection === 'single' ? 'radio' : 'checkbox'}
                    aria-checked={isOn}
                    disabled={!option.available}
                    onClick={() => toggle(group.id, option.id)}
                    className={cn(
                      // 56px — the waiter touch floor every order control clears.
                      'flex min-h-touch-kitchen items-center gap-sp-2 rounded-pill border-2 px-sp-4',
                      'text-fs-16 font-bold',
                      'transition-[transform,background-color] duration-80 ease-standard active:scale-[0.97]',
                      'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      isOn
                        ? 'border-brand-800 bg-brand-800 text-white'
                        : 'border-slate-200 bg-white text-slate-900',
                    )}
                  >
                    {option.name}
                    {delta ? (
                      <span
                        className={cn(
                          'text-fs-14 font-semibold tabular-nums',
                          isOn ? 'text-white' : 'text-slate-600',
                        )}
                      >
                        {delta}
                      </span>
                    ) : null}
                    {option.available ? null : <span className="sr-only">, unavailable</span>}
                  </button>
                )
              })}
            </div>
          </fieldset>
        ))}

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

        {/* Full-width commit, the same rule the action strips follow. Disabled
            until every required group has a choice — the server would refuse
            the WHOLE round otherwise — and it says which group is missing. */}
        {missingGroup ? (
          <p role="status" className="text-fs-14 font-semibold text-occupied-ink">
            Choose {missingGroup.name.toLowerCase()} to add this.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={problem !== null}
          className={cn(commitButtonClass, 'w-full disabled:opacity-40')}
        >
          Add to Order · {lineTotal}
        </button>
      </form>
    </dialog>
  )
}
