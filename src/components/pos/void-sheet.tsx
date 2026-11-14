'use client'

import { Minus, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { commitButtonClass } from '@/components/pos/action-strip-chrome'
import { PINPad } from '@/components/pos/pin-pad'
import { newId } from '@/components/pos/use-staged-round'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BILL_CANCEL_REASONS, MAX_VOID_NOTE, VOID_REASONS, type VoidResult } from '@/types/voids'

/** What the sheet acts on: units of a sent line, or a whole unpaid bill. */
export type VoidSheetTarget =
  | {
      mode: 'void'
      orderEventId: string
      name: string
      unitPricePaisa: number | null
      /** Units neither billed nor voided: the stepper's ceiling. */
      maxQuantity: number
    }
  | { mode: 'cancel-bill'; billId: string; label: string; totalPaisa: number }

type Failure = { code: string; message: string; unitsLeft?: number }

async function post<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: Failure }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => null)
    if (response.ok && payload?.success) return { ok: true, data: payload.data as T }
    return {
      ok: false,
      error: {
        code: payload?.error?.code ?? 'NETWORK',
        message: payload?.error?.message ?? 'Could not reach the server. Try again.',
        unitsLeft: typeof payload?.error?.unitsLeft === 'number' ? payload.error.unitsLeft : undefined,
      },
    }
  } catch {
    return { ok: false, error: { code: 'NETWORK', message: 'Could not reach the server. Try again.' } }
  }
}

/**
 * Void a sent item, or cancel an unpaid bill (Story 7.5).
 *
 * ── Approval on the same device ──────────────────────────────────────────────
 * A waiter (`needsApproval`) gets a PIN pad after the reason: someone with the
 * owner role, or anyone allowed to approve voids (Story 10.6), types their PIN and both names are recorded. The waiter stays
 * signed in. The server decides independently: a 403 `APPROVAL_REQUIRED` (the
 * role changed mid-shift) also opens the pad, so showing it here is
 * convenience, never the guard.
 *
 * ── Closing after something changed is `onDone`, however it is closed ────────
 * Once the server has said the line's units changed (409), or a void was saved
 * without its ticket, the screen behind is stale; X, Escape and a backdrop tap
 * then refresh it too. Ported from the reverted 7.3 comp sheet.
 *
 * ── One id per sheet ─────────────────────────────────────────────────────────
 * `requestId` lets the server answer a retry with the void it already wrote, so
 * a lost answer and a second tap is never a second void or a second ticket.
 */
export function VoidSheet({
  sessionId,
  target,
  needsApproval,
  onCancel,
  onDone,
}: {
  sessionId: string
  target: VoidSheetTarget
  needsApproval: boolean
  onCancel: () => void
  onDone: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const pressStartedOnBackdrop = useRef(false)
  const isVoid = target.mode === 'void'
  const reasons: readonly string[] = isVoid ? VOID_REASONS : BILL_CANCEL_REASONS
  const [reason, setReason] = useState<string | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [note, setNote] = useState('')
  const [step, setStep] = useState<'details' | 'approve' | 'tell-kitchen'>('details')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)
  const [requestId] = useState(newId)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [maxQuantity, setMaxQuantity] = useState(isVoid ? target.maxQuantity : 1)
  const close = needsRefresh ? onDone : onCancel

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const needsNote = reason === 'Other'
  const ready = reason !== null && (!needsNote || note.trim().length > 0) && (!isVoid || maxQuantity > 0)
  const amountPaisa = isVoid ? (target.unitPricePaisa === null ? null : target.unitPricePaisa * quantity) : target.totalPaisa

  async function save(approverPin?: string) {
    setBusy(true)
    setError(null)
    setPinError(null)
    const shared = {
      reason,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(approverPin ? { approverPin } : {}),
    }
    const result = isVoid
      ? await post<VoidResult>(`/api/sessions/${sessionId}/voids`, {
          ...shared,
          orderEventId: target.orderEventId,
          quantity,
          requestId,
        })
      : await post<{ billId: string }>(`/api/bills/${target.billId}/cancel`, shared)
    setBusy(false)

    if (result.ok) {
      // A void that could not queue its ticket must not close silently: the
      // kitchen is still cooking it.
      if (isVoid) {
        const saved = result.data as VoidResult
        if (saved.ticketNeeded && !saved.ticketQueued) {
          setNeedsRefresh(true)
          setStep('tell-kitchen')
          return
        }
      }
      onDone()
      return
    }
    const code = result.error.code
    if (code === 'APPROVAL_REQUIRED') {
      setStep('approve')
      return
    }
    if (code === 'INVALID_PIN' || code === 'PIN_LOCKED') {
      setStep('approve')
      setPinError(result.error.message)
      return
    }
    // A double tap of Cancel bill whose first answer was lost: it is done.
    if (code === 'BILL_CANCELLED') {
      onDone()
      return
    }
    if (code === 'NOT_ENOUGH_UNITS' && result.error.unitsLeft !== undefined) {
      const left = result.error.unitsLeft
      setMaxQuantity(left)
      setQuantity((current) => Math.max(1, Math.min(current, left)))
      setNeedsRefresh(true)
    }
    if (code === 'SESSION_CLOSED' || code === 'BILL_HAS_PAYMENTS') setNeedsRefresh(true)
    setStep('details')
    setError(result.error.message)
  }

  const title = step === 'approve' ? 'Owner approval' : isVoid ? 'Void item' : 'Cancel bill'
  const subject = isVoid ? target.name : target.label

  const control = cn(
    'border border-slate-200 bg-white text-slate-900',
    'night:border-night-hairline night:bg-night-card night:text-night-text',
  )
  const stepperClass = cn(
    'flex size-touch-waiter shrink-0 items-center justify-center rounded-waiter',
    control,
    'transition-[transform,box-shadow] duration-80 ease-standard',
    'active:scale-[0.97] active:shadow-pressed',
    'disabled:opacity-40 disabled:active:scale-100',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )
  const label = 'text-fs-12 font-semibold tracking-micro text-slate-600 uppercase night:text-night-second'

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
      onPointerDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressStartedOnBackdrop.current && !busy) close()
        pressStartedOnBackdrop.current = false
      }}
      className={cn(
        'fixed top-0 left-0 m-0 h-app w-app max-h-none max-w-none p-sp-4',
        'flex items-center justify-center bg-transparent',
        'backdrop:bg-slate-900/50',
      )}
    >
      <div
        className={cn(
          'flex max-h-full w-full max-w-2xl flex-col gap-sp-4 overflow-y-auto',
          'rounded-card bg-white p-sp-4 shadow-el-4 night:bg-night-card',
        )}
      >
        <div className="flex items-start justify-between gap-sp-3">
          <div className="flex flex-col gap-sp-1">
            <h2 className="text-fs-24 font-extrabold tracking-title text-slate-900 night:text-night-text">{title}</h2>
            <p className="text-fs-14 font-semibold text-slate-600 night:text-night-second">
              {subject}
              {!isVoid ? ` · ${lkrFromPaisa(target.totalPaisa)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label={step === 'tell-kitchen' ? 'Close' : 'Close without saving'}
            className={cn(
              'flex size-touch-waiter shrink-0 items-center justify-center rounded-waiter',
              control,
              'text-slate-600 night:text-night-second',
              'transition-[transform,box-shadow] duration-80 ease-standard',
              'active:scale-[0.97] active:shadow-pressed',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            <X aria-hidden="true" strokeWidth={2} className="size-6" />
          </button>
        </div>

        {step === 'tell-kitchen' ? (
          <>
            <p role="alert" className="text-fs-16 font-bold text-unavailable-ink night:text-red-300">
              Voided, but no void ticket printed. Tell the kitchen to stop {subject}.
            </p>
            <button type="button" onClick={onDone} className={cn(commitButtonClass, 'w-full')}>
              Done
            </button>
          </>
        ) : step === 'approve' ? (
          <div className="flex flex-col items-center gap-sp-3">
            <p className="text-fs-14 font-semibold text-slate-600 night:text-night-second">
              {isVoid ? `Void ${quantity} × ${subject}` : `Cancel ${subject}`}
              {amountPaisa !== null ? ` · ${lkrFromPaisa(amountPaisa)}` : ''}
            </p>
            <PINPad
              label="Approver PIN"
              hint="Your own sign-in stays as it is"
              error={pinError}
              disabled={busy}
              onSubmit={(pin) => void save(pin)}
            />
          </div>
        ) : (
          <>
            <fieldset className="flex flex-col gap-sp-2">
              <legend className={cn('mb-sp-1', label)}>Reason</legend>
              <div className="flex flex-wrap gap-sp-2">
                {reasons.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    aria-pressed={reason === entry}
                    disabled={busy}
                    onClick={() => setReason(entry)}
                    className={cn(
                      'h-touch-waiter rounded-waiter border px-sp-4 text-fs-16 font-bold',
                      'transition-[transform,box-shadow] duration-80 ease-standard active:scale-[0.97]',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      reason === entry ? 'border-brand-500 bg-brand-500 text-white' : control,
                    )}
                  >
                    {entry}
                  </button>
                ))}
              </div>
              <p className="text-fs-14 text-slate-600 night:text-night-second">
                {isVoid
                  ? 'Not charged, and the kitchen gets a VOID ticket.'
                  : 'The items go back on the order. Fix them, then print a new bill.'}
              </p>
            </fieldset>

            {isVoid ? (
              maxQuantity > 0 ? (
                <div className="flex items-center justify-between gap-sp-3">
                  <span className={label}>How many (of {maxQuantity})</span>
                  <div className="flex items-center gap-sp-3">
                    <button
                      type="button"
                      disabled={busy || quantity <= 1}
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
                      disabled={busy || quantity >= maxQuantity}
                      onClick={() => setQuantity((current) => Math.min(maxQuantity, current + 1))}
                      aria-label="One more"
                      className={stepperClass}
                    >
                      <Plus aria-hidden="true" strokeWidth={2.5} className="size-6" />
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-fs-14 font-semibold text-unavailable-ink night:text-red-300">
                  Nothing left to void on this line: it is billed or already voided.
                </p>
              )
            ) : null}

            <label className="flex flex-col gap-sp-1">
              <span className={label}>{needsNote ? 'Note (required)' : 'Note (optional)'}</span>
              <input
                type="text"
                value={note}
                maxLength={MAX_VOID_NOTE}
                placeholder="What happened"
                readOnly={busy}
                onChange={(event) => setNote(event.target.value)}
                className={cn(
                  'h-touch-waiter rounded-control px-sp-3 text-fs-16 placeholder:text-slate-600',
                  control,
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                )}
              />
            </label>

            {error ? (
              <p role="alert" className="text-fs-14 font-semibold text-unavailable-ink night:text-red-300">
                {error}
              </p>
            ) : null}
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => (needsApproval ? setStep('approve') : void save())}
              className={cn(commitButtonClass, 'w-full disabled:opacity-40')}
            >
              {busy
                ? 'Saving…'
                : reason === null
                  ? 'Choose a reason'
                  : needsNote && !note.trim()
                    ? 'Add a note'
                    : isVoid
                      ? `Void ${quantity}${amountPaisa !== null ? ` · ${lkrFromPaisa(amountPaisa)}` : ''}`
                      : `Cancel bill · ${lkrFromPaisa(target.totalPaisa)}`}
            </button>
          </>
        )}
      </div>
    </dialog>
  )
}
