'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ApiError, call as callApi, input, primary, secondary } from '@/components/manage/manage-ui'
import { Panel, PanelSkeleton } from '@/components/manage/dashboard/panel'
import { useSocketEvent } from '@/hooks/use-socket'
import { lkrFromPaisa } from '@/lib/format'
import { dailyOrderLabel } from '@/lib/order-number'
import type { DashboardSummary } from '@/server/services/dashboard.service'
import { cn } from '@/lib/utils'

/**
 * The dashboard's four cards (Story 9.3): cash check, needs attention
 * (long-open orders), sold out, comps. One query feeds all four; payments,
 * menu changes and table changes refresh it, and so does a minute passing
 * (long-open times grow on their own).
 */

const KEY = ['manage-dashboard-summary'] as const
const call = (method: string, url: string, body?: unknown) => callApi(method, url, body, '/manage/dashboard')
const money = (paisa: number) => `${paisa < 0 ? '-' : ''}${lkrFromPaisa(Math.abs(paisa))}`
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function duration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours === 0 ? `${rest} min` : `${hours} h ${rest} min`
}

export function SummaryCards() {
  const queryClient = useQueryClient()
  const { data, error } = useQuery({
    queryKey: KEY,
    queryFn: async () => ((await call('GET', '/api/manage/dashboard/summary')) as { data: DashboardSummary }).data,
    refetchInterval: 60_000,
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: KEY })
  useSocketEvent('session:payment_changed', refresh)
  useSocketEvent('menu:item_updated', refresh)
  useSocketEvent('menu:changed', refresh)
  useSocketEvent('table:status_changed', refresh)

  const waiting = error ? <p role="alert" className="text-fs-14 font-semibold text-red-700">Could not load.</p> : <PanelSkeleton />

  return (
    <div className="grid gap-sp-4 md:grid-cols-2 xl:grid-cols-3">
      <Panel title="Cash check" minHeight="min-h-56">
        {data ? <CashCheck cash={data.cash} onSaved={refresh} /> : waiting}
      </Panel>

      <Panel title="Needs attention" minHeight="min-h-56">
        {!data ? waiting : data.longOpen.length === 0 ? (
          <Empty text={`No order open longer than ${duration(data.longOpenMinutes)}.`} />
        ) : (
          <List>
            {data.longOpen.map((order) => (
              <li key={order.dailyNumber + order.openedAt} className="flex min-h-11 flex-wrap items-center gap-x-sp-3 border-t border-slate-100 py-sp-2">
                <span className="w-14 text-fs-16 font-bold text-slate-900 tabular-nums">{dailyOrderLabel(order.dailyNumber)}</span>
                <span className="min-w-0 flex-1 text-fs-16 text-slate-900">
                  {order.tables.join(' + ')}
                  {order.zone ? <span className="text-fs-14 text-slate-500"> · {order.zone}</span> : null}
                </span>
                <span className="text-fs-14 font-semibold text-amber-900 tabular-nums">{duration(order.minutesOpen)}</span>
                <span className="w-full pl-[4.25rem] text-fs-12 text-slate-500">Opened {time(order.openedAt)} by {order.openedBy}</span>
              </li>
            ))}
          </List>
        )}
      </Panel>

      <Panel title="Sold out" minHeight="min-h-56">
        {!data ? waiting : data.soldOut.length === 0 ? (
          <Empty text="Everything is available." />
        ) : (
          <List>
            {data.soldOut.map((item) => (
              <li key={item.id} className="flex min-h-11 items-center justify-between gap-sp-3 border-t border-slate-100 py-sp-2">
                <span className="min-w-0 truncate text-fs-16 text-slate-900">{item.name}</span>
                <span className="shrink-0 rounded-pill bg-slate-100 px-sp-2 py-0.5 text-fs-12 font-semibold text-slate-700">
                  {item.kind === 'depleted' ? 'Out of stock' : 'Marked sold out'}
                </span>
              </li>
            ))}
          </List>
        )}
      </Panel>

      <Panel
        title="Comps"
        minHeight="min-h-56"
        action={data && data.comps.entries.length > 0 ? (
          <span className="text-fs-14 font-bold text-slate-900 tabular-nums">-{lkrFromPaisa(data.comps.totalPaisa)}</span>
        ) : undefined}
      >
        {!data ? waiting : data.comps.entries.length === 0 ? (
          <Empty text="No comps today." />
        ) : (
          <List>
            {data.comps.entries.map((comp, index) => (
              <li key={index} className="flex min-h-11 flex-wrap items-center gap-x-sp-3 border-t border-slate-100 py-sp-2">
                <span className="min-w-0 flex-1 truncate text-fs-16 text-slate-900">{comp.itemName}</span>
                <span className="text-fs-14 font-semibold text-slate-900 tabular-nums">-{lkrFromPaisa(comp.amountPaisa)}</span>
                <span className="w-full text-fs-12 text-slate-500">
                  {comp.reason} · {comp.staffName} · {time(comp.at)}
                </span>
              </li>
            ))}
          </List>
        )}
      </Panel>
    </div>
  )
}

/** Scrolls past about five rows, so a long list never stretches the card. */
function List({ children }: { children: React.ReactNode }) {
  return <ul className="flex max-h-72 flex-col overflow-y-auto">{children}</ul>
}

function Empty({ text }: { text: string }) {
  return <p className="flex flex-1 items-center text-fs-14 text-slate-600">{text}</p>
}

/** Expected (cash taken today) against what the owner counted; a recount adds a new count. */
function CashCheck({ cash, onSaved }: { cash: DashboardSummary['cash']; onSaved: () => void }) {
  const [editing, setEditing] = useState(cash.count === null)
  const [rupees, setRupees] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const gap = cash.gapPaisa

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
      setRupees('')
      setEditing(false)
      onSaved()
    } catch (failure) {
      setProblem(failure instanceof ApiError || failure instanceof Error ? failure.message : 'Could not save the count')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-sp-2">
      <div className="flex items-center justify-between text-fs-16 text-slate-700">
        <span>Expected (cash taken)</span>
        <span className="font-bold text-slate-900 tabular-nums">{money(cash.expectedPaisa)}</span>
      </div>
      {cash.count ? (
        <div className="flex items-center justify-between text-fs-16 text-slate-700">
          <span>Counted</span>
          <span className="font-bold text-slate-900 tabular-nums">{money(cash.count.countedPaisa)}</span>
        </div>
      ) : null}

      {gap === null ? null : gap === 0 ? (
        <p className="flex items-center gap-sp-2 rounded-control bg-open-body px-sp-3 py-sp-2 text-fs-16 font-bold text-open-ink">
          <CheckCircle2 className="size-5" aria-hidden="true" /> Balanced
        </p>
      ) : (
        <p className="flex items-center justify-between gap-sp-2 rounded-control border-2 border-red-700 bg-white px-sp-3 py-sp-2 text-fs-16 font-bold text-red-700">
          <span className="flex items-center gap-sp-2">
            <AlertTriangle className="size-5" aria-hidden="true" /> {gap > 0 ? 'Over by' : 'Short by'}
          </span>
          <span className="tabular-nums">{lkrFromPaisa(Math.abs(gap))}</span>
        </p>
      )}
      {cash.count ? (
        <p className="text-fs-12 text-slate-500">Counted {time(cash.count.countedAt)} by {cash.count.countedBy}</p>
      ) : null}

      {editing ? (
        <form
          className="mt-auto flex flex-col gap-sp-1"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="text-fs-14 font-semibold text-slate-700" htmlFor="cash-counted">Cash in the drawer, without the float</label>
          <div className="flex gap-sp-2">
            <input
              id="cash-counted"
              inputMode="numeric"
              autoComplete="off"
              placeholder="LKR"
              className={cn(input, 'min-w-0 flex-1 tabular-nums')}
              value={rupees}
              onChange={(e) => setRupees(e.target.value.replace(/[^\d,]/g, ''))}
            />
            <button type="submit" className={primary} disabled={busy}>Save</button>
            {cash.count ? (
              <button type="button" className={secondary} onClick={() => setEditing(false)}>Cancel</button>
            ) : null}
          </div>
          {problem ? <span role="alert" className="text-fs-12 font-semibold text-red-700">{problem}</span> : null}
        </form>
      ) : (
        <button type="button" className={cn(secondary, 'mt-auto self-start')} onClick={() => setEditing(true)}>
          Recount
        </button>
      )}
    </div>
  )
}
