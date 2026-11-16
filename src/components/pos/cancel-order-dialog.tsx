'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { MAX_VOID_NOTE, ORDER_CANCEL_REASONS } from '@/types/voids'

/**
 * Cancel a whole order (Teran, 2026-11-16): every unpaid item is voided, the
 * kitchen and bar get VOID tickets, and the table is freed. Needs a reason;
 * the dashboard lists it under "Unclosed & corrections".
 */
export function CancelOrderDialog({
  sessionId,
  label,
  onCancel,
  onDone,
}: {
  sessionId: string
  /** "Table 4", "Bar tab 2". */
  label: string
  onCancel: () => void
  onDone: () => void
}) {
  const [reason, setReason] = useState<(typeof ORDER_CANCEL_REASONS)[number] | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = reason !== null && (reason !== 'Other' || note.trim() !== '') && !busy

  async function submit() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/sessions/${sessionId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason, note: note.trim() === '' ? null : note.trim() }),
      })
      if (response.ok) {
        onDone()
        return
      }
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      setError(body?.error?.message ?? 'Could not cancel the order')
    } catch {
      setError('Could not reach the till. Check the connection and try again.')
    }
    setBusy(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-order-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex flex-col gap-sp-1">
          <h2 id="cancel-order-title" className="text-fs-24 font-extrabold text-unavailable-ink night:text-red-300">
            Cancel the order on {label}?
          </h2>
          <p className="text-fs-14 text-slate-600 night:text-night-second">
            Every item is voided, the kitchen and bar get VOID tickets, and the table is freed. Nothing is owed.
          </p>
        </div>

        <div className="flex flex-col gap-sp-2" role="radiogroup" aria-label="Reason">
          {ORDER_CANCEL_REASONS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={reason === option}
              onClick={() => setReason(option)}
              className={cn(
                'h-touch-standard rounded-control border px-sp-3 text-left text-fs-16 font-semibold',
                reason === option
                  ? 'border-brand-800 bg-brand-800 text-white'
                  : 'border-slate-200 bg-white text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              {option}
            </button>
          ))}
        </div>

        {reason !== null ? (
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">
              {reason === 'Other' ? 'Why?' : 'Note (optional)'}
            </span>
            <input
              value={note}
              maxLength={MAX_VOID_NOTE}
              onChange={(event) => setNote(event.target.value)}
              className="h-touch-waiter rounded-waiter border border-slate-300 px-sp-3 text-fs-16 text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text"
            />
          </label>
        ) : null}

        {error ? (
          <p role="alert" className="text-fs-14 font-semibold text-unavailable-band night:text-red-400">
            {error}
          </p>
        ) : null}

        <div className="flex gap-sp-3">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter border border-slate-200 bg-white text-fs-16 font-bold text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text',
              'active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            Keep the order
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void submit()}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter bg-unavailable-band text-fs-16 font-bold text-white shadow-el-2',
              'active:scale-[0.98] disabled:opacity-60',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            {busy ? 'Cancelling…' : 'Cancel order'}
          </button>
        </div>
      </div>
    </div>
  )
}
