'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  ArrowLeftRight,
  Ban,
  Banknote,
  BadgePercent,
  ChevronRight,
  Download,
  Landmark,
  Receipt,
  Search,
  Send,
  Settings,
  UserCog,
  X,
  type LucideIcon,
} from 'lucide-react'
import { call, input, secondary } from '@/components/manage/manage-ui'
import { lkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { AuditCounts, AuditEntry, AuditKind } from '@/server/services/audit.service'

/**
 * Manage → Audit (Story 7.6, Teran 2026-11-17): who did what and when, and the
 * whole story of any order. Read-only.
 */

type Payload = {
  from: string
  to: string
  entries: AuditEntry[]
  counts: AuditCounts
  truncated: boolean
  staff: { id: string; name: string; isActive: boolean }[]
  kinds: Record<AuditKind, string>
}

const KIND_ICONS: Record<AuditKind, LucideIcon> = {
  orders: Send,
  corrections: Ban,
  cancels: X,
  tables: ArrowLeftRight,
  money: Banknote,
  discounts: BadgePercent,
  drawer: Landmark,
  settings: Settings,
  staff: UserCog,
}

const ink = 'text-slate-900 night:text-night-text'
const second = 'text-slate-600 night:text-night-second'
const muted = 'text-slate-500 night:text-night-muted'
const card = 'rounded-panel bg-white night:bg-night-card'

const time = (iso: string, seconds = false) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const signed = (paisa: number) => `${paisa < 0 ? '− ' : ''}${lkrFromPaisa(Math.abs(paisa))}`

/** `YYYY-MM-DD` shifted by whole days. */
function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom'

export function AuditView() {
  const [today, setToday] = useState<string | null>(null)
  const [preset, setPreset] = useState<Preset>('today')
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [staffId, setStaffId] = useState('')
  const [kinds, setKinds] = useState<AuditKind[]>([])
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
    if (staffId) params.set('staff', staffId)
    if (kinds.length) params.set('kinds', kinds.join(','))
    if (search.trim()) params.set('q', search.trim())
    return params.toString()
  }, [range, staffId, kinds, search])

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      call('GET', `/api/manage/audit?${query()}`, undefined, '/manage/audit')
        .then((json) => {
          if (!alive) return
          const payload = (json as { data: Payload }).data
          setData(payload)
          setError(null)
          // The first answer is today, as the restaurant counts days.
          setToday((current) => current ?? payload.to)
        })
        .catch((caught: unknown) => alive && setError(caught instanceof Error ? caught.message : 'Could not load the audit log'))
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

  const counts = data?.counts
  const filtered = kinds.length > 0 || staffId !== '' || search.trim() !== ''
  const clearFilters = () => {
    setKinds([])
    setStaffId('')
    setSearch('')
  }
  // A pill filters the log to its kind; tapping it again — or its × — clears
  // that (Teran, 2026-11-17: a chosen pill must be easy to undo).
  const tile = (label: string, value: string, kind: AuditKind, alert: boolean) => {
    const active = kinds.length === 1 && kinds[0] === kind
    return (
      <button
        type="button"
        onClick={() => setKinds(active ? [] : [kind])}
        aria-pressed={active}
        title={active ? 'Show everything again' : `Show only ${label}`}
        className={cn(
          'relative flex min-h-16 flex-col items-start justify-center rounded-panel px-sp-4 pr-sp-7 text-left',
          active ? 'bg-brand-050 ring-2 ring-brand-700 night:bg-night-raised' : 'bg-white night:bg-night-card',
        )}
      >
        <span className={cn('text-fs-20 font-extrabold tabular-nums', alert ? 'text-amber-800 night:text-amber-300' : ink)}>{value}</span>
        <span className={cn('text-fs-12 font-semibold', second)}>{label}</span>
        {active ? (
          <span aria-hidden="true" className="absolute top-sp-2 right-sp-2 flex size-6 items-center justify-center rounded-pill bg-brand-700 text-white">
            <X className="size-4" />
          </span>
        ) : null}
      </button>
    )
  }

  const multiDay = data ? data.from !== data.to : false

  return (
    <div className="flex flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <h1 className={cn('text-fs-24 font-extrabold', ink)}>Audit</h1>
        <a href={`/api/manage/audit/export?${query()}`} className={cn(secondary, 'inline-flex items-center gap-sp-2')}>
          <Download className="size-4" aria-hidden="true" /> Export to Excel
        </a>
      </header>

      {counts ? (
        <div className="grid grid-cols-2 gap-sp-3 lg:grid-cols-4">
          {tile('voids', String(counts.voids), 'corrections', counts.voids > 0)}
          {tile('cancels & walkouts', String(counts.cancels), 'cancels', counts.cancels > 0)}
          {tile('drawer opened, no sale', String(counts.drawerNoSale), 'drawer', false)}
          {tile('discounts given', lkrFromPaisa(counts.discountsPaisa), 'discounts', false)}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-sp-2">
        <div className={cn('flex gap-1 rounded-control p-1', 'bg-white night:bg-night-card')}>
          {(['today', 'yesterday', 'week', 'month', 'custom'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => choose(value)}
              className={cn(
                'h-10 rounded-control px-sp-3 text-fs-14 font-bold',
                preset === value ? 'bg-brand-800 text-white night:bg-brand-500' : second,
              )}
            >
              {value === 'today' ? 'Today' : value === 'yesterday' ? 'Yesterday' : value === 'week' ? 'This week' : value === 'month' ? 'This month' : 'Dates'}
            </button>
          ))}
        </div>
        {preset === 'custom' && today ? (
          <span className="flex items-center gap-sp-1">
            <input
              type="date"
              className={cn(input, 'w-40')}
              max={today}
              value={range?.from ?? today}
              onChange={(e) => e.target.value && setRange({ from: e.target.value, to: range?.to ?? today })}
            />
            <span className={second}>to</span>
            <input
              type="date"
              className={cn(input, 'w-40')}
              max={today}
              value={range?.to ?? today}
              onChange={(e) => e.target.value && setRange({ from: range?.from ?? e.target.value, to: e.target.value })}
            />
          </span>
        ) : null}
        <select className={cn(input, 'w-44')} value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Staff">
          <option value="">All staff</option>
          {data?.staff.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
              {person.isActive ? '' : ' (left)'}
            </option>
          ))}
        </select>
        <select
          className={cn(input, 'w-48')}
          value={kinds.length === 1 ? kinds[0] : ''}
          onChange={(e) => setKinds(e.target.value ? [e.target.value as AuditKind] : [])}
          aria-label="Type"
        >
          <option value="">All types</option>
          {data
            ? (Object.entries(data.kinds) as [AuditKind, string][]).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))
            : null}
        </select>
        <label className="relative flex items-center">
          <Search aria-hidden="true" className={cn('pointer-events-none absolute left-sp-3 size-4', muted)} />
          <input
            className={cn(input, 'w-48 pl-9')}
            placeholder="Order # or table"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Order number or table"
          />
        </label>
        {filtered ? (
          <button type="button" onClick={clearFilters} className={cn(secondary, 'inline-flex items-center gap-sp-1')}>
            <X className="size-4" aria-hidden="true" /> Clear filters
          </button>
        ) : null}
        {loading ? <span className={cn('text-fs-12', muted)}>Loading…</span> : null}
      </div>

      {error ? <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">{error}</p> : null}

      <section className={cn(card, 'flex flex-col')}>
        {data && data.entries.length === 0 ? (
          <p className={cn('p-sp-5 text-fs-14', second)}>Nothing recorded for these filters.</p>
        ) : null}
        <ul className="flex flex-col">
          {data?.entries.map((entry, index) => {
            const Icon = KIND_ICONS[entry.kind]
            const newDay = multiDay && (index === 0 || day(data.entries[index - 1]!.at) !== day(entry.at))
            return (
              <li key={entry.id}>
                {newDay ? (
                  <p className={cn('bg-slate-50 px-sp-4 py-sp-1 text-fs-12 font-bold tracking-micro uppercase night:bg-night-raised', muted)}>
                    {day(entry.at)}
                  </p>
                ) : null}
                <div className="flex min-h-14 items-center gap-sp-3 border-t border-slate-100 px-sp-4 py-sp-2 night:border-night-hairline">
                  <span className={cn('w-12 shrink-0 text-fs-14 font-bold tabular-nums', ink)}>{time(entry.at)}</span>
                  <span className={cn('w-24 shrink-0 truncate text-fs-14', second)}>{entry.staffName}</span>
                  <Icon aria-hidden="true" className={cn('size-4 shrink-0', muted)} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn('truncate text-fs-14 font-semibold', ink)}>{entry.text}</span>
                    {entry.detail ? <span className={cn('truncate text-fs-12', muted)}>{entry.detail}</span> : null}
                  </span>
                  {entry.amountPaisa !== null && entry.kind !== 'drawer' ? (
                    <span className={cn('shrink-0 text-fs-14 font-bold tabular-nums', entry.amountPaisa < 0 ? 'text-red-700 night:text-red-400' : ink)}>
                      {signed(entry.amountPaisa)}
                    </span>
                  ) : null}
                  {entry.sessionId ? (
                    <button
                      type="button"
                      onClick={() => setStory(entry.sessionId)}
                      className={cn(
                        'flex h-11 shrink-0 items-center gap-sp-1 rounded-control px-sp-2 text-fs-14 font-bold text-brand-700 hover:bg-brand-050 night:text-brand-300 night:hover:bg-night-raised',
                      )}
                      aria-label={`Open the story of order ${entry.orderLabel ?? ''}`}
                    >
                      {entry.orderLabel}
                      {entry.place ? <span className={cn('font-semibold', second)}>{entry.place}</span> : null}
                      {entry.waiter ? <span className={cn('font-semibold', muted)}>· {entry.waiter}</span> : null}
                      <ChevronRight aria-hidden="true" className="size-4" />
                    </button>
                  ) : (
                    <span className="w-11 shrink-0" />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        {data?.truncated ? (
          <p className={cn('border-t border-slate-100 p-sp-3 text-fs-12 night:border-night-hairline', muted)}>
            Showing the latest 1,000. Narrow the dates or filters, or export to Excel for all of it.
          </p>
        ) : null}
      </section>

      {story ? <OrderStory sessionId={story} onClose={() => setStory(null)} /> : null}
    </div>
  )
}

/**
 * An order's whole life, oldest first, in a side panel (Story 7.6). Shared
 * with Manage → Orders (7.7), which reads it through its own area's API.
 */
export function OrderStory({
  sessionId,
  onClose,
  api = '/api/manage/audit/order',
  returnTo = '/manage/audit',
}: {
  sessionId: string
  onClose: () => void
  api?: string
  returnTo?: string
}) {
  const [data, setData] = useState<{ title: string; waiter: string | null; entries: AuditEntry[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    call('GET', `${api}/${sessionId}`, undefined, returnTo)
      .then((json) => alive && setData((json as { data: { title: string; waiter: string | null; entries: AuditEntry[] } }).data))
      .catch((caught: unknown) => alive && setError(caught instanceof Error ? caught.message : 'Could not load the order'))
    return () => {
      alive = false
    }
  }, [api, returnTo, sessionId])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-story-title"
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <aside
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-el-2 night:bg-night-card"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-sp-3 border-b border-slate-200 px-sp-5 py-sp-4 night:border-night-hairline">
          <h2 id="order-story-title" className={cn('text-fs-20 font-extrabold', ink)}>
            <Receipt aria-hidden="true" className="mr-sp-2 inline size-5 align-[-3px]" />
            {data?.title ?? 'Order'}
            {data?.waiter ? <span className={cn('block text-fs-14 font-semibold', second)}>Waiter: {data.waiter}</span> : null}
          </h2>
          <button type="button" autoFocus onClick={onClose} aria-label="Close" className={cn('flex size-11 items-center justify-center rounded-control', second)}>
            <X aria-hidden="true" className="size-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-sp-5 py-sp-3">
          {error ? <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">{error}</p> : null}
          {!data && !error ? <p className={cn('text-fs-14', second)}>Loading…</p> : null}
          <ol className="flex flex-col">
            {data?.entries.map((entry, index) => {
              const Icon = KIND_ICONS[entry.kind]
              const newDay = index === 0 || day(data.entries[index - 1]!.at) !== day(entry.at)
              return (
                <li key={entry.id}>
                  {newDay ? <p className={cn('pt-sp-2 text-fs-12 font-bold tracking-micro uppercase', muted)}>{day(entry.at)}</p> : null}
                  <div className="flex gap-sp-3 border-b border-slate-100 py-sp-2 night:border-night-hairline">
                    <span className={cn('w-16 shrink-0 text-fs-14 font-bold tabular-nums', ink)}>{time(entry.at, true)}</span>
                    <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', muted)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn('text-fs-14 font-semibold', ink)}>{entry.text}</span>
                      {entry.detail ? <span className={cn('text-fs-12', second)}>{entry.detail}</span> : null}
                      <span className={cn('text-fs-12', muted)}>{entry.staffName}</span>
                    </span>
                    {entry.amountPaisa !== null ? (
                      <span className={cn('shrink-0 text-fs-14 font-bold tabular-nums', entry.amountPaisa < 0 ? 'text-red-700 night:text-red-400' : ink)}>
                        {signed(entry.amountPaisa)}
                      </span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      </aside>
    </div>
  )
}
