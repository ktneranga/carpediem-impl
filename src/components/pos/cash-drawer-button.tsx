'use client'

import { useState } from 'react'
import { Banknote } from 'lucide-react'
import { cn } from '@/lib/utils'

type Reason = 'change' | 'float' | 'other'

const REASONS: { value: Reason; label: string }[] = [
  { value: 'change', label: 'Change' },
  { value: 'float', label: 'Float' },
  { value: 'other', label: 'Other' },
]

/**
 * Open the cash drawer with no sale (Story 6.7, FR72) — owner only.
 *
 * An icon, not a labelled button: a no-sale is rare and only the owner has it,
 * so it sits small beside the staff badge and out of a waiter's way (Teran's
 * rule: a control's weight matches how often it is used). A cash payment opens
 * the drawer by itself; this is only for change, the float, or another reason
 * someone types.
 */
export function CashDrawerButton({ onOpened }: { onOpened: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label="Open cash drawer"
        title="Open cash drawer"
        onClick={() => setOpen(true)}
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-waiter text-slate-500 night:text-night-muted',
          'hover:bg-slate-100 active:scale-[0.96] night:hover:bg-night-raised',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        <Banknote aria-hidden="true" className="size-5" />
      </button>
      {open ? (
        <OpenDrawerDialog
          onCancel={() => setOpen(false)}
          onOpened={() => {
            setOpen(false)
            onOpened()
          }}
        />
      ) : null}
    </>
  )
}

function OpenDrawerDialog({ onCancel, onOpened }: { onCancel: () => void; onOpened: () => void }) {
  const [reason, setReason] = useState<Reason | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsNote = reason === 'other'
  const ready = reason !== null && (!needsNote || note.trim() !== '') && !sending

  async function submit() {
    if (!ready || reason === null) return
    setSending(true)
    setError(null)
    try {
      const response = await fetch('/api/cash-drawer/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason, note: needsNote ? note.trim() : null }),
      })
      if (response.ok) {
        onOpened()
        return
      }
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      setError(body?.error?.message ?? 'Could not open the drawer')
    } catch {
      setError('Could not reach the till. Check the connection and try again.')
    }
    setSending(false)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="open-drawer-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex flex-col gap-sp-1">
          <span className="text-fs-12 font-bold tracking-micro text-slate-500 uppercase night:text-night-muted">No sale</span>
          <h2 id="open-drawer-title" className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">
            Open the cash drawer?
          </h2>
          <p className="text-fs-14 text-slate-600 night:text-night-second">Every opening is recorded with your name and the reason.</p>
        </div>

        <div className="flex gap-sp-2" role="radiogroup" aria-label="Reason">
          {REASONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={reason === option.value}
              onClick={() => setReason(option.value)}
              className={cn(
                'h-touch-waiter flex-1 rounded-waiter border text-fs-16 font-bold',
                reason === option.value
                  ? 'border-brand-800 bg-brand-800 text-white'
                  : 'border-slate-200 bg-white text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {needsNote ? (
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Why?</span>
            <input
              autoFocus
              value={note}
              maxLength={120}
              onChange={(event) => setNote(event.target.value)}
              className="h-touch-waiter rounded-waiter border border-slate-300 px-sp-3 text-fs-16 text-slate-900 night:border-night-hairline night:text-night-text"
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
              'active:scale-[0.98]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={submit}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter bg-brand-800 text-fs-16 font-bold text-white shadow-el-2',
              'active:scale-[0.98] disabled:opacity-60',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            {sending ? 'Opening…' : 'Open drawer'}
          </button>
        </div>
      </div>
    </div>
  )
}
