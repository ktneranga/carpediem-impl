'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react'
import { call as callApi, icon, input, primary } from '@/components/manage/manage-ui'
import { lkrFromPaisa } from '@/lib/format'
import { dailyOrderLabel } from '@/lib/order-number'
import type { Takings } from '@/types/tickets'
import { cn } from '@/lib/utils'

/**
 * Manage → End of day (Story 9.5): one business day's takings, what is still
 * open, and the no-sale drawer openings. Read-only; Print sends the same
 * figures to the receipt printer. The chosen day is kept in `?date=`.
 */

const call = (method: string, url: string, body?: unknown) => callApi(method, url, body, '/manage/end-of-day')

const money = (paisa: number) => `${paisa < 0 ? '-' : ''}${lkrFromPaisa(Math.abs(paisa))}`
const REASONS = { change: 'Change', float: 'Float', other: 'Other' } as const

/** `YYYY-MM-DD` ± days, in plain calendar arithmetic (no time zone involved). */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export function EndOfDay({ initialDate }: { initialDate: string | null }) {
  const [date, setDate] = useState<string | null>(initialDate)
  const [printNote, setPrintNote] = useState<string | null>(null)
  const [printing, setPrinting] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['manage-takings', date] as const,
    queryFn: async () =>
      ((await call('GET', `/api/manage/end-of-day${date ? `?date=${date}` : ''}`)) as {
        data: { today: string; takings: Takings }
      }).data,
  })
  const today = data?.today ?? null
  const shown = data?.takings.businessDate ?? date

  function choose(next: string) {
    if (today && next > today) return
    setDate(next)
    setPrintNote(null)
    try {
      window.history.replaceState(null, '', next === today ? '/manage/end-of-day' : `/manage/end-of-day?date=${next}`)
    } catch {
      // The URL is a convenience; the screen works without it.
    }
  }

  async function print() {
    if (!shown) return
    setPrinting(true)
    setPrintNote(null)
    try {
      await call('POST', '/api/manage/end-of-day/print', { date: shown })
      setPrintNote('Sent to the printer')
    } catch (failure) {
      setPrintNote(failure instanceof Error ? failure.message : 'Could not send it to the printer')
    } finally {
      setPrinting(false)
    }
  }

  const t = data?.takings
  return (
    <div className="flex flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <div className="flex flex-wrap items-center gap-sp-2">
          <h1 className="mr-sp-2 text-fs-24 font-extrabold text-slate-900 night:text-night-text">End of day</h1>
          <button type="button" aria-label="Previous day" className={icon} disabled={!shown} onClick={() => shown && choose(shiftDate(shown, -1))}>
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <input
            type="date"
            aria-label="Business day"
            className={input}
            value={shown ?? ''}
            max={today ?? undefined}
            onChange={(e) => e.target.value && choose(e.target.value)}
          />
          <button
            type="button"
            aria-label="Next day"
            className={icon}
            disabled={!shown || !today || shown >= today}
            onClick={() => shown && choose(shiftDate(shown, 1))}
          >
            <ChevronRight className="size-5" aria-hidden="true" />
          </button>
          {shown && shown === today ? <span className="text-fs-14 font-semibold text-slate-600 night:text-night-second">Today</span> : null}
        </div>
        <div className="flex items-center gap-sp-3">
          {printNote ? <span role="status" className="text-fs-14 font-semibold text-slate-600 night:text-night-second">{printNote}</span> : null}
          <button type="button" className={primary} disabled={!t || printing} onClick={() => void print()}>
            <Printer className="size-4" aria-hidden="true" /> Print
          </button>
        </div>
      </header>

      {isLoading ? <p className="text-fs-14 text-slate-600 night:text-night-second">Loading the takings…</p> : null}
      {error ? (
        <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">
          {error instanceof Error ? error.message : 'Could not load the takings.'}
        </p>
      ) : null}

      {t ? (
        <>
          {t.orders === 0 && t.openOrders.length === 0 ? (
            <p className="rounded-panel bg-white p-sp-4 text-fs-16 text-slate-600 night:bg-night-card night:text-night-second">No orders on this day.</p>
          ) : null}

          <div className="grid gap-sp-4 lg:grid-cols-2">
            <Card title="Sales">
              <Row label="Orders" value={String(t.orders)} />
              <Row label="Items" value={money(t.itemsPaisa)} />
              {t.compsPaisa !== 0 ? <Row label="Comps" value={money(t.compsPaisa)} /> : null}
              <Row label="Subtotal" value={money(t.subtotalPaisa)} />
              <Row label="Service charge" value={money(t.serviceChargePaisa)} />
              <Row label="Tax" value={money(t.taxPaisa)} />
              <Row label="Total billed" value={money(t.billedPaisa)} strong />
            </Card>
            <Card title="Paid">
              <Row label="Cash" value={money(t.paid.cashPaisa)} />
              <Row label="Card" value={money(t.paid.cardPaisa)} />
              {t.paid.transferPaisa !== 0 ? <Row label="Bank transfer" value={money(t.paid.transferPaisa)} /> : null}
              <Row label="Total paid" value={money(t.paid.totalPaisa)} strong />
              {t.cashCount ? (
                <>
                  <Row label="Cash counted" value={money(t.cashCount.countedPaisa)} />
                  <Row
                    label={t.cashCount.gapPaisa === 0 ? 'Cash balanced' : t.cashCount.gapPaisa > 0 ? 'Cash over' : 'Cash short'}
                    value={t.cashCount.gapPaisa === 0 ? '✓' : money(t.cashCount.gapPaisa)}
                    warn={t.cashCount.gapPaisa !== 0}
                  />
                </>
              ) : null}
              {t.closedUnpaid.count > 0 ? (
                <Row label={`Closed unpaid (${t.closedUnpaid.count})`} value={money(t.closedUnpaid.owedPaisa)} warn />
              ) : null}
            </Card>
          </div>

          <Card title={`Still open (${t.openOrders.length})`}>
            {t.openOrders.length === 0 ? (
              <p className="py-sp-2 text-fs-14 text-slate-600 night:text-night-second">Every order of this day is closed.</p>
            ) : (
              <>
                <p className="pb-sp-2 text-fs-14 text-amber-900 night:text-amber-300">These orders are not in the totals until they are paid.</p>
                {t.openOrders.map((order) => (
                  <div key={order.dailyNumber} className="flex min-h-11 flex-wrap items-center gap-sp-3 border-t border-slate-100 py-sp-2 night:border-night-hairline">
                    <span className="w-16 text-fs-16 font-bold text-slate-900 tabular-nums night:text-night-text">{dailyOrderLabel(order.dailyNumber)}</span>
                    <span className="min-w-0 flex-1 text-fs-16 text-slate-900 night:text-night-text">{order.tables.join(' + ')}</span>
                    <span className="text-fs-14 text-slate-600 night:text-night-second">
                      {time(order.openedAt)} · {order.openedBy}
                    </span>
                  </div>
                ))}
              </>
            )}
          </Card>

          <Card title={`No-sale drawer openings (${t.noSales.length})`}>
            {t.noSales.length === 0 ? (
              <p className="py-sp-2 text-fs-14 text-slate-600 night:text-night-second">The drawer was only opened for cash payments.</p>
            ) : (
              t.noSales.map((opening, index) => (
                <div key={index} className="flex min-h-11 flex-wrap items-center gap-sp-3 border-t border-slate-100 py-sp-2 night:border-night-hairline">
                  <span className="w-16 text-fs-14 font-semibold text-slate-900 tabular-nums night:text-night-text">{time(opening.openedAt)}</span>
                  <span className="text-fs-16 text-slate-900 night:text-night-text">{opening.staffName}</span>
                  <span className="min-w-0 flex-1 text-fs-14 text-slate-600 night:text-night-second">
                    {opening.reason === 'other' ? opening.note : REASONS[opening.reason]}
                  </span>
                </div>
              ))
            )}
          </Card>
        </>
      ) : null}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col rounded-panel bg-white p-sp-4 night:bg-night-card">
      <h2 className="pb-sp-2 text-fs-14 font-bold tracking-micro text-slate-500 uppercase night:text-night-muted">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div
      className={cn(
        'flex min-h-10 items-center justify-between gap-sp-3 border-t border-slate-100 text-fs-16 night:border-night-hairline',
        strong ? 'font-extrabold text-slate-900 night:text-night-text' : 'text-slate-700 night:text-night-second',
        warn ? 'font-semibold text-amber-900 night:text-amber-300' : '',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}
