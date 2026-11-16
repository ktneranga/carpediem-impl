import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { listNoSaleOpenings } from '@/server/services/cash-drawer.service'
import { checkTakingsDate, loadSales, openOrderPlace, type Sales } from '@/server/services/takings.service'

/**
 * The owner dashboard's figures for a period (Teran, 2026-11-13 — the Carpe
 * Diem dashboard mock-up): today, yesterday, this week (Monday → today) or this
 * month (1st → today), each against the same span before it.
 *
 * ── Which day, which money ───────────────────────────────────────────────────
 * Days are BUSINESS dates (`order_sessions.business_date`, turnover at
 * `business_day_start_hour`), as on End of day (9.5). "Recorded" revenue is
 * what was billed (`bills.total_paisa`); "settled" is what was paid
 * (`payment_records`). Nothing is re-priced. Integer paisa throughout.
 *
 * ── Comparing a day still running ────────────────────────────────────────────
 * When the period includes today, the earlier span is cut at the same moment
 * (`created_at < now() − shift`), so 9 PM tonight is compared with 9 PM last
 * week, not with last week's whole night.
 *
 * ── One source with the end-of-day slip ──────────────────────────────────────
 * Revenue, payments, comps and the sales breakdown come from `loadSales`, the
 * function the printed slip uses too. End of day lives on this screen (merged
 * 2026-11-14): any single day — `day` with a date — also carries its no-sale
 * drawer openings.
 */

type Executor = typeof db
export type Period = 'today' | 'yesterday' | 'week' | 'month' | 'day'
export const PERIODS: Period[] = ['today', 'yesterday', 'week', 'month', 'day']

export type CashDay = {
  day: string
  inPaisa: number
  cashSalesPaisa: number
  outPaisa: number
  otherPaisa: number
  /** cash sales + in + out + other: what should be in the drawer. */
  expectedPaisa: number
  counted: { paisa: number; at: string; by: string } | null
  /** counted − expected; null when not counted. */
  gapPaisa: number | null
}

export type Insights = {
  period: Period
  from: string
  to: string
  today: string
  restaurantName: string
  /** e.g. "vs last Mon", "vs last week". */
  compareLabel: string
  recorded: { paisa: number; comparePaisa: number; changePercent: number | null }
  /** Hours of the business day (day periods) or days (week, month). */
  buckets: { kind: 'hour' | 'day'; items: { key: string; label: string; paisa: number }[]; peakKey: string | null }
  cash: {
    expectedPaisa: number
    /** Days with a count / days in the period. */
    daysCounted: number
    days: number
    /** Sum of (counted − expected) over the counted days; null when none. */
    gapPaisa: number | null
    /** For a single day: the latest count. */
    count: { countedPaisa: number; countedAt: string; countedBy: string } | null
    /**
     * The drawer, day by day (Teran, 2026-11-16) — the Cash drawer card.
     * Every day of the period up to today, oldest first. `inPaisa` is the
     * float and any cash put in; `outPaisa` (≤ 0) cash drops and paid-outs;
     * `otherPaisa` an Other with an amount, either sign.
     */
    byDay: CashDay[]
  }
  covers: { count: number; averagePaisa: number | null }
  comps: {
    totalPaisa: number
    percentOfRevenue: number | null
    lines: number
    byReason: { reason: string; approver: string; paisa: number; count: number }[]
  }
  payments: { settledPaisa: number; cashPaisa: number; cardPaisa: number; transferPaisa: number }
  /** Items, comps, subtotal, service, tax, billed — as on the printed slip. */
  sales: Sales
  /** Single-day views only: no-sale drawer openings, oldest first. */
  noSales: { openedAt: string; staffName: string; reason: 'change' | 'float' | 'other' | 'pay_in' | 'paid_out' | 'cash_drop'; note: string | null; amountPaisa: number | null }[] | null
  topItems: { name: string; quantity: number; paisa: number }[]
  audit: {
    kind: 'unclosed' | 'walkout' | 'abandoned' | 'correction' | 'cancelled' | 'order_cancelled'
    title: string
    detail: string
    at: string
    /** What a walkout still owed; a cancelled bill's total. */
    amountPaisa?: number
  }[]
}

async function rows<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as T[]
}

const n = (value: unknown) => Number(value ?? 0)
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const weekday = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!

/** The period's business dates, and the earlier span it is compared with. */
function rangeOf(period: Period, today: string, date: string) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7 // Monday = 0
  switch (period) {
    case 'today':
      return { from: today, to: today, shift: '7 days', compareLabel: `vs last ${weekday(today)}`, live: true }
    case 'yesterday': {
      const day = shiftDate(today, -1)
      return { from: day, to: day, shift: '7 days', compareLabel: `vs last ${weekday(day)}`, live: false }
    }
    case 'week':
      return { from: shiftDate(today, -dow), to: today, shift: '7 days', compareLabel: 'vs last week', live: true }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today, shift: '1 month', compareLabel: 'vs last month', live: true }
    case 'day':
      return { from: date, to: date, shift: '7 days', compareLabel: `vs the ${weekday(date)} before`, live: false }
  }
}

export function checkPeriod(value: string | null): Period {
  if (value === null) return 'today'
  if (!(PERIODS as string[]).includes(value)) throw new MenuRuleError('Choose today, yesterday, week, month or a day')
  return value as Period
}

/**
 * `date` is required for `day` (a past day; today or yesterday become those
 * periods, so their tab lights up) and ignored otherwise.
 */
export async function loadInsights(executor: Executor, tenantId: string, asked: Period, date: string | null = null): Promise<Insights> {
  const [clock] = await rows<{ today: string; start_hour: number; name: string | null; tenant_name: string }>(executor, sql`
    select business_date_at(t.id, now())::text as today, t.business_day_start_hour as start_hour,
           c.restaurant_name as name, t.name as tenant_name
      from tenants t left join tenant_config c on c.tenant_id = t.id
     where t.id = ${tenantId}`)
  if (!clock) throw new Error('No such tenant')
  let period = asked
  let day = clock.today
  if (period === 'day') {
    if (!date) throw new MenuRuleError('Choose a day')
    day = await checkTakingsDate(executor, tenantId, date)
    if (day === clock.today) period = 'today'
    else if (day === shiftDate(clock.today, -1)) period = 'yesterday'
  }
  const { from, to, shift, compareLabel, live } = rangeOf(period, clock.today, day)
  const startHour = n(clock.start_hour)
  const sessions = sql`(select id from order_sessions
    where tenant_id = ${tenantId} and business_date between ${from}::date and ${to}::date)`
  const compareSessions = sql`(select id from order_sessions
    where tenant_id = ${tenantId}
      and business_date between (${from}::date - ${shift}::interval)::date and (${to}::date - ${shift}::interval)::date)`
  const dayPeriod = from === to

  const [sales, noSales, compare, buckets, expected, counts, covers, compReasons, topItems, unclosed, closedUnpaid, corrections, cancelledBills] =
    await Promise.all([
      loadSales(executor, { tenantId, from, to }),
      dayPeriod ? listNoSaleOpenings(executor, { tenantId, businessDate: from }) : Promise.resolve(null),
      rows<{ n: number }>(executor, sql`
        select coalesce(sum(total_paisa), 0)::bigint as n from bills
         where session_id in ${compareSessions} and cancelled_at is null
           ${live ? sql`and created_at < now() - ${shift}::interval` : sql``}`),
      dayPeriod
        ? rows<{ key: string; n: number }>(executor, sql`
            select ((extract(hour from b.created_at at time zone t.timezone)::int - t.business_day_start_hour + 24) % 24)::text as key,
                   sum(b.total_paisa)::bigint as n
              from bills b join tenants t on t.id = b.tenant_id
             where b.session_id in ${sessions} and b.cancelled_at is null
             group by 1`)
        : rows<{ key: string; n: number }>(executor, sql`
            select s.business_date::text as key, sum(b.total_paisa)::bigint as n
              from bills b join order_sessions s on s.id = b.session_id
             where b.session_id in ${sessions} and b.cancelled_at is null
             group by 1`),
      // The drawer by day (Teran, 2026-11-16): cash payments, and every amount
      // put in or taken out, by kind — each on its business day.
      rows<{ day: string; kind: string; n: number }>(executor, sql`
        select day, kind, coalesce(sum(n), 0)::bigint as n from (
          select s.business_date::text as day, 'sales' as kind, p.amount_paisa as n
            from payment_records p join order_sessions s on s.id = p.session_id
           where p.session_id in ${sessions} and p.method = 'cash'
          union all
          select business_date_at(o.tenant_id, o.created_at)::text as day,
                 case when o.reason::text in ('float', 'pay_in') then 'in'
                      when o.reason::text in ('cash_drop', 'paid_out') then 'out'
                      else 'other' end as kind,
                 o.amount_paisa as n
            from cash_drawer_openings o
           where o.tenant_id = ${tenantId} and o.amount_paisa is not null
             and business_date_at(o.tenant_id, o.created_at) between ${from}::date and ${to}::date
        ) moved
         group by 1, 2`),
      rows<{ day: string; counted: number; at: Date; by: string }>(executor, sql`
        select distinct on (c.business_date) c.business_date::text as day, c.counted_paisa as counted,
               c.created_at as at, s.name as by
          from cash_counts c join staff s on s.id = c.staff_id
         where c.tenant_id = ${tenantId} and c.business_date between ${from}::date and ${to}::date
         order by c.business_date, c.created_at desc, c.id desc`),
      rows<{ n: number }>(executor, sql`
        select coalesce(sum(s.cover_count), 0)::int as n from order_sessions s
         where s.id in ${sessions}
           and exists (select 1 from order_events e where e.session_id = s.id and e.event_type = 'ITEM_ADDED')`),
      // The comps on bills, as `loadSales` counts them, so the reasons add up to the tile.
      rows<{ reason: string; approver: string; paisa: number; count: number }>(executor, sql`
        select c.reason, a.name as approver, sum(bc.amount_paisa)::bigint as paisa, count(*)::int as count
          from bill_comps bc
          join bills b on b.id = bc.bill_id
          join comp_records c on c.id = bc.comp_record_id
          join staff a on a.id = c.authorized_by_staff_id
         where b.session_id in ${sessions} and b.cancelled_at is null
         group by 1, 2 order by 3 desc limit 100`),
      rows<{ name: string; quantity: number; paisa: number }>(executor, sql`
        select l.name, sum(l.quantity)::int as quantity, sum(l.amount_paisa)::bigint as paisa
          from bill_lines l join bills b on b.id = l.bill_id
         where b.session_id in ${sessions} and b.cancelled_at is null
         group by 1 order by 3 desc, 1 limit 200`),
      // Still open: with a bill printed and not settled, or simply open.
      rows<{ daily_number: number; kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null; opened_at: Date; printed_at: Date | null }>(executor, sql`
        select s.daily_number, s.kind, s.tab_label, s.opened_at,
               (select array_agg(t.label order by t.label) from order_session_tables ot join tables t on t.id = ot.table_id
                 where ot.session_id = s.id and ot.released_at is null) as tables,
               (select t.label from tables t where t.id = s.table_id) as primary_label,
               (select max(j.created_at) from print_jobs j
                 where j.session_id = s.id and j.ticket->>'kind' = 'receipt' and j.ticket->>'title' = 'BILL'
                   -- A cancelled bill's paper (Story 7.5) is not "the bill is out".
                   and not exists (select 1 from bills cb where cb.id = j.bill_id and cb.cancelled_at is not null)) as printed_at
          from order_sessions s
         where s.id in ${sessions} and s.closed_at is null
         order by s.opened_at`),
      rows<{ daily_number: number; kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null; reason: string; closed_at: Date; owed: number; voided: number; by: string }>(executor, sql`
        select s.daily_number, s.kind, s.tab_label, e.notes as reason, e.created_at as closed_at, st.name as by,
               (select array_agg(t.label order by t.label) from order_session_tables ot join tables t on t.id = ot.table_id
                 where ot.session_id = s.id) as tables,
               (select t.label from tables t where t.id = s.table_id) as primary_label,
               ((select coalesce(sum(b.total_paisa), 0) from bills b where b.session_id = s.id and b.cancelled_at is null)
                - (select coalesce(sum(p.amount_paisa), 0) from payment_records p where p.session_id = s.id))::bigint as owed,
               -- A cancelled order (Teran, 2026-11-16): what was voided by it.
               (select coalesce(sum(v.quantity * v.unit_price_paisa), 0) from order_events v
                 where v.session_id = s.id and v.event_type = 'ITEM_VOIDED')::bigint as voided
          from order_sessions s
          join order_events e on e.session_id = s.id and e.event_type = 'SESSION_CLOSED'
               and (e.notes in ('walkout', 'abandoned') or e.notes like 'cancelled%')
          join staff st on st.id = e.staff_id
         where s.id in ${sessions}
           and exists (select 1 from order_events i where i.session_id = s.id and i.event_type = 'ITEM_ADDED')`),
      // Corrections: removed, voided or comped lines (voids written from Story 7.5).
      rows<{ daily_number: number; kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null; event_type: string; item: string | null; notes: string | null; at: Date; by: string; approver: string | null; quantity: number }>(executor, sql`
        select s.daily_number, s.kind, s.tab_label, e.event_type, coalesce(e.custom_name, m.name) as item, e.notes,
               e.created_at as at, st.name as by, ap.name as approver, e.quantity,
               (select array_agg(t.label order by t.label) from order_session_tables ot join tables t on t.id = ot.table_id
                 where ot.session_id = s.id) as tables,
               (select t.label from tables t where t.id = s.table_id) as primary_label
          from order_events e
          join order_sessions s on s.id = e.session_id
          left join menu_items m on m.id = e.menu_item_id
          join staff st on st.id = e.staff_id
          left join staff ap on ap.id = e.approved_by_staff_id
         where e.session_id in ${sessions} and e.event_type in ('ITEM_REMOVED', 'ITEM_VOIDED', 'ITEM_COMPED')
         order by e.created_at desc limit 200`),
      // Bills cancelled to be corrected (Story 7.5).
      rows<{ daily_number: number; kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null; total: number; reason: string; at: Date; by: string; approver: string }>(executor, sql`
        select s.daily_number, s.kind, s.tab_label, b.total_paisa as total, b.cancel_reason as reason,
               b.cancelled_at as at, st.name as by, ap.name as approver,
               (select array_agg(t.label order by t.label) from order_session_tables ot join tables t on t.id = ot.table_id
                 where ot.session_id = s.id) as tables,
               (select t.label from tables t where t.id = s.table_id) as primary_label
          from bills b
          join order_sessions s on s.id = b.session_id
          join staff st on st.id = b.cancelled_by_staff_id
          join staff ap on ap.id = b.cancel_approved_by_staff_id
         where b.session_id in ${sessions} and b.cancelled_at is not null
         order by b.cancelled_at desc limit 200`),
    ])

  // ── Revenue and its buckets ────────────────────────────────────────────────
  const recordedPaisa = sales.billedPaisa
  const comparePaisa = n(compare[0]?.n)
  const byKey = new Map(buckets.map((b) => [b.key, n(b.n)]))
  let items: Insights['buckets']['items']
  if (dayPeriod) {
    const used = [...byKey.keys()].map(Number)
    const first = used.length ? Math.min(...used) : 0
    const last = used.length ? Math.max(...used) : 23
    // At least 12 hours, so a quiet day still reads as a day and the bars stay thin.
    let lo = Math.max(0, first - 1)
    const hi = Math.min(23, Math.max(last + 1, lo + 11))
    lo = Math.max(0, Math.min(lo, hi - 11))
    items = []
    for (let slot = lo; slot <= hi; slot += 1) {
      items.push({ key: String(slot), label: String((startHour + slot) % 24).padStart(2, '0'), paisa: byKey.get(String(slot)) ?? 0 })
    }
  } else {
    items = []
    for (let day = from; day <= to; day = shiftDate(day, 1)) {
      items.push({ key: day, label: period === 'week' ? weekday(day) : String(Number(day.slice(8))), paisa: byKey.get(day) ?? 0 })
    }
  }
  const peak = items.reduce<{ key: string; paisa: number } | null>((best, item) => (item.paisa > (best?.paisa ?? 0) ? item : best), null)

  // ── Cash ───────────────────────────────────────────────────────────────────
  const moved = (day: string, kind: string) =>
    expected.filter((row) => row.day === day && row.kind === kind).reduce((total, row) => total + n(row.n), 0)
  const countByDay = new Map(counts.map((c) => [c.day, c]))
  const cashDays: CashDay[] = []
  let days = 0
  for (let day = from; day <= to; day = shiftDate(day, 1)) {
    days += 1
    const inPaisa = moved(day, 'in')
    const cashSalesPaisa = moved(day, 'sales')
    const outPaisa = moved(day, 'out')
    const otherPaisa = moved(day, 'other')
    const expectedDay = cashSalesPaisa + inPaisa + outPaisa + otherPaisa
    const count = countByDay.get(day)
    cashDays.push({
      day,
      inPaisa,
      cashSalesPaisa,
      outPaisa,
      otherPaisa,
      expectedPaisa: expectedDay,
      counted: count ? { paisa: n(count.counted), at: new Date(count.at).toISOString(), by: count.by } : null,
      gapPaisa: count ? n(count.counted) - expectedDay : null,
    })
  }
  const expectedByDay = new Map(cashDays.map((entry) => [entry.day, entry.expectedPaisa]))
  const expectedPaisa = cashDays.reduce((total, entry) => total + entry.expectedPaisa, 0)
  const gap = counts.length
    ? counts.reduce((total, c) => total + n(c.counted) - (expectedByDay.get(c.day) ?? 0), 0)
    : null
  const single = dayPeriod && counts[0]
    ? { countedPaisa: n(counts[0].counted), countedAt: new Date(counts[0].at).toISOString(), countedBy: counts[0].by }
    : null

  // ── Audit list ─────────────────────────────────────────────────────────────
  const name = (row: { daily_number: number; kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null }) =>
    `#${String(row.daily_number).padStart(3, '0')} · ${openOrderPlace(row).join(' + ')}`
  const clock24 = (at: Date) => new Date(at).toISOString()
  // "Nimal, approved by Teran"; just "Teran" when the owner approved their own.
  const byLine = (by: string, approver: string | null) => (approver && approver !== by ? `${by}, approved by ${approver}` : by)
  const audit: Insights['audit'] = [
    ...unclosed.map((row) => ({
      kind: 'unclosed' as const,
      title: name(row),
      detail: row.printed_at ? 'Bill printed, not settled' : 'Still open',
      at: clock24(row.printed_at ?? row.opened_at),
    })),
    ...closedUnpaid.filter((row) => row.reason.startsWith('cancelled')).map((row) => ({
      kind: 'order_cancelled' as const,
      title: name(row),
      detail: `Order cancelled (${row.reason.replace(/^cancelled — /, '')}) · ${row.by}`,
      at: clock24(row.closed_at),
      amountPaisa: n(row.voided),
    })),
    ...closedUnpaid.filter((row) => !row.reason.startsWith('cancelled')).map((row) => ({
      kind: (row.reason === 'walkout' ? 'walkout' : 'abandoned') as 'walkout' | 'abandoned',
      title: name(row),
      detail: `${row.reason === 'walkout' ? 'Walkout' : 'Closed unpaid'} · ${row.by}`,
      at: clock24(row.closed_at),
      amountPaisa: n(row.owed),
    })),
    ...corrections.map((row) => ({
      kind: 'correction' as const,
      title: name(row),
      detail: `${row.event_type === 'ITEM_COMPED' ? 'Comped' : row.event_type === 'ITEM_VOIDED' ? 'Voided' : 'Removed'}: ${n(row.quantity)} × ${row.item ?? 'item'}${row.notes ? ` (${row.notes})` : ''} · ${byLine(row.by, row.approver)}`,
      at: clock24(row.at),
    })),
    ...cancelledBills.map((row) => ({
      kind: 'cancelled' as const,
      title: name(row),
      detail: `Bill cancelled (${row.reason}) · ${byLine(row.by, row.approver)}`,
      at: clock24(row.at),
      amountPaisa: n(row.total),
    })),
  ].sort((x, y) => y.at.localeCompare(x.at))

  const compsTotal = sales.compsPaisa
  const coverCount = n(covers[0]?.n)
  const pay = sales.paid
  return {
    period,
    from,
    to,
    today: clock.today,
    restaurantName: clock.name ?? clock.tenant_name,
    compareLabel,
    recorded: {
      paisa: recordedPaisa,
      comparePaisa,
      changePercent: comparePaisa > 0 ? Math.round(((recordedPaisa - comparePaisa) / comparePaisa) * 100) : null,
    },
    buckets: { kind: dayPeriod ? 'hour' : 'day', items, peakKey: peak?.key ?? null },
    cash: { expectedPaisa, daysCounted: counts.length, days, gapPaisa: gap, count: single, byDay: cashDays },
    // Whole rupees: an average to the cent is false precision.
    covers: { count: coverCount, averagePaisa: coverCount > 0 ? Math.round(recordedPaisa / coverCount / 100) * 100 : null },
    comps: {
      totalPaisa: compsTotal,
      percentOfRevenue: recordedPaisa > 0 && compsTotal > 0 ? Math.round((compsTotal / recordedPaisa) * 1000) / 10 : null,
      lines: sales.compLines,
      byReason: compReasons.map((row) => ({ reason: row.reason, approver: row.approver, paisa: n(row.paisa), count: n(row.count) })),
    },
    payments: {
      cashPaisa: pay.cashPaisa,
      cardPaisa: pay.cardPaisa,
      transferPaisa: pay.transferPaisa,
      settledPaisa: pay.totalPaisa,
    },
    sales,
    noSales: noSales?.map(({ openedAt, staffName, reason, note, amountPaisa }) => ({ openedAt, staffName, reason, note, amountPaisa })) ?? null,
    topItems: topItems.map((row) => ({ name: row.name, quantity: n(row.quantity), paisa: n(row.paisa) })),
    audit,
  }
}
