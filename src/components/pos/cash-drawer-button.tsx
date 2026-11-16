'use client'

import { useState } from 'react'
import { Banknote } from 'lucide-react'
import { cn } from '@/lib/utils'

type Reason = 'float' | 'pay_in' | 'paid_out' | 'cash_drop' | 'change' | 'other'

/**
 * Why the drawer opens (Teran, 2026-11-16). Cash IN: the morning float, more
 * change during the day. Cash OUT: an expense paid from the drawer, or cash
 * moved to the safe — both need a note. Change and Other move no money.
 */
const REASONS: { value: Reason; label: string; hint: string; money: 'in' | 'out' | null }[] = [
  // Pay in and Paid out are not offered (Teran, 2026-11-16): recorded as Other.
  // The server still accepts them, so old rows and the day's figures read.
  // Float is every cash IN, Cash drop every cash OUT — an expense too, named in
  // its note (Teran, 2026-11-16). Other, Pay in and Paid out are not offered;
  // the server still reads them, so earlier rows count in the day's figures.
  { value: 'float', label: 'Float', hint: 'Cash put in: start of day, more change', money: 'in' },
  { value: 'cash_drop', label: 'Cash drop', hint: 'Cash taken out: to the safe, an expense', money: 'out' },
  { value: 'change', label: 'Change', hint: 'Swap notes, no money in or out', money: null },
]

/** Which reasons this person may use: the route decides again. */
function allowedReasons({ isOwner, canOpenForChange }: { isOwner: boolean; canOpenForChange: boolean }) {
  return REASONS.filter((reason) =>
    reason.money === 'in' ? true : reason.money === 'out' ? isOwner : canOpenForChange,
  )
}

/**
 * The cash drawer (Story 6.7; cash in/out, Teran 2026-11-16). An icon, not a
 * labelled button: it is used a few times a day, so it sits small beside the
 * staff badge. A cash payment opens the drawer by itself; this is for the
 * float, cash in or out, and change.
 */
export function CashDrawerButton({
  onOpened,
  isOwner,
  canOpenForChange,
}: {
  onOpened: () => void
  isOwner: boolean
  /** `open_cash_drawer`: may open for change or another reason with no money. */
  canOpenForChange: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label="Cash drawer"
        title="Cash drawer: float, cash in or out"
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
        <CashDrawerDialog
          reasons={allowedReasons({ isOwner, canOpenForChange })}
          isOwner={isOwner}
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

/**
 * The morning prompt (Teran, 2026-11-16): until today's float is recorded, the
 * floor asks for it once per tablet session. "Not now" hides it until the next
 * sign-in; the end-of-day count is only right once a float is recorded.
 */
export function OpeningFloatPrompt({ onDone, onLater }: { onDone: () => void; onLater: () => void }) {
  return (
    <CashDrawerDialog
      reasons={REASONS.filter((reason) => reason.value === 'float')}
      title="Opening float"
      intro="How much cash is going into the drawer to start the day? It is compared with the count at close."
      cancelLabel="Not now"
      onCancel={onLater}
      onOpened={onDone}
    />
  )
}

function CashDrawerDialog({
  reasons,
  title = 'Cash drawer',
  intro = 'Every opening is recorded with your name, the reason and the amount.',
  cancelLabel = 'Cancel',
  isOwner = false,
  onCancel,
  onOpened,
}: {
  reasons: typeof REASONS
  /** Only the owner may take money out under Other. */
  isOwner?: boolean
  title?: string
  intro?: string
  cancelLabel?: string
  onCancel: () => void
  onOpened: () => void
}) {
  const [reason, setReason] = useState<Reason | null>(reasons.length === 1 ? reasons[0]!.value : null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  /** Other with an amount (Teran, 2026-11-16): which way the money went. */
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const chosen = REASONS.find((option) => option.value === reason) ?? null
  const isOther = reason === 'other'
  const needsAmount = chosen?.money != null
  // Other: the amount is optional, and only sent when typed.
  const sendsAmount = needsAmount || (isOther && amount !== '')
  const needsNote = isOther || chosen?.money === 'out'
  const rupees = Number(amount)
  const amountOk = !sendsAmount || (/^\d{1,7}$/.test(amount) && rupees > 0)
  const ready = reason !== null && amountOk && (!needsNote || note.trim() !== '') && !sending

  async function submit() {
    if (!ready || reason === null) return
    setSending(true)
    setError(null)
    try {
      const response = await fetch('/api/cash-drawer/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason,
          amountPaisa: sendsAmount ? rupees * 100 : null,
          direction: isOther && sendsAmount ? direction : null,
          note: note.trim() === '' ? null : note.trim(),
        }),
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
      <div className="flex w-full max-w-lg flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex flex-col gap-sp-1">
          <h2 id="open-drawer-title" className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">
            {title}
          </h2>
          <p className="text-fs-14 text-slate-600 night:text-night-second">{intro}</p>
        </div>

        {reasons.length > 1 ? (
          <div className="grid grid-cols-2 gap-sp-2" role="radiogroup" aria-label="Reason">
            {reasons.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={reason === option.value}
                onClick={() => setReason(option.value)}
                className={cn(
                  'flex min-h-touch-waiter flex-col items-start justify-center rounded-waiter border px-sp-3 py-sp-2 text-left',
                  reason === option.value
                    ? 'border-brand-800 bg-brand-800 text-white'
                    : 'border-slate-200 bg-white text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                )}
              >
                <span className="text-fs-16 font-bold">
                  {option.money === 'in' ? '+ ' : option.money === 'out' ? '− ' : ''}
                  {option.label}
                </span>
                <span className={cn('text-fs-12', reason === option.value ? 'text-white/80' : 'text-slate-500 night:text-night-muted')}>
                  {option.hint}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {isOther ? (
          <div className="flex flex-col gap-sp-2">
            {isOwner ? (
              <div role="radiogroup" aria-label="Money" className="flex gap-1 rounded-control bg-slate-100 p-1 night:bg-night-raised">
                {([
                  ['in', '+ Into drawer'],
                  ['out', '− Out of drawer'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={direction === value}
                    onClick={() => setDirection(value)}
                    className={cn(
                      'h-11 flex-1 rounded-control text-fs-14 font-bold',
                      direction === value
                        ? 'bg-white text-brand-700 shadow-el-1 night:bg-night-card night:text-brand-300'
                        : 'text-slate-600 night:text-night-second',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <label className="flex flex-col gap-sp-1">
              <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">
                Amount (LKR) — leave empty if no money moved
              </span>
              <input
                inputMode="numeric"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/\D/g, '').slice(0, 7))}
                className="h-touch-waiter rounded-waiter border border-slate-300 px-sp-3 text-fs-20 font-bold tabular-nums text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text"
              />
            </label>
          </div>
        ) : null}

        {needsAmount ? (
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">
              {chosen?.money === 'out' ? 'Amount taken out (LKR)' : 'Amount put in (LKR)'}
            </span>
            <input
              autoFocus
              inputMode="numeric"
              value={amount}
              placeholder="10000"
              onChange={(event) => setAmount(event.target.value.replace(/\D/g, '').slice(0, 7))}
              className="h-touch-waiter rounded-waiter border border-slate-300 px-sp-3 text-fs-20 font-bold tabular-nums text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text"
            />
          </label>
        ) : null}

        {reason !== null && reason !== 'change' ? (
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">
              {needsNote ? 'What for?' : 'Note (optional)'}
            </span>
            <input
              value={note}
              maxLength={120}
              placeholder={reason === 'cash_drop' ? 'To the safe, or Gas bill' : ''}
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
              'active:scale-[0.98]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            {cancelLabel}
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
            {sending ? 'Opening…' : sendsAmount ? 'Record & open drawer' : 'Open drawer'}
          </button>
        </div>
      </div>
    </div>
  )
}
