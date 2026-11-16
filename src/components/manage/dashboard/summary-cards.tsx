'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Clock, X } from 'lucide-react'
import { call as callApi } from '@/components/manage/manage-ui'
import { Badge, Panel, PanelSkeleton, tone } from '@/components/manage/dashboard/panel'
import { dailyOrderLabel } from '@/lib/order-number'
import type { DashboardSummary } from '@/server/services/dashboard.service'
import { cn } from '@/lib/utils'

/**
 * The "right now" cards (Story 9.3): orders open too long and dishes not
 * available, plus the cash count for today. One query; refreshed by payments,
 * menu and table changes, and every minute (open times grow on their own).
 * Shown on the Today view only.
 */

export const SUMMARY_KEY = ['manage-dashboard-summary'] as const
const call = (method: string, url: string, body?: unknown) => callApi(method, url, body, '/manage/dashboard')
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function duration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours === 0 ? `${rest} min` : `${hours} h ${rest} min`
}

export function useSummary() {
  return useQuery({
    queryKey: SUMMARY_KEY,
    queryFn: async () => ((await call('GET', '/api/manage/dashboard/summary')) as { data: DashboardSummary }).data,
    refetchInterval: 60_000,
  })
}

export function LiveCards() {
  const { data, error } = useSummary()
  const waiting = error ? <p role="alert" className={cn('text-fs-14 font-semibold', tone.bad)}>Could not load.</p> : <PanelSkeleton />

  return (
    <div className="grid gap-sp-3 md:grid-cols-2">
      <Panel title="Needs attention" icon={Clock} subtitle={data ? `open longer than ${duration(data.longOpenMinutes)}` : undefined} minHeight="min-h-40">
        {!data ? waiting : data.longOpen.length === 0 ? (
          <p className={cn('flex flex-1 items-center text-fs-14', tone.second)}>No order open too long.</p>
        ) : (
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {data.longOpen.map((order) => (
              <li key={order.dailyNumber + order.openedAt} className={cn('flex flex-wrap items-center gap-x-sp-3 border-t py-sp-2', tone.hairline)}>
                <span className={cn('w-12 text-fs-14 font-bold tabular-nums', tone.ink)}>{dailyOrderLabel(order.dailyNumber)}</span>
                <span className={cn('min-w-0 flex-1 text-fs-14', tone.ink)}>
                  {order.tables.join(' + ')}
                  {order.zone ? <span className={tone.muted}> · {order.zone}</span> : null}
                </span>
                <Badge kind="warn">{duration(order.minutesOpen)}</Badge>
                <span className={cn('w-full pl-[3.75rem] text-fs-12', tone.muted)}>Opened {time(order.openedAt)} by {order.openedBy}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Not available" icon={Ban} subtitle="switched off on every tablet" minHeight="min-h-40">
        {!data ? waiting : data.soldOut.length === 0 ? (
          <p className={cn('flex flex-1 items-center text-fs-14', tone.second)}>Everything is available.</p>
        ) : (
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {data.soldOut.map((item) => (
              <li key={item.id} className={cn('flex min-h-10 items-center justify-between gap-sp-3 border-t py-sp-1', tone.hairline)}>
                <span className={cn('min-w-0 truncate text-fs-14', tone.ink)}>{item.name}</span>
                <Badge kind="info">{item.kind === 'depleted' ? 'Ran out' : 'Switched off'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

/** "Count cash" / "Recount" in the cash tile; opens a small sheet. Today only. */
export function CashCountButton({ counted, onSaved }: { counted: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="mt-sp-1 inline-flex h-9 items-center self-start rounded-control border border-slate-300 px-sp-3 text-fs-14 font-bold text-slate-900 hover:bg-slate-50 night:border-night-hairline night:text-night-text night:hover:bg-night-raised"
        onClick={() => setOpen(true)}
      >
        {counted ? 'Recount' : 'Count cash'}
      </button>
      {open ? <CashCountSheet onClose={() => setOpen(false)} onSaved={onSaved} /> : null}
    </>
  )
}

function CashCountSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const queryClient = useQueryClient()
  const [rupees, setRupees] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function save() {
    const value = Number(rupees.replace(/,/g, ''))
    if (rupees.trim() === '' || !Number.isInteger(value) || value < 0) {
      setProblem('Enter the cash counted in whole rupees')
      return
    }
    setBusy(true)
    setProblem(null)
    try {
      await call('POST', '/api/manage/dashboard/cash-count', { countedPaisa: value * 100 })
      await queryClient.invalidateQueries({ queryKey: SUMMARY_KEY })
      onSaved()
      onClose()
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'Could not save the count')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cash-count-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <form
        className={cn('flex w-full max-w-sm flex-col gap-sp-3 rounded-panel p-sp-5 shadow-el-2', tone.card)}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="flex items-center justify-between">
          <h2 id="cash-count-title" className={cn('text-fs-20 font-extrabold', tone.ink)}>Count the cash</h2>
          <button type="button" aria-label="Close" className={cn('inline-flex size-11 items-center justify-center rounded-control', tone.second)} onClick={onClose}>
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        <label className="flex flex-col gap-sp-1">
          <span className={cn('text-fs-14 font-semibold', tone.second)}>All cash in the drawer, float included (LKR)</span>
          <input
            autoFocus
            inputMode="numeric"
            autoComplete="off"
            className="h-12 rounded-control border border-slate-300 bg-white px-sp-3 text-fs-20 font-bold text-slate-900 tabular-nums night:border-night-hairline night:bg-night-sunken night:text-night-text"
            value={rupees}
            onChange={(e) => setRupees(e.target.value.replace(/[^\d,]/g, ''))}
          />
        </label>
        <p className={cn('text-fs-12', tone.muted)}>A recount adds a new count; earlier ones stay on record.</p>
        {problem ? <p role="alert" className={cn('text-fs-14 font-semibold', tone.bad)}>{problem}</p> : null}
        <button type="submit" disabled={busy} className="h-11 rounded-control bg-brand-800 text-fs-14 font-bold text-white disabled:opacity-50">
          Save count
        </button>
      </form>
    </div>
  )
}
