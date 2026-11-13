'use client'

import { useSocketStatus } from '@/hooks/use-socket'
import { RevenuePanel } from '@/components/manage/dashboard/revenue-panel'
import { SummaryCards } from '@/components/manage/dashboard/summary-cards'
import { cn } from '@/lib/utils'

/**
 * Manage → Dashboard (Story 9.1): today's business day at a glance. The
 * revenue panel spans the top (9.2); the cards below (9.3) sit in a grid of
 * 1 / 2 / 3 columns. Every panel owns its own query and socket refresh, so a
 * slow one never holds the others back.
 */
export function Dashboard() {
  const live = useSocketStatus()
  return (
    <div className="flex flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <h1 className="text-fs-24 font-extrabold text-slate-900">Dashboard</h1>
        <span className="flex items-center gap-sp-2 text-fs-14 font-semibold text-slate-600">
          <span aria-hidden="true" className={cn('size-2.5 rounded-full', live ? 'bg-open-edge' : 'bg-slate-300')} />
          {live ? 'Live' : 'Reconnecting…'}
        </span>
      </header>

      <RevenuePanel />

      <SummaryCards />
    </div>
  )
}
