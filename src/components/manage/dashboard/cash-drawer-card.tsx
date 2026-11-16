'use client'

import type { ReactNode } from 'react'
import { Banknote, TriangleAlert } from 'lucide-react'
import { Panel, tone } from '@/components/manage/dashboard/panel'
import { lkrFromPaisa } from '@/lib/format'
import type { Insights } from '@/server/services/insights.service'
import { cn } from '@/lib/utils'

/**
 * The day's cash in one place (Teran, 2026-11-16): the morning float, cash
 * sales, what was taken out, what should be in the drawer, what was counted,
 * and the gap — in that order, each line with its time and who. Card and
 * transfer are shown apart, so revenue is whole without muddying the drawer.
 * A week or month is a row per day.
 */

const money = (paisa: number) => `${paisa < 0 ? '− ' : ''}${lkrFromPaisa(Math.abs(paisa))}`
const signed = (paisa: number) => `${paisa > 0 ? '+ ' : paisa < 0 ? '− ' : ''}${lkrFromPaisa(Math.abs(paisa))}`
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

const MOVEMENT_NAMES: Record<string, string> = {
  float: 'Morning float',
  pay_in: 'Cash put in',
  cash_drop: 'Cash drop',
  paid_out: 'Paid out',
  other: 'Other',
}

export function CashDrawerCard({ data, countAction }: { data: Insights; countAction?: ReactNode }) {
  const single = data.from === data.to
  return (
    <Panel
      title="Cash drawer"
      icon={Banknote}
      subtitle={single ? 'float, cash sales, cash out, and the count' : 'day by day'}
      minHeight="min-h-40"
    >
      {single ? <SingleDay data={data} countAction={countAction} /> : <ByDay data={data} />}
    </Panel>
  )
}

function SingleDay({ data, countAction }: { data: Insights; countAction?: ReactNode }) {
  const day = data.cash.byDay[0]
  if (!day) return null
  // Each amount the drawer moved by, with when and who; Change opens move none.
  const movements = (data.noSales ?? []).filter((entry) => entry.amountPaisa != null && entry.amountPaisa !== 0)
  const floats = movements.filter((entry) => entry.reason === 'float' || entry.reason === 'pay_in')
  const outs = movements.filter((entry) => entry.reason !== 'float' && entry.reason !== 'pay_in')
  const noMoney = (data.noSales ?? []).filter((entry) => entry.amountPaisa == null || entry.amountPaisa === 0)
  const pay = data.payments
  const nonCash = pay.cardPaisa + pay.transferPaisa

  return (
    <div className="flex flex-col">
      {floats.length === 0 ? (
        <p className="mb-sp-2 flex items-center gap-sp-2 rounded-control bg-amber-50 px-sp-3 py-sp-2 text-fs-14 font-semibold text-amber-900 night:bg-amber-500/15 night:text-amber-300">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          No float recorded {data.period === 'today' ? 'today' : 'that day'}
        </p>
      ) : null}

      {floats.map((entry, index) => (
        <Line
          key={`in-${index}`}
          label={MOVEMENT_NAMES[entry.reason] ?? 'Cash in'}
          detail={`${time(entry.openedAt)} ${entry.staffName}${entry.note ? ` · ${entry.note}` : ''}`}
          value={signed(entry.amountPaisa!)}
        />
      ))}
      <Line label="Cash sales" value={signed(day.cashSalesPaisa)} />
      {outs.map((entry, index) => (
        <Line
          key={`out-${index}`}
          label={MOVEMENT_NAMES[entry.reason] ?? 'Cash out'}
          detail={`${time(entry.openedAt)} ${entry.staffName}${entry.note ? ` · ${entry.note}` : ''}`}
          value={signed(entry.amountPaisa!)}
        />
      ))}

      <Line label="Should be in drawer" value={money(day.expectedPaisa)} strong rule />
      {day.counted ? (
        <Line label="Counted" detail={`${time(day.counted.at)} ${day.counted.by}`} value={money(day.counted.paisa)} />
      ) : (
        <Line label="Counted" value="not yet" muted />
      )}

      <Gap gap={day.gapPaisa} />
      {countAction ? <div className="pt-sp-2">{countAction}</div> : null}

      <div className={cn('mt-sp-3 border-t pt-sp-2', tone.hairline)}>
        <Line label="Card & transfer (not in drawer)" value={money(nonCash)} muted />
        <Line label="Total revenue" value={money(pay.settledPaisa)} strong />
      </div>

      {noMoney.length > 0 ? (
        <p className={cn('mt-sp-2 text-fs-12', tone.muted)}>
          Opened with no money in or out:{' '}
          {noMoney.map((entry) => `${time(entry.openedAt)} ${entry.staffName}${entry.note ? ` (${entry.note})` : ''}`).join(' · ')}
        </p>
      ) : null}
    </div>
  )
}

function ByDay({ data }: { data: Insights }) {
  const head = cn('px-sp-2 py-sp-1 text-right text-fs-12 font-bold whitespace-nowrap', tone.muted)
  const cell = cn('px-sp-2 py-sp-1 text-right text-fs-14 tabular-nums whitespace-nowrap', tone.ink)
  const rows = [...data.cash.byDay].reverse()
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={cn(head, 'text-left')}>Day</th>
            <th className={head}>Float</th>
            <th className={head}>Cash sales</th>
            <th className={head}>Cash out</th>
            <th className={head}>Should be</th>
            <th className={head}>Counted</th>
            <th className={head}>Gap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((day) => (
            <tr key={day.day} className={cn('border-t', tone.hairline)}>
              <td className={cn(cell, 'text-left font-semibold')}>{dayLabel(day.day)}</td>
              <td className={cn(cell, day.inPaisa === 0 && 'text-amber-800 night:text-amber-300')}>
                {day.inPaisa === 0 ? 'none' : lkrFromPaisa(day.inPaisa)}
              </td>
              <td className={cell}>{lkrFromPaisa(day.cashSalesPaisa)}</td>
              <td className={cell}>{day.outPaisa + Math.min(0, day.otherPaisa) === 0 ? '—' : money(day.outPaisa + Math.min(0, day.otherPaisa))}</td>
              <td className={cn(cell, 'font-bold')}>{lkrFromPaisa(day.expectedPaisa)}</td>
              <td className={cell}>{day.counted ? lkrFromPaisa(day.counted.paisa) : '—'}</td>
              <td
                className={cn(
                  cell,
                  'font-bold',
                  day.gapPaisa === null ? tone.muted : day.gapPaisa === 0 ? tone.good : tone.bad,
                )}
              >
                {day.gapPaisa === null ? '—' : day.gapPaisa === 0 ? 'OK' : signed(day.gapPaisa)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Gap({ gap }: { gap: number | null }) {
  if (gap === null) {
    return <Line label="Gap" value="count the cash to see" muted />
  }
  const ok = gap === 0
  return (
    <div
      className={cn(
        'mt-sp-1 flex min-h-11 items-center justify-between gap-sp-3 rounded-control px-sp-3 text-fs-16 font-extrabold',
        ok ? 'bg-open-chip text-open-ink night:bg-green-500/20 night:text-green-400' : 'bg-red-50 text-red-700 night:bg-red-500/15 night:text-red-400',
      )}
    >
      <span className="flex items-center gap-sp-2">
        <span aria-hidden="true" className="size-2 rounded-pill bg-current" />
        {ok ? 'Balanced' : gap < 0 ? 'Short' : 'Over'}
      </span>
      <span className="tabular-nums">{ok ? '' : signed(gap)}</span>
    </div>
  )
}

function Line({
  label,
  detail,
  value,
  strong,
  muted,
  rule,
}: {
  label: string
  detail?: string
  value: string
  strong?: boolean
  muted?: boolean
  rule?: boolean
}) {
  return (
    <div
      className={cn(
        'flex min-h-9 items-center justify-between gap-sp-3 text-fs-14',
        rule && cn('mt-sp-1 border-t pt-sp-1', tone.hairline),
        strong ? cn('font-extrabold', tone.ink) : muted ? tone.muted : tone.second,
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {detail ? <span className={cn('truncate text-fs-12 font-normal', tone.muted)}>{detail}</span> : null}
      </span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  )
}
