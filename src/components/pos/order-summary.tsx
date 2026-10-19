'use client'

import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * What this round comes to, at the foot of the order column.
 *
 * ── It totals the STAGED round, not the bill ─────────────────────────────────
 * Deliberately, and the label says so. A waiter reading a figure off this
 * screen to a guest must not be reading a number that excludes three rounds
 * already in the kitchen. The session total is a bill, Epic 6 builds it, and it
 * has to reconcile against `order_events` rather than against whatever happens
 * to be on one device's screen.
 *
 * ── The tax line appears only when a rate is configured ──────────────────────
 * `tenant_config.tax_rate_percent` defaults to 0 and Carpe Diem has not set
 * one, so the row is normally absent rather than rendering "Tax 0% · LKR 0".
 *
 * There is NO service-charge column in the schema. The design showed
 * "Service 10%", which is a different thing from tax and belongs with billing —
 * logged against Epic 6 rather than invented here, because a percentage added
 * to a guest's total is not a detail to guess at.
 */
export function OrderSummary({
  lineCount,
  subtotalPaisa,
  taxRatePercent,
}: {
  lineCount: number
  subtotalPaisa: number
  taxRatePercent: number
}) {
  // Integer paisa throughout, rounded once at the end. Computing tax in rupees
  // and converting back is how a bill ends up a cent out from its own lines.
  const taxPaisa = taxRatePercent > 0 ? Math.round((subtotalPaisa * taxRatePercent) / 100) : 0
  const totalPaisa = subtotalPaisa + taxPaisa

  return (
    <div className="flex shrink-0 flex-col gap-sp-2 border-t border-slate-200 bg-white px-sp-4 py-sp-3">
      <div className="flex items-baseline justify-between gap-sp-3">
        <span className="text-fs-14 text-slate-600">
          Subtotal · {lineCount} line{lineCount === 1 ? '' : 's'}
        </span>
        <span className="text-fs-14 font-semibold tabular-nums text-slate-900">
          {lkrFromPaisa(subtotalPaisa)}
        </span>
      </div>

      {taxRatePercent > 0 ? (
        <div className="flex items-baseline justify-between gap-sp-3">
          <span className="text-fs-14 text-slate-600">Tax {taxRatePercent}%</span>
          <span className="text-fs-14 font-semibold tabular-nums text-slate-900">
            {lkrFromPaisa(taxPaisa)}
          </span>
        </div>
      ) : null}

      <div className="flex items-baseline justify-between gap-sp-3 border-t border-slate-200 pt-sp-2">
        <span className="text-fs-16 font-bold text-slate-900">This round</span>
        <span className={cn('text-fs-24 font-extrabold tabular-nums text-slate-900')}>
          {lkrFromPaisa(totalPaisa)}
        </span>
      </div>
    </div>
  )
}
