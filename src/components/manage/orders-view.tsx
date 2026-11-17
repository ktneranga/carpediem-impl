'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, Search, X } from 'lucide-react'
import { call, input, secondary } from '@/components/manage/manage-ui'
import { OrderStory } from '@/components/manage/audit-view'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { OrderRow, OrderStatus } from '@/server/services/orders-list.service'

/**
 * Manage → Orders (Story 7.7, Teran 2026-11-17): every order of a day (or a
 * span), one row each. Tap a row for the order's whole story. Read-only.
 */

type Payload = {
  from: string
  to: string
  orders: OrderRow[]
  totals: { orders: number; paidPaisa: number; openPaisa: number }
}

const ink = 'text-slate-900 night:text-night-text'
const second = 'text-slate-600 night:text-night-second'
const muted = 'text-slate-500 night:text-night-muted'

const STATUS: Record<OrderStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'bg-occupied-chip text-occupied-ink night:bg-amber-500/20 night:text-amber-300' },
  paid: { label: 'Paid', tone: 'bg-open-chip text-open-ink night:bg-green-500/20 night:text-green-400' },
  cancelled: { label: 'Cancelled', tone: 'bg-slate-100 text-slate-700 night:bg-night-raised night:text-night-second' },
  walkout: { label: 'Walkout', tone: 'bg-red-50 text-red-700 night:bg-red-500/15 night:text-red-400' },
  empty: { label: 'Nothing ordered', tone: 'bg-slate-100 text-slate-600 night:bg-night-raised night:text-night-muted' },
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export function OrdersView() {
  const [today, setToday] = useState<string | null>(null)
  const [preset, setPreset] = useState<Preset>('today')
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [status, setStatus] = useState<OrderStatus | ''>('')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [story, setStory] = useState<string | null>(null)

  const query = useCallback(() => {
    const params = new URLSearchParams()
    if (range) {
      params.set('from', range.from)
      params.set('to', range.to)
    }
    if (status) params.set('status', status)
    if (search.trim()) params.set('q', search.trim())
    return params.toString()
  }, [range, status, search])

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      call('GET', `/api/manage/orders?${query()}`, undefined, '/manage/orders')
        .then((json) => {
          if (!alive) return
          const payload = (json as { data: Payload }).data
          setData(payload)
          setError(null)
          setToday((current) => current ?? payload.to)
        })
        .catch((caught: unknown) => alive && setError(caught instanceof Error ? caught.message : 'Could not load the orders'))
        .finally(() => alive && setLoading(false))
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  function choose(next: Preset) {
    setPreset(next)
    if (!today || next === 'custom') return
    if (next === 'today') setRange({ from: today, to: today })
    if (next === 'yesterday') setRange({ from: shift(today, -1), to: shift(today, -1) })
    if (next === 'week') {
      const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
      setRange({ from: shift(today, -dow), to: today })
    }
    if (next === 'month') setRange({ from: `${today.slice(0, 8)}01`, to: today })
  }

  const filtered = status !== '' || search.trim() !== ''
  const multiDay = data ? data.from !== data.to : false

  return (
    <div className="flex flex-col gap-sp-4">
      <h1 className={cn('text-fs-24 font-extrabold', ink)}>Orders</h1>

      <div className="flex flex-wrap items-center gap-sp-2">
        <div className="flex gap-1 rounded-control bg-white p-1 night:bg-night-card">
          {(['today', 'yesterday', 'week', 'month', 'custom'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => choose(value)}
              className={cn('h-10 rounded-control px-sp-3 text-fs-14 font-bold', preset === value ? 'bg-brand-800 text-white night:bg-brand-500' : second)}
            >
              {value === 'today' ? 'Today' : value === 'yesterday' ? 'Yesterday' : value === 'week' ? 'This week' : value === 'month' ? 'This month' : 'Dates'}
            </button>
          ))}
        </div>
        {preset === 'custom' && today ? (
          <span className="flex items-center gap-sp-1">
            <input type="date" className={cn(input, 'w-40')} max={today} value={range?.from ?? today}
              onChange={(e) => e.target.value && setRange({ from: e.target.value, to: range?.to ?? today })} />
            <span className={second}>to</span>
            <input type="date" className={cn(input, 'w-40')} max={today} value={range?.to ?? today}
              onChange={(e) => e.target.value && setRange({ from: range?.from ?? e.target.value, to: e.target.value })} />
          </span>
        ) : null}
        <select className={cn(input, 'w-44')} value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | '')} aria-label="Status">
          <option value="">All orders</option>
          {(Object.keys(STATUS) as OrderStatus[]).map((key) => (
            <option key={key} value={key}>
              {STATUS[key].label}
            </option>
          ))}
        </select>
        <label className="relative flex items-center">
          <Search aria-hidden="true" className={cn('pointer-events-none absolute left-sp-3 size-4', muted)} />
          <input className={cn(input, 'w-56 pl-9')} placeholder="Order #, table or waiter" value={search}
            onChange={(e) => setSearch(e.target.value)} aria-label="Order number, table or waiter" />
        </label>
        {filtered ? (
          <button type="button" onClick={() => { setStatus(''); setSearch('') }} className={cn(secondary, 'inline-flex items-center gap-sp-1')}>
            <X className="size-4" aria-hidden="true" /> Clear filters
          </button>
        ) : null}
        {loading ? <span className={cn('text-fs-12', muted)}>Loading…</span> : null}
      </div>

      {error ? <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">{error}</p> : null}

      <section className="overflow-x-auto rounded-panel bg-white night:bg-night-card">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className={cn('text-fs-12 font-bold tracking-micro uppercase', muted)}>
              <th className="px-sp-4 py-sp-3">Order</th>
              <th className="px-sp-3 py-sp-3">Table</th>
              <th className="px-sp-3 py-sp-3">Waiter</th>
              <th className="px-sp-3 py-sp-3">Opened</th>
              <th className="px-sp-3 py-sp-3">Closed</th>
              <th className="px-sp-3 py-sp-3 text-right">Items</th>
              <th className="px-sp-3 py-sp-3 text-right">Total</th>
              <th className="px-sp-3 py-sp-3">Status</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {data?.orders.map((order, index) => {
              const newDay = multiDay && (index === 0 || data.orders[index - 1]!.businessDate !== order.businessDate)
              const s = STATUS[order.status]
              return [
                newDay ? (
                  <tr key={`d-${order.businessDate}`}>
                    <td colSpan={9} className={cn('bg-slate-50 px-sp-4 py-sp-1 text-fs-12 font-bold tracking-micro uppercase night:bg-night-raised', muted)}>
                      {dayLabel(order.businessDate)}
                    </td>
                  </tr>
                ) : null,
                <tr
                  key={order.sessionId}
                  onClick={() => setStory(order.sessionId)}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 night:border-night-hairline night:hover:bg-night-raised"
                >
                  <td className={cn('px-sp-4 py-sp-3 text-fs-14 font-extrabold tabular-nums', ink)}>
                    <button type="button" onClick={() => setStory(order.sessionId)} className="font-extrabold" aria-label={`Open order ${order.orderLabel}`}>
                      {order.orderLabel}
                    </button>
                  </td>
                  <td className={cn('px-sp-3 py-sp-3 text-fs-14 font-semibold', ink)}>{order.place}</td>
                  <td className={cn('px-sp-3 py-sp-3 text-fs-14', second)}>{order.waiter ?? '—'}</td>
                  <td className={cn('px-sp-3 py-sp-3 text-fs-14 tabular-nums', second)}>{time(order.openedAt)}</td>
                  <td className={cn('px-sp-3 py-sp-3 text-fs-14 tabular-nums', second)}>{order.closedAt ? time(order.closedAt) : '—'}</td>
                  <td className={cn('px-sp-3 py-sp-3 text-right text-fs-14 tabular-nums', second)}>{order.items}</td>
                  <td className={cn('px-sp-3 py-sp-3 text-right text-fs-14 font-bold tabular-nums', ink)}>{lkrFromPaisa(order.totalPaisa)}</td>
                  <td className="px-sp-3 py-sp-3">
                    <span className={cn('inline-flex rounded-pill px-sp-2 py-0.5 text-fs-12 font-bold', s.tone)}>{s.label}</span>
                    <span className={cn('ml-sp-2 text-fs-12', muted)}>
                      {order.status === 'paid' && order.paidBy ? order.paidBy : order.note ? `"${order.note}"` : ''}
                    </span>
                  </td>
                  <td className={cn('pr-sp-3', muted)}>
                    <ChevronRight aria-hidden="true" className="size-4" />
                  </td>
                </tr>,
              ]
            })}
          </tbody>
        </table>
        {data && data.orders.length === 0 ? <p className={cn('p-sp-5 text-fs-14', second)}>No orders for these filters.</p> : null}
        {data && data.orders.length > 0 ? (
          <div className={cn('flex flex-wrap justify-end gap-sp-5 border-t border-slate-200 px-sp-4 py-sp-3 text-fs-14 night:border-night-hairline', second)}>
            <span>
              {data.totals.orders} order{data.totals.orders === 1 ? '' : 's'}
            </span>
            {data.totals.openPaisa > 0 ? <span>Still open: <b className={ink}>{lkrFromPaisa(data.totals.openPaisa)}</b></span> : null}
            <span>
              Paid: <b className={ink}>{lkrFromPaisa(data.totals.paidPaisa)}</b>
            </span>
          </div>
        ) : null}
      </section>

      {story ? <OrderStory sessionId={story} onClose={() => setStory(null)} api="/api/manage/orders" returnTo="/manage/orders" /> : null}
    </div>
  )
}
