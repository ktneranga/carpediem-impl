'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { call as callApi } from '@/components/manage/manage-ui'
import { AuditList, CompsByReason, PaymentSplit, RevenueChart, StatTiles, TopItems } from '@/components/manage/dashboard/insight-panels'
import { Panel, PanelSkeleton, tone } from '@/components/manage/dashboard/panel'
import { CashCountButton, LiveCards, SUMMARY_KEY } from '@/components/manage/dashboard/summary-cards'
import { useTheme } from '@/components/theme/theme'
import { useSocketEvent, useSocketStatus } from '@/hooks/use-socket'
import type { Insights, Period } from '@/server/services/insights.service'
import { cn } from '@/lib/utils'

/**
 * Manage → Dashboard (Stories 9.1–9.3, reworked 2026-11-13 from Teran's Carpe
 * Diem mock-up): a period switch (Today, Yesterday, Week, Month), the revenue
 * by hour or day with its peak, four stat tiles (recorded revenue vs the same
 * span before, cash gap, covers, comps), payment split, top items, comps by
 * reason, unclosed orders and corrections — and on Today, what needs attention
 * now. Light and dark follow the app-wide theme (the Dark mode switch).
 */

const PERIODS: { value: Period; label: string; word: string }[] = [
  { value: 'today', label: 'Today', word: 'Today' },
  { value: 'yesterday', label: 'Yesterday', word: 'Yesterday' },
  { value: 'week', label: 'Week', word: 'This week' },
  { value: 'month', label: 'Month', word: 'This month' },
]

const date = (iso: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...options })

function periodTitle(data: Insights) {
  if (data.period === 'month') return date(data.from, { month: 'long', year: 'numeric' })
  if (data.from === data.to) return date(data.from, { weekday: 'short', day: 'numeric', month: 'short' })
  return `${date(data.from, { day: 'numeric', month: 'short' })} – ${date(data.to, { day: 'numeric', month: 'short' })}`
}

export function Dashboard() {
  const queryClient = useQueryClient()
  const live = useSocketStatus()
  const { dark } = useTheme()
  const [period, setPeriod] = useState<Period>('today')
  const includesToday = period !== 'yesterday'

  const key = ['manage-dashboard-insights', period] as const
  const { data, error } = useQuery({
    queryKey: key,
    queryFn: async () =>
      ((await callApi('GET', `/api/manage/dashboard/insights?period=${period}`, undefined, '/manage/dashboard')) as { data: Insights }).data,
    refetchInterval: includesToday ? 60_000 : false,
    placeholderData: (previous) => previous,
  })
  const refresh = () => {
    if (includesToday) void queryClient.invalidateQueries({ queryKey: ['manage-dashboard-insights'] })
    void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY })
  }
  useSocketEvent('session:payment_changed', refresh)
  useSocketEvent('table:status_changed', refresh)
  useSocketEvent('menu:item_updated', () => void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY }))
  useSocketEvent('menu:changed', () => void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY }))

  const word = PERIODS.find((p) => p.value === period)!.word
  const shown = data && data.period === period ? data : null

  return (
    <div>
      <div className="flex flex-col gap-sp-4">
        <header className="flex flex-wrap items-end justify-between gap-sp-3">
          <div>
            <p className="text-fs-12 font-extrabold tracking-micro text-brand-700 uppercase night:text-brand-300">
              {data?.restaurantName ?? 'Dashboard'}
            </p>
            <h1 className={cn('text-fs-24 font-extrabold', tone.ink)}>{data ? periodTitle(data) : 'Dashboard'}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-sp-2">
            <div role="tablist" aria-label="Period" className={cn('flex rounded-control p-0.5', tone.card)}>
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  role="tab"
                  type="button"
                  aria-selected={period === p.value}
                  className={cn(
                    'h-10 rounded-control px-sp-3 text-fs-14 font-bold',
                    period === p.value
                      ? 'bg-brand-800 text-white night:bg-brand-500'
                      : 'text-slate-600 hover:bg-slate-100 night:text-night-second night:hover:bg-night-raised',
                  )}
                  onClick={() => setPeriod(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className={cn('flex items-center gap-sp-1 text-fs-12 font-semibold', tone.muted)}>
              <span aria-hidden="true" className={cn('size-2 rounded-full', live ? 'bg-open-edge' : 'bg-slate-400')} />
              {live ? 'Live' : 'Offline'}
            </span>
          </div>
        </header>

        {error && !shown ? (
          <p role="alert" className={cn('text-fs-14 font-semibold', tone.bad)}>Could not load the dashboard.</p>
        ) : null}

        {!shown ? (
          <div className="grid gap-sp-3 lg:grid-cols-3">
            <Panel title="Revenue" minHeight="min-h-72" className="lg:col-span-2"><PanelSkeleton rows={6} /></Panel>
            <Panel title="Payment split" minHeight="min-h-72"><PanelSkeleton rows={4} /></Panel>
          </div>
        ) : (
          <>
            {/* Phone: chart, tiles, split (the mock-up's order). Laptop: chart and split side by side, tiles below. */}
            <div className="grid gap-sp-3 lg:grid-cols-3">
              <div className="order-1 lg:col-span-2"><RevenueChart data={shown} dark={dark} periodWord={word} /></div>
              <div className="order-3 lg:order-2"><PaymentSplit data={shown} dark={dark} /></div>
              <div className="order-2 lg:order-3 lg:col-span-3">
                <StatTiles
                  data={shown}
                  cashAction={period === 'today' ? <CashCountButton counted={!!shown.cash.count} onSaved={refresh} /> : undefined}
                />
              </div>
            </div>

            {period === 'today' ? <LiveCards /> : null}

            <div className="grid gap-sp-3 lg:grid-cols-3">
              <TopItems data={shown} dark={dark} />
              <CompsByReason data={shown} dark={dark} />
              <AuditList data={shown} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
