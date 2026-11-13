'use client'

import { CirclePlus } from 'lucide-react'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

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
  onAddCharge,
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
  /**
   * Opens the custom-charge sheet (Story 4.9). Only for staff allowed to add
   * one; absent, the icon is not drawn. A small icon beside the total it
   * changes, not a full-width button: it is rare and owner-only, and the order
   * column's space belongs to the order (Teran, 2026-11-02).
   */
  onAddCharge?: () => void
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
    <div className="flex shrink-0 flex-col gap-sp-2 border-t border-slate-200 bg-white px-sp-4 py-sp-3 night:border-night-hairline night:bg-night-card">
      <Row label="Sent" value={sentPaisa} />
      <Row label="Not sent" value={notSentPaisa} />
      {serviceChargeBp > 0 ? (
        <Row label={`Service ${servicePercentLabel}%`} value={servicePaisa} />
      ) : null}
      {taxRatePercent > 0 ? <Row label={`Tax ${taxRatePercent}%`} value={taxPaisa} /> : null}

      <div className="flex items-baseline justify-between gap-sp-3 border-t border-slate-200 pt-sp-2 night:border-night-hairline">
        <span className="flex items-center gap-sp-1">
          <span className="text-fs-16 font-bold text-slate-900 night:text-night-text">Table total</span>
          {onAddCharge ? (
            <button
              type="button"
              onClick={onAddCharge}
              aria-label="Add custom charge"
              title="Add custom charge"
              className={cn(
                // A 44px target around a 20px glyph; the negative margin keeps
                // the row the height of its text.
                '-my-sp-3 flex size-touch-standard items-center justify-center rounded-pill text-slate-600 night:text-night-second',
                'transition-[transform,background-color] duration-80 ease-standard',
                'hover:bg-slate-100 active:scale-[0.94] active:bg-slate-100 night:hover:bg-night-raised night:active:bg-night-raised',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              <CirclePlus aria-hidden="true" strokeWidth={2} className="size-5" />
            </button>
          ) : null}
        </span>
        <span className="text-fs-24 font-extrabold tabular-nums text-slate-900 night:text-night-text">
          {lkrFromPaisa(totalPaisa)}
        </span>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-sp-3">
      <span className="text-fs-14 text-slate-600 night:text-night-second">{label}</span>
      <span className="text-fs-14 font-semibold tabular-nums text-slate-900 night:text-night-text">
        {lkrFromPaisa(value)}
      </span>
    </div>
  )
}
