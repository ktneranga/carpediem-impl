'use client'

import { computeBillTotals } from '@/lib/bill-math'
import { lkrFromPaisa } from '@/lib/format'

/**
 * What the table is standing at, at the foot of the order column.
 *
 * ── This now previews the BILL (changed 2026-10-16) ──────────────────────────
 * It used to total the STAGED round only, and said so: "This round". Story
 * 6.2's Trap 3 argued it must never grow a service line, because the number it
 * showed was not what anyone would pay.
 *
 * The new design reverses that, and the reversal is sound — but only because
 * it goes all the way. The panel now shows Sent, Not sent, Service and Table
 * total, which IS what the guest will pay, and it is computed by the very
 * function the bill uses (`computeBillTotals`, moved to `@/lib/bill-math` for
 * exactly this). The old failure mode was a figure that looked like a bill and
 * was not. Showing part of the bill would have been worse than either.
 *
 * ── The bug this fixes ───────────────────────────────────────────────────────
 * The subtotal counted ONLY unsent lines. A waiter reading the total to a
 * guest after sending two rounds was reading the third round's price. Sent and
 * unsent are now separate rows AND both are in the total.
 *
 * ── Still not the bill itself ────────────────────────────────────────────────
 * No comps are applied here — nothing writes them until Epic 7 — and a bill
 * generated later recomputes from `order_events` rather than trusting this.
 * This is a preview computed the same way, not a source of truth.
 */
export function OrderSummary({
  sentPaisa,
  unsentPaisa,
  serviceChargeBp,
  taxBp,
  hasTableService,
}: {
  /** Priced from committed `order_events` — what is already in the kitchen. */
  sentPaisa: number
  /** The staged round, not yet sent. */
  unsentPaisa: number
  serviceChargeBp: number
  taxBp: number
  /** Whether the session has tables attached, which is what earns the charge. */
  hasTableService: boolean
}) {
  const subtotalPaisa = sentPaisa + unsentPaisa

  // The SAME function the bill uses. Integer paisa, service on the subtotal,
  // tax on subtotal + service, each rounded once.
  const totals = computeBillTotals({
    subtotalPaisa,
    serviceChargeBp,
    taxBp,
    hasTableService,
  })

  const rows: { label: string; value: number; muted?: boolean }[] = [
    { label: 'Sent', value: sentPaisa },
    { label: 'Not sent', value: unsentPaisa, muted: unsentPaisa === 0 },
  ]
  if (totals.serviceChargePaisa > 0) {
    rows.push({
      label: `Service ${(totals.serviceChargeBp / 100).toFixed(totals.serviceChargeBp % 100 === 0 ? 0 : 1)}%`,
      value: totals.serviceChargePaisa,
    })
  }
  if (totals.taxPaisa > 0) {
    rows.push({
      label: `Tax ${(totals.taxBp / 100).toFixed(totals.taxBp % 100 === 0 ? 0 : 1)}%`,
      value: totals.taxPaisa,
    })
  }

  return (
    <div className="flex shrink-0 flex-col gap-sp-2 border-t border-slate-200 bg-white px-sp-4 py-sp-3">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-sp-3">
          <span className="text-fs-14 text-slate-600">{row.label}</span>
          <span
            className={`text-fs-14 font-semibold tabular-nums ${
              row.muted ? 'text-slate-400' : 'text-slate-900'
            }`}
          >
            {lkrFromPaisa(row.value)}
          </span>
        </div>
      ))}

      <div className="flex items-baseline justify-between gap-sp-3 border-t border-slate-200 pt-sp-2">
        <span className="text-fs-16 font-bold text-slate-900">Table total</span>
        <span className="text-fs-24 font-extrabold tabular-nums text-slate-900">
          {lkrFromPaisa(totals.totalPaisa)}
        </span>
      </div>
    </div>
  )
}
