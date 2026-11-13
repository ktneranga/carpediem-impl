'use client'

import { Minus, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { commitButtonClass } from '@/components/pos/action-strip-chrome'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'
import { MAX_CUSTOM_CHARGE_PAISA, MAX_CUSTOM_NAME, MAX_LINE_QUANTITY } from '@/types/orders'

/**
 * A custom charge — "Corkage", "Broken glass", "4 shots, guest request" — with
 * a name and price the owner types (Story 4.9, FR66).
 *
 * Opened from the small + beside "Table total" in the order column, shown
 * only to staff allowed to add one (Teran, 2026-11-02). Add SAVES it — straight to the
 * order and the bill, no Send, no kitchen ticket. The server decides again
 * (`canAddCustomCharge`); hiding the button is convenience, not the guard.
 *
 * ── The same dialog as the options sheet ───────────────────────────────────
 * `modifier-sheet.tsx`'s pattern, for the same reasons: a native modal
 * `<dialog>` for focus trapping and Escape, centred in an `h-app`/`w-app`
 * viewport so the body's zoom does not push it off-centre, and the parent
 * unmounts it rather than the browser closing it.
 *
 * ── The price ────────────────────────────────────────────────────────────────
 * Typed in LKR, with cents allowed, and converted with `Math.round(lkr * 100)`
 * — the conversion Story 10.4 specifies for owner-entered prices. Positive
 * only, at most LKR 100,000: a reduction is a comp (Epic 7), with its own
 * reasons and audit, not a negative charge.
 */
export function CustomChargeSheet({
  seatLabel,
  busy = false,
  locked = false,
  error = null,
  onCancel,
  onAdd,
}: {
  /** Which person this lands on, or null where seats are not used. */
  seatLabel: string | null
  /** Saving: Add is disabled so a second tap cannot charge twice. */
  busy?: boolean
  /**
   * The last save may have committed (no response): the fields freeze so Add
   * resends THIS charge under the same send id — a replay, never an edited
   * charge answered with the first one's replay.
   */
  locked?: boolean
  /** Why the last save failed, in words — the sheet stays open to retry. */
  error?: string | null
  onCancel: () => void
  onAdd: (input: { name: string; pricePaisa: number; quantity: number }) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const pressStartedOnBackdrop = useRef(false)
  const [name, setName] = useState('')
  const [priceText, setPriceText] = useState('')
  const [quantity, setQuantity] = useState(1)

  const trimmedName = name.trim()
  const pricePaisa = parsePricePaisa(priceText)
  const nameOk = trimmedName.length >= 1 && trimmedName.length <= MAX_CUSTOM_NAME
  const priceOk = pricePaisa !== null
  const ready = nameOk && priceOk
  const frozen = busy || locked

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    // AFTER showModal, whose own focusing would land on the Close button. The
    // owner opened this to type a name, so the keyboard comes up for it.
    nameRef.current?.focus()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const priceProblem =
    priceText.trim() === '' || priceOk
      ? null
      : `Enter a price above LKR 0, up to ${lkrFromPaisa(MAX_CUSTOM_CHARGE_PAISA)}.`

  const fieldClass = cn(
    'h-touch-waiter rounded-control border border-slate-200 bg-white px-sp-3 night:border-night-hairline night:bg-night-card',
    'text-fs-16 text-slate-900 placeholder:text-slate-600 night:text-night-text',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )
  const stepperClass = cn(
    'flex size-touch-waiter shrink-0 items-center justify-center rounded-waiter',
    'border border-slate-200 bg-white text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text',
    'transition-[transform,box-shadow] duration-80 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'disabled:opacity-40 disabled:active:scale-100',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  return (
    <dialog
      ref={dialogRef}
      aria-label="Add a custom charge"
      onCancel={(event) => {
        event.preventDefault()
        // Not while saving: closing then hides a charge that still lands, and
        // the owner adds it again.
        if (!busy) onCancel()
      }}
      onPointerDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        // Both ends of the press on the backdrop, so a drag that starts in a
        // field and ends past the edge does not throw the typing away.
        if (event.target === event.currentTarget && pressStartedOnBackdrop.current && !busy) onCancel()
        pressStartedOnBackdrop.current = false
      }}
      className={cn(
        'fixed top-0 left-0 m-0 h-app w-app max-h-none max-w-none p-sp-4',
        'flex items-center justify-center bg-transparent',
        'backdrop:bg-slate-900/50',
      )}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready || busy) return
          onAdd({ name: trimmedName, pricePaisa: pricePaisa!, quantity })
        }}
        className={cn(
          'flex max-h-full w-full max-w-2xl flex-col gap-sp-4 overflow-y-auto',
          'rounded-card bg-white p-sp-4 shadow-el-4 night:bg-night-card',
        )}
      >
        <div className="flex items-start justify-between gap-sp-3">
          <div className="flex flex-col gap-sp-1">
            <h2 className="text-fs-24 font-extrabold tracking-title text-slate-900 night:text-night-text">
              Custom charge
            </h2>
            <p className="text-fs-14 font-semibold text-slate-600 night:text-night-second">
              {seatLabel ? `For ${seatLabel} · ` : ''}on the bill, not on any ticket
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close without adding"
            className={cn(
              'flex size-touch-waiter shrink-0 items-center justify-center rounded-waiter',
              'border border-slate-200 bg-white text-slate-600 night:border-night-hairline night:bg-night-card night:text-night-second',
              'transition-[transform,box-shadow] duration-80 ease-standard',
              'active:scale-[0.97] active:shadow-pressed',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            <X aria-hidden="true" strokeWidth={2} className="size-6" />
          </button>
        </div>

        <label className="flex flex-col gap-sp-1">
          <span className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase night:text-night-second">
            Name on the bill
          </span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            maxLength={MAX_CUSTOM_NAME}
            placeholder="Corkage, broken glass…"
            readOnly={frozen}
            onChange={(event) => setName(event.target.value)}
            className={fieldClass}
          />
        </label>

        <label className="flex flex-col gap-sp-1">
          <span className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase night:text-night-second">
            Price each (LKR)
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={priceText}
            placeholder="1500"
            aria-invalid={priceProblem !== null}
            readOnly={frozen}
            onChange={(event) => setPriceText(event.target.value)}
            className={cn(fieldClass, 'tabular-nums')}
          />
          {priceProblem ? (
            <span role="status" className="text-fs-14 font-semibold text-occupied-ink night:text-amber-300">
              {priceProblem}
            </span>
          ) : null}
        </label>

        <div className="flex items-center justify-between gap-sp-3">
          <span className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase night:text-night-second">
            Quantity
          </span>
          <div className="flex items-center gap-sp-3">
            <button
              type="button"
              disabled={frozen || quantity <= 1}
              onClick={() => setQuantity((current) => Math.max(1, current - 1))}
              aria-label="One fewer"
              className={stepperClass}
            >
              <Minus aria-hidden="true" strokeWidth={2.5} className="size-6" />
            </button>
            <output
              aria-live="polite"
              className="min-w-12 text-center text-fs-24 font-extrabold tabular-nums text-slate-900 night:text-night-text"
            >
              {quantity}
            </output>
            <button
              type="button"
              disabled={frozen || quantity >= MAX_LINE_QUANTITY}
              onClick={() => setQuantity((current) => Math.min(MAX_LINE_QUANTITY, current + 1))}
              aria-label="One more"
              className={stepperClass}
            >
              <Plus aria-hidden="true" strokeWidth={2.5} className="size-6" />
            </button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-fs-14 font-semibold text-unavailable-ink night:text-red-300">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!ready || busy}
          className={cn(commitButtonClass, 'w-full disabled:opacity-40')}
        >
          {busy
            ? 'Adding…'
            : ready
              ? `Add to bill · ${lkrFromPaisa(pricePaisa! * quantity)}`
              : 'Add to bill'}
        </button>
      </form>
    </dialog>
  )
}

/**
 * "1500", "1,500" or "1500.50" → paisa; null when it is not a price this
 * accepts (empty, not a number, more than two decimals, ≤ 0, over the cap).
 */
function parsePricePaisa(text: string): number | null {
  const cleaned = text.replace(/,/g, '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const paisa = Math.round(Number(cleaned) * 100)
  if (!Number.isInteger(paisa) || paisa < 1 || paisa > MAX_CUSTOM_CHARGE_PAISA) return null
  return paisa
}
