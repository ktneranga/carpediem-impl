'use client'

import { useState } from 'react'
import { percentFromBp } from '@/lib/format'
import { cn } from '@/lib/utils'

const PRESETS = [0, 5, 10, 15, 20, 25]

/**
 * This order's discount (Teran, 2026-11-16), opened from the Discount row on
 * the order screen. Percent only; the service charge has its own switch.
 */
export function DiscountDialog({
  sessionId,
  discountBp,
  defaultDiscountBp,
  isOwnDiscount,
  onCancel,
  onSaved,
}: {
  sessionId: string
  /** What applies now: the order's own, or the default. */
  discountBp: number
  defaultDiscountBp: number
  /** The order has its own discount rather than following the default. */
  isOwnDiscount: boolean
  onCancel: () => void
  onSaved: (discountBp: number | null) => void
}) {
  const [percent, setPercent] = useState(String(discountBp / 100))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const valid = /^\d{1,3}(\.\d{1,2})?$/.test(percent.trim()) && Number(percent) <= 100
  const bp = valid ? Math.round(Number(percent) * 100) : null

  async function save() {
    if (bp === null) {
      setError('A percent from 0 to 100')
      return
    }
    // Left on the default, it keeps following the default.
    const value = bp === defaultDiscountBp && !isOwnDiscount ? null : bp
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/sessions/${sessionId}/pricing`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ discountBp: value }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? 'Could not save the discount')
      }
      onSaved(value)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the discount')
      setSaving(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="discount-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex flex-col gap-sp-1">
          <h2 id="discount-title" className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">
            Discount
          </h2>
          <p className="text-fs-14 text-slate-600 night:text-night-second">
            For this order. Taken off before service charge and tax. Bills already recorded keep their prices.
          </p>
        </div>

        <div className="flex flex-wrap gap-sp-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={bp === preset * 100}
              onClick={() => setPercent(String(preset))}
              className={cn(
                'h-11 min-w-14 rounded-control border px-sp-3 text-fs-16 font-bold',
                bp === preset * 100
                  ? 'border-brand-800 bg-brand-800 text-white'
                  : 'border-slate-200 bg-white text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              {preset === 0 ? 'None' : `${preset}%`}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-sp-2">
          <span className="text-fs-14 text-slate-600 night:text-night-second">Other</span>
          <input
            inputMode="decimal"
            value={percent}
            onChange={(event) => setPercent(event.target.value.replace(/[^\d.]/g, ''))}
            className="h-11 w-24 rounded-control border border-slate-300 px-sp-3 text-right text-fs-16 tabular-nums text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text"
          />
          <span className="text-fs-16 font-bold text-slate-900 night:text-night-text">%</span>
        </label>
        {defaultDiscountBp > 0 ? (
          <span className="text-fs-12 text-slate-500 night:text-night-muted">
            Restaurant default: {percentFromBp(defaultDiscountBp)}%
          </span>
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
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || bp === null}
            onClick={() => void save()}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter bg-brand-800 text-fs-16 font-bold text-white shadow-el-2',
              'active:scale-[0.98] disabled:opacity-60',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            {saving ? 'Saving…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
