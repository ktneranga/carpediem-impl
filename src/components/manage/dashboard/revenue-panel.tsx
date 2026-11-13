'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { call as callApi } from '@/components/manage/manage-ui'
import { Panel, PanelSkeleton } from '@/components/manage/dashboard/panel'
import { useSocketEvent } from '@/hooks/use-socket'
import { lkrCompact, lkrFromPaisa } from '@/lib/format'
import type { Revenue } from '@/server/services/dashboard.service'

/**
 * Takings today (Story 9.2): money received so far, against yesterday by the
 * same hour, and a running-total line for each day.
 *
 * Emphasis form: Today in the brand accent, Yesterday in de-emphasis grey and
 * dashed — a legend and the dash keep them apart without colour. Refetches on
 * every payment (`session:payment_changed`) and once a minute as a fallback;
 * the last render stays on screen while it does.
 */

const TODAY = 'var(--color-brand-500)'
const YESTERDAY = 'var(--color-slate-400)'
const KEY = ['manage-dashboard-revenue'] as const

function hourLabel(hour: number) {
  const suffix = hour < 12 ? 'AM' : 'PM'
  return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`
}

/** Running totals, from the start of the business day. */
function cumulative(hours: number[]) {
  let total = 0
  return hours.map((paisa) => (total += paisa))
}

type Point = { slot: number; label: string; today: number | null; yesterday: number }

/** The hours worth drawing: where either day has money, ± 1, and at least the 6 hours up to now. */
function chartPoints(revenue: Revenue): Point[] {
  const { startHour, nowSlot, today, yesterday } = revenue
  const used = [...today.hours.keys()].filter((i) => today.hours[i]! > 0 || yesterday.hours[i]! > 0)
  const first = Math.min(used[0] ?? nowSlot, nowSlot - 5)
  const last = Math.max(used.at(-1) ?? nowSlot, nowSlot)
  const from = Math.max(0, first - 1)
  const to = Math.min(23, last + 1)
  const todayRun = cumulative(today.hours)
  const yesterdayRun = cumulative(yesterday.hours)
  const points: Point[] = []
  for (let slot = from; slot <= to; slot += 1) {
    points.push({
      slot,
      label: hourLabel((startHour + slot) % 24),
      // Today stops at the current hour: the future has no takings yet.
      today: slot <= nowSlot ? todayRun[slot]! : null,
      yesterday: yesterdayRun[slot]!,
    })
  }
  return points
}

export function RevenuePanel() {
  const queryClient = useQueryClient()
  const { data, error } = useQuery({
    queryKey: KEY,
    queryFn: async () => ((await callApi('GET', '/api/manage/dashboard/revenue', undefined, '/manage/dashboard')) as { data: Revenue }).data,
    refetchInterval: 60_000,
  })
  useSocketEvent('session:payment_changed', () => void queryClient.invalidateQueries({ queryKey: KEY }))

  if (!data) {
    return (
      <Panel title="Takings today" minHeight="min-h-80">
        {error ? <p role="alert" className="text-fs-14 font-semibold text-red-700">Could not load the takings.</p> : <PanelSkeleton rows={6} />}
      </Panel>
    )
  }

  const points = chartPoints(data)
  const yesterdayByNow = cumulative(data.yesterday.hours)[data.nowSlot] ?? 0
  const todaySoFar = data.today.totalPaisa
  const change = yesterdayByNow > 0 ? Math.round(((todaySoFar - yesterdayByNow) / yesterdayByNow) * 100) : null

  return (
    <Panel title="Takings today" minHeight="min-h-80">
      <div className="flex flex-wrap items-end justify-between gap-sp-3">
        <div>
          <p className="text-fs-32 font-extrabold text-slate-900 tabular-nums">{lkrFromPaisa(todaySoFar)}</p>
          <p className="text-fs-14 text-slate-600">
            {todaySoFar === 0
              ? 'No payments yet today'
              : change === null
                ? 'Received so far'
                : `vs ${lkrFromPaisa(yesterdayByNow)} by this time yesterday (${change >= 0 ? '+' : ''}${change}%)`}
          </p>
        </div>
        <ul aria-label="Legend" className="flex gap-sp-4 text-fs-14 text-slate-700">
          <li className="flex items-center gap-sp-2">
            <svg width="20" height="4" aria-hidden="true"><line x1="0" y1="2" x2="20" y2="2" stroke={TODAY} strokeWidth="2" /></svg>
            Today
          </li>
          <li className="flex items-center gap-sp-2">
            <svg width="20" height="4" aria-hidden="true"><line x1="0" y1="2" x2="20" y2="2" stroke={YESTERDAY} strokeWidth="2" strokeDasharray="4 3" /></svg>
            Yesterday
          </li>
        </ul>
      </div>

      <div className="h-56 w-full" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-slate-100)" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: 'var(--color-slate-200)' }} tick={{ fill: 'var(--color-slate-600)', fontSize: 12 }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tickFormatter={(value: number) => lkrCompact(value)} tickLine={false} axisLine={false} width={72} tick={{ fill: 'var(--color-slate-600)', fontSize: 12 }} />
            <Tooltip cursor={{ stroke: 'var(--color-slate-400)', strokeWidth: 1 }} content={<RevenueTooltip />} />
            <Line type="monotone" dataKey="yesterday" name="Yesterday" stroke={YESTERDAY} strokeWidth={2} strokeDasharray="4 3" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="today" name="Today" stroke={TODAY} strokeWidth={2} dot={false} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* The same figures for screen readers and anyone who wants the numbers. */}
      <table className="sr-only">
        <caption>Running takings by hour</caption>
        <thead>
          <tr><th>Hour</th><th>Today</th><th>Yesterday</th></tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.slot}>
              <td>{point.label}</td>
              <td>{point.today === null ? '—' : lkrFromPaisa(point.today)}</td>
              <td>{lkrFromPaisa(point.yesterday)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

/** Values lead, the series name follows; a short line keys each row. */
function RevenueTooltip({ active, payload, label }: { active?: boolean; payload?: { dataKey?: unknown; value?: unknown }[]; label?: unknown }) {
  if (!active || !payload?.length) return null
  const value = (key: string) => payload.find((entry) => entry.dataKey === key)?.value
  const rows: { key: string; name: string; stroke: string; dash?: string }[] = [
    { key: 'today', name: 'Today', stroke: TODAY },
    { key: 'yesterday', name: 'Yesterday', stroke: YESTERDAY, dash: '4 3' },
  ]
  return (
    <div className="rounded-control border border-slate-200 bg-white px-sp-3 py-sp-2 shadow-el-2">
      <p className="text-fs-12 text-slate-600">By {String(label)}</p>
      {rows.map((row) => {
        const amount = value(row.key)
        if (typeof amount !== 'number') return null
        return (
          <p key={row.key} className="flex items-center gap-sp-2 text-fs-14">
            <svg width="14" height="4" aria-hidden="true"><line x1="0" y1="2" x2="14" y2="2" stroke={row.stroke} strokeWidth="2" strokeDasharray={row.dash} /></svg>
            <span className="font-bold text-slate-900 tabular-nums">{lkrFromPaisa(amount)}</span>
            <span className="text-slate-600">{row.name}</span>
          </p>
        )
      })}
    </div>
  )
}
