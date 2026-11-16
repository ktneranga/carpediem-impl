'use client'

import { Receipt } from 'lucide-react'
import { Panel, tone } from '@/components/manage/dashboard/panel'
import { lkrFromPaisa } from '@/lib/format'
import type { Insights } from '@/server/services/insights.service'
import { cn } from '@/lib/utils'

/**
 * What End of day (Story 9.5) showed that the rest of the dashboard did not —
 * merged here 2026-11-14 (Teran): the sales breakdown as the printed slip
 * shows it. The open and closed-unpaid orders are in "Unclosed & corrections";
 * the drawer, its openings and the count are the Cash drawer card
 * (2026-11-16); the methods are the Payment split.
 */

const money = (paisa: number) => `${paisa < 0 ? '-' : ''}${lkrFromPaisa(Math.abs(paisa))}`

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
