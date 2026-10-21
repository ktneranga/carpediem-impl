'use client'

import { lkrFromPaisa } from '@/lib/format'

/**
 * What the table owes, at the foot of the order column.
 *
 * ── It totals the WHOLE table, not the staged round (2026-10-21) ─────────────
 * It used to total only what was staged, under the heading "This round", and
 * that was a reporting bug with a guest on the other side of it: after two
 * rounds a waiter asked "how much so far?" read out the third round's price.
 * The design splits it into the two numbers that answer the question
 * separately and then adds them up:
 *
 *   Sent         what the kitchen already has, priced as it was quoted
 *   Not sent     what is staged on this screen and nobody has made yet
 *   Service N%   on both, because the charge is on the bill, not on a round
 *   Table total  the figure a waiter can safely say out loud
 *
 * ── Still a PREVIEW, and it says so by not claiming otherwise ────────────────
 * This is not the bill. Epic 6 builds that from `order_events` on the server,
 * where comps and the service charge are recomputed and frozen onto
 * `bill_lines`. The two agree today because they apply the same rule to the
 * same prices; if they ever disagree, the BILL is right. Nothing here is
 * written anywhere.
 *
 * ── Rounded once, at the end ─────────────────────────────────────────────────
 * Integer paisa throughout. Computing the service charge per round and adding
 * the results is how a bill ends up a rupee out from its own lines.
 */
export function OrderSummary({
  sentPaisa,
  notSentPaisa,
  serviceChargeBp,
  taxRatePercent,
}: {
  /** Already with the kitchen, summed from the submitted rounds. */
  sentPaisa: number
  /** Staged on this screen and not yet sent. */
  notSentPaisa: number
  /**
   * `tenant_config.service_charge_bp`, in basis points — 1000 is 10%.
   *
   * Basis points, not a percent, because a half-percent is a real thing and
   * an integer column cannot hold one. The row is hidden at 0, which is the
   * default, so a restaurant that charges nothing shows nothing.
   */
  serviceChargeBp: number
  /** `tenant_config.tax_rate_percent`. Also hidden at 0, its default. */
  taxRatePercent: number
}) {
  const itemsPaisa = sentPaisa + notSentPaisa
  const servicePaisa =
    serviceChargeBp > 0 ? Math.round((itemsPaisa * serviceChargeBp) / 10_000) : 0
  const taxPaisa =
    taxRatePercent > 0 ? Math.round(((itemsPaisa + servicePaisa) * taxRatePercent) / 100) : 0
  const totalPaisa = itemsPaisa + servicePaisa + taxPaisa

  // Basis points read as a percent for the label: 1000 -> "10%", 750 -> "7.5%".
  const servicePercentLabel = (serviceChargeBp / 100)
    .toFixed(serviceChargeBp % 100 === 0 ? 0 : 1)
    .replace(/\.0$/, '')

  return (
    <div className="flex shrink-0 flex-col gap-sp-2 border-t border-slate-200 bg-white px-sp-4 py-sp-3">
      <Row label="Sent" value={sentPaisa} />
      <Row label="Not sent" value={notSentPaisa} />
      {serviceChargeBp > 0 ? (
        <Row label={`Service ${servicePercentLabel}%`} value={servicePaisa} />
      ) : null}
      {taxRatePercent > 0 ? <Row label={`Tax ${taxRatePercent}%`} value={taxPaisa} /> : null}

      <div className="flex items-baseline justify-between gap-sp-3 border-t border-slate-200 pt-sp-2">
        <span className="text-fs-16 font-bold text-slate-900">Table total</span>
        <span className="text-fs-24 font-extrabold tabular-nums text-slate-900">
          {lkrFromPaisa(totalPaisa)}
        </span>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-sp-3">
      <span className="text-fs-14 text-slate-600">{label}</span>
      <span className="text-fs-14 font-semibold tabular-nums text-slate-900">
        {lkrFromPaisa(value)}
      </span>
    </div>
  )
}
