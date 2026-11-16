'use client'

import type { ReactNode } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  ChartColumn,
  ClipboardList,
  Gift,
  Lock,
  TrendingUp,
  TriangleAlert,
  Users,
  UtensilsCrossed,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { Badge, Panel, ShowAll, tone } from '@/components/manage/dashboard/panel'
import { lkrCompact, lkrFromPaisa } from '@/lib/format'
import type { Insights } from '@/server/services/insights.service'
import { cn } from '@/lib/utils'

/**
 * The dashboard's period panels (Teran, 2026-11-13, from the Carpe Diem
 * mock-up). Colours, validated light and dark with the dataviz checks:
 * - hourly bars: emphasis form — every bar in the base blue, the PEAK in orange;
 * - payment split: categorical blue / aqua / orange for cash / card / transfer,
 *   always with a legend carrying the name, the amount and the share.
 * Text never wears a chart colour.
 */

export const chartColors = (dark: boolean) => ({
  base: dark ? '#3987e5' : '#2288B4',
  peak: dark ? '#d95926' : '#eb6834',
  cash: dark ? '#3987e5' : '#2288B4',
  card: dark ? '#199e70' : '#1baf7a',
  transfer: dark ? '#d95926' : '#eb6834',
  surface: dark ? '#1E293B' : '#FFFFFF',
  axis: dark ? '#94A3B8' : '#475569',
  hairline: dark ? '#263449' : '#E2E8F0',
})

const money = (paisa: number) => lkrFromPaisa(paisa)
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// ── Hourly / daily revenue ───────────────────────────────────────────────────

export function RevenueChart({ data, dark, periodWord }: { data: Insights; dark: boolean; periodWord: string }) {
  const c = chartColors(dark)
  const items = data.buckets.items
  const peak = items.find((item) => item.key === data.buckets.peakKey) ?? null
  const hourly = data.buckets.kind === 'hour'
  return (
    <Panel
      title={hourly ? 'Hourly revenue' : 'Daily revenue'}
      icon={ChartColumn}
      subtitle={`${periodWord} · ${money(data.recorded.paisa)} recorded`}
      minHeight="min-h-72"
      action={peak ? <Badge kind="warn">Peak {hourly ? `${peak.label}:00` : peak.label}</Badge> : undefined}
    >
      {data.recorded.paisa === 0 ? (
        <p className={cn('flex flex-1 items-center justify-center text-fs-14', tone.second)}>No bills recorded {periodWord.toLowerCase()}.</p>
      ) : (
        <>
          <div className="h-48 w-full" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={items} margin={{ top: 22, right: 0, bottom: 0, left: 0 }} barCategoryGap={2}>
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: c.hairline }}
                  tick={{ fill: c.axis, fontSize: 11 }}
                  interval="preserveStartEnd"
                  minTickGap={4}
                />
                <Tooltip cursor={{ fill: c.hairline, opacity: 0.5 }} content={<BarTooltip hourly={hourly} dark={dark} />} />
                <Bar
                  dataKey="paisa"
                  maxBarSize={36}
                  isAnimationActive={false}
                  // Drawn here so the peak carries its own label (a selective
                  // direct label); every other bar shows its value on hover.
                  shape={(props: unknown) => {
                    const { x, y, width, height, payload } = props as { x: number; y: number; width: number; height: number; payload: { key: string; paisa: number } }
                    const peakBar = payload.key === data.buckets.peakKey
                    const r = Math.max(0, Math.min(4, width / 2, height))
                    return (
                      <g>
                        <path
                          d={`M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`}
                          fill={peakBar ? c.peak : c.base}
                        />
                        {peakBar ? (
                          <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={12} fontWeight={700} fill={dark ? '#F8FAFC' : '#0F172A'}>
                            {lkrCompact(payload.paisa)}
                          </text>
                        ) : null}
                      </g>
                    )
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>Revenue by {hourly ? 'hour' : 'day'}</caption>
            <tbody>
              {items.map((item) => (
                <tr key={item.key}><td>{hourly ? `${item.label}:00` : item.label}</td><td>{money(item.paisa)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  )
}

function BarTooltip({ active, payload, label, hourly, dark }: { active?: boolean; payload?: { value?: unknown }[]; label?: unknown; hourly: boolean; dark: boolean }) {
  if (!active || !payload?.length) return null
  return (
    <div className={cn('rounded-control border px-sp-3 py-sp-2 shadow-el-2', dark ? 'border-night-hairline bg-night-raised' : 'border-slate-200 bg-white')}>
      <p className={cn('text-fs-14 font-bold tabular-nums', dark ? 'text-night-text' : 'text-slate-900')}>{money(Number(payload[0]!.value ?? 0))}</p>
      <p className={cn('text-fs-12', dark ? 'text-night-muted' : 'text-slate-500')}>{hourly ? `${String(label)}:00` : String(label)}</p>
    </div>
  )
}

// ── Stat tiles ───────────────────────────────────────────────────────────────

/** `alert` turns the ring red AND swaps the icon for a warning: never colour alone (UX spec). */
function Tile({ label, icon: Icon, value, children, alert }: { label: string; icon: LucideIcon; value: ReactNode; children?: ReactNode; alert?: boolean }) {
  const Shown = alert ? TriangleAlert : Icon
  return (
    <section
      aria-label={label}
      className={cn('flex min-h-32 flex-col gap-sp-1 rounded-panel p-sp-4', tone.card, alert && 'ring-2 ring-red-400 night:ring-red-500/60')}
    >
      <h2 className={cn('flex items-center gap-sp-1 text-fs-12 font-bold tracking-micro uppercase', tone.muted)}>
        <Shown className={cn('size-3.5 shrink-0', alert && tone.bad)} aria-hidden="true" />
        {label}
      </h2>
      <p className={cn('text-fs-24 font-extrabold tabular-nums', tone.ink)}>{value}</p>
      <div className={cn('text-fs-12', tone.second)}>{children}</div>
    </section>
  )
}

// The cash gap moved to the Cash drawer card (Teran, 2026-11-16).
export function StatTiles({ data }: { data: Insights }) {
  const change = data.recorded.changePercent
  return (
    <div className="grid grid-cols-2 gap-sp-3 xl:grid-cols-3">
      <Tile label="Recorded revenue" icon={TrendingUp} value={money(data.recorded.paisa)}>
        {change === null ? (
          <span>Nothing to compare {data.compareLabel.replace('vs ', 'with ')}</span>
        ) : (
          <span className={cn('inline-flex items-center gap-0.5 font-semibold', change >= 0 ? tone.good : tone.bad)}>
            {change >= 0 ? <ArrowUpRight className="size-3.5" aria-hidden="true" /> : <ArrowDownRight className="size-3.5" aria-hidden="true" />}
            {change >= 0 ? '+' : ''}{change}% <span className={cn('font-normal', tone.second)}>{data.compareLabel}</span>
          </span>
        )}
      </Tile>

      <Tile label="Covers" icon={Users} value={data.covers.count.toLocaleString('en-US')}>
        {data.covers.averagePaisa === null ? 'No guests recorded' : `avg ${money(data.covers.averagePaisa)} each`}
      </Tile>

      <Tile label="Comps" icon={Gift} value={money(data.comps.totalPaisa)}>
        {data.comps.lines === 0
          ? 'No comps'
          : `${data.comps.percentOfRevenue ?? 0}% of revenue · ${data.comps.lines} line${data.comps.lines === 1 ? '' : 's'}`}
      </Tile>
    </div>
  )
}

// ── Payment split ────────────────────────────────────────────────────────────

export function PaymentSplit({ data, dark }: { data: Insights; dark: boolean }) {
  const c = chartColors(dark)
  const p = data.payments
  const slices = [
    { name: 'Cash', paisa: p.cashPaisa, color: c.cash },
    { name: 'Card', paisa: p.cardPaisa, color: c.card },
    { name: 'Bank transfer', paisa: p.transferPaisa, color: c.transfer },
  ]
  const share = (paisa: number) => (p.settledPaisa > 0 ? Math.round((paisa / p.settledPaisa) * 100) : 0)
  return (
    <Panel title="Payment split" icon={Wallet} subtitle="settled only" minHeight="min-h-56 h-full">
      {p.settledPaisa === 0 ? (
        <p className={cn('flex flex-1 items-center text-fs-14', tone.second)}>No payments in this period.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-sp-4">
          <div className="relative size-40 shrink-0" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices.filter((slice) => slice.paisa > 0)}
                  dataKey="paisa"
                  nameKey="name"
                  innerRadius="68%"
                  outerRadius="100%"
                  startAngle={90}
                  endAngle={-270}
                  stroke={c.surface}
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {slices.filter((slice) => slice.paisa > 0).map((slice) => <Cell key={slice.name} fill={slice.color} />)}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className={cn('text-fs-14 font-extrabold tabular-nums', tone.ink)}>{lkrCompact(p.settledPaisa)}</span>
              <span className={cn('text-fs-12 uppercase', tone.muted)}>settled</span>
            </div>
          </div>
          <ul className="flex min-w-40 flex-1 flex-col gap-sp-2">
            {slices.map((slice) => (
              <li key={slice.name} className="flex items-center gap-sp-2">
                <span aria-hidden="true" className="size-3 shrink-0 rounded-[3px]" style={{ background: slice.color }} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={cn('text-fs-14', tone.second)}>{slice.name}</span>
                  <span className={cn('text-fs-12 whitespace-nowrap tabular-nums', tone.muted)}>{money(slice.paisa)}</span>
                </span>
                <span className={cn('w-12 text-right text-fs-14 font-bold tabular-nums', tone.ink)}>{share(slice.paisa)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

// ── Ranked lists ─────────────────────────────────────────────────────────────

function RankedRows({ rows, color }: { rows: { key: string; title: ReactNode; amount: number }[]; color: string }) {
  const max = Math.max(...rows.map((row) => row.amount), 1)
  return (
    <ol className="flex flex-col">
      {rows.map((row, index) => (
        <li key={row.key} className={cn('flex flex-col gap-sp-1 border-t py-sp-2', tone.hairline)}>
          <div className="flex items-baseline gap-sp-2 text-fs-14">
            <span className={cn('w-5 tabular-nums', tone.muted)}>{index + 1}</span>
            <span className={cn('min-w-0 flex-1 truncate', tone.ink)}>{row.title}</span>
            <span className={cn('font-bold tabular-nums', tone.ink)}>{lkrFromPaisa(row.amount)}</span>
          </div>
          <div className={cn('ml-7 h-1.5 overflow-hidden rounded-full', tone.track)} aria-hidden="true">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (row.amount / max) * 100)}%`, background: color }} />
          </div>
        </li>
      ))}
    </ol>
  )
}

const TOP_SHOWN = 5
const REASONS_SHOWN = 6
const AUDIT_SHOWN = 8

export function TopItems({ data, dark }: { data: Insights; dark: boolean }) {
  const rows = data.topItems.map((item) => ({
    key: item.name,
    title: <>{item.name} <span className={tone.muted}>×{item.quantity}</span></>,
    amount: item.paisa,
  }))
  const color = chartColors(dark).base
  return (
    <Panel title="Top items" icon={UtensilsCrossed} subtitle="by revenue" minHeight="min-h-40">
      {rows.length === 0 ? (
        <p className={cn('flex flex-1 items-center text-fs-14', tone.second)}>Nothing billed in this period.</p>
      ) : (
        <RankedRows color={color} rows={rows.slice(0, TOP_SHOWN)} />
      )}
      <ShowAll title="Items by revenue" total={rows.length} shown={TOP_SHOWN}>
        <RankedRows color={color} rows={rows} />
      </ShowAll>
    </Panel>
  )
}

export function CompsByReason({ data, dark }: { data: Insights; dark: boolean }) {
  const rows = data.comps.byReason.map((row) => ({
    key: `${row.reason}|${row.approver}`,
    title: <>{row.reason} <span className={tone.muted}>· {row.approver}{row.count > 1 ? ` · ${row.count}×` : ''}</span></>,
    amount: row.paisa,
  }))
  const color = chartColors(dark).peak
  return (
    <Panel title="Comps by reason" icon={Gift} subtitle="every comp carries an approver" minHeight="min-h-40">
      {rows.length === 0 ? (
        <p className={cn('flex flex-1 items-center text-fs-14', tone.second)}>No comps in this period.</p>
      ) : (
        <RankedRows color={color} rows={rows.slice(0, REASONS_SHOWN)} />
      )}
      <ShowAll title="Comps by reason" total={rows.length} shown={REASONS_SHOWN}>
        <RankedRows color={color} rows={rows} />
      </ShowAll>
    </Panel>
  )
}

// ── Unclosed & corrections ───────────────────────────────────────────────────

const BADGES = {
  unclosed: { label: 'Unclosed', kind: 'bad' },
  walkout: { label: 'Walkout', kind: 'bad' },
  abandoned: { label: 'Closed unpaid', kind: 'warn' },
  correction: { label: 'Correction', kind: 'warn' },
  cancelled: { label: 'Bill cancelled', kind: 'warn' },
} as const

function AuditRows({ rows }: { rows: Insights['audit'] }) {
  return (
    <ul className="flex flex-col">
      {rows.map((row, index) => (
            <li key={index} className={cn('flex items-start gap-sp-3 border-t py-sp-2', tone.hairline)}>
              <div className="min-w-0 flex-1">
                <p className={cn('text-fs-14 font-bold', tone.ink)}>{row.title}</p>
                <p className={cn('text-fs-12', tone.second)}>
                  {row.detail} · {time(row.at)}
                  {row.amountPaisa ? <> · {row.kind === 'cancelled' ? '' : 'owed '}{lkrFromPaisa(row.amountPaisa)}</> : null}
                </p>
              </div>
              <Badge kind={BADGES[row.kind].kind}>{BADGES[row.kind].label}</Badge>
            </li>
      ))}
    </ul>
  )
}

export function AuditList({ data }: { data: Insights }) {
  return (
    <Panel title="Unclosed & corrections" icon={ClipboardList} subtitle="audit trail" minHeight="min-h-40">
      {data.audit.length === 0 ? (
        <p className={cn('flex flex-1 items-center text-fs-14', tone.second)}>Every order is closed and nothing was corrected.</p>
      ) : (
        <AuditRows rows={data.audit.slice(0, AUDIT_SHOWN)} />
      )}
      <ShowAll title="Unclosed & corrections" total={data.audit.length} shown={AUDIT_SHOWN}>
        <AuditRows rows={data.audit} />
      </ShowAll>
      <p className={cn('mt-auto flex items-center gap-sp-1 pt-sp-2 text-fs-12', tone.muted)}>
        <Lock className="size-3" aria-hidden="true" /> Records cannot be edited or deleted. Corrections appear as new entries.
      </p>
    </Panel>
  )
}
