'use client'

import { LockOpen, Receipt } from 'lucide-react'
import { Panel, tone } from '@/components/manage/dashboard/panel'
import { lkrFromPaisa } from '@/lib/format'
import type { Insights } from '@/server/services/insights.service'
import { cn } from '@/lib/utils'

/**
 * What End of day (Story 9.5) showed that the rest of the dashboard did not —
 * merged here 2026-11-14 (Teran): the sales breakdown as the printed slip
 * shows it, and on a single day, the no-sale drawer openings. The open and
 * closed-unpaid orders are in "Unclosed & corrections"; the count is the Cash
 * gap tile; the methods are the Payment split.
 */

const money = (paisa: number) => `${paisa < 0 ? '-' : ''}${lkrFromPaisa(Math.abs(paisa))}`
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const REASONS = {
  change: 'Change',
  float: 'Float',
  other: 'Other',
  pay_in: 'Pay in',
  paid_out: 'Paid out',
  cash_drop: 'Cash drop',
} as const

export function SalesBreakdown({ data }: { data: Insights }) {
  const s = data.sales
  const unpaid = s.billedPaisa - s.paid.totalPaisa
  return (
    <Panel title="Sales" icon={Receipt} subtitle="as on the printed slip" minHeight="min-h-40">
      <div className="flex flex-col">
        <Row label="Orders" value={s.orders.toLocaleString('en-US')} />
        <Row label="Items" value={money(s.itemsPaisa)} />
        {s.compsPaisa !== 0 ? <Row label="Comps" value={money(-Math.abs(s.compsPaisa))} /> : null}
        <Row label="Subtotal" value={money(s.subtotalPaisa)} />
        {s.discountPaisa !== 0 ? <Row label="Discounts" value={money(-s.discountPaisa)} /> : null}
        <Row label="Service charge" value={money(s.serviceChargePaisa)} />
        {s.serviceWaivedPaisa !== 0 ? <Row label="Service charge waived" value={money(s.serviceWaivedPaisa)} /> : null}
        <Row label="Tax" value={money(s.taxPaisa)} />
        <Row label="Total billed" value={money(s.billedPaisa)} strong />
        <Row label="Paid" value={money(s.paid.totalPaisa)} />
        {unpaid !== 0 ? <Row label="Not paid yet" value={money(unpaid)} warn /> : null}
      </div>
    </Panel>
  )
}

export function NoSales({ openings }: { openings: NonNullable<Insights['noSales']> }) {
  return (
    <Panel title="Cash drawer" icon={LockOpen} subtitle="float, cash in and out, openings without a payment" minHeight="min-h-40">
      {openings.length === 0 ? (
        <p className={cn('flex flex-1 items-center text-fs-14', tone.second)}>The drawer was only opened for cash payments.</p>
      ) : (
        <ul className="flex max-h-72 flex-col overflow-y-auto">
          {openings.map((opening, index) => (
            <li key={index} className={cn('flex min-h-10 flex-wrap items-center gap-x-sp-3 border-t py-sp-1', tone.hairline)}>
              <span className={cn('w-12 text-fs-14 font-bold tabular-nums', tone.ink)}>{time(opening.openedAt)}</span>
              <span className={cn('text-fs-14', tone.ink)}>{opening.staffName}</span>
              <span className={cn('min-w-0 flex-1 text-fs-14', tone.second)}>
                {opening.reason === 'other' ? opening.note : REASONS[opening.reason]}
                {opening.reason !== 'other' && opening.note ? ` · ${opening.note}` : ''}
              </span>
              {opening.amountPaisa != null ? (
                <span className={cn('text-fs-14 font-bold tabular-nums', opening.amountPaisa < 0 ? tone.bad : tone.ink)}>
                  {opening.amountPaisa > 0 ? '+' : ''}
                  {money(opening.amountPaisa)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Row({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-h-9 items-center justify-between gap-sp-3 border-t text-fs-14',
        tone.hairline,
        strong ? cn('font-extrabold', tone.ink) : tone.second,
        warn && 'font-semibold text-amber-900 night:text-amber-300',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}
