import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { openOrderPlace } from '@/server/services/takings.service'

/**
 * The owner dashboard's figures (Stories 9.2, 9.3). Today is the business
 * date (`business_date_at(tenant, now())`); an order's money counts on its
 * `order_sessions.business_date`, as on the End of day screen (9.5).
 */

type Executor = typeof db

async function rows<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as T[]
}

export type RevenueDay = { businessDate: string; hours: number[]; totalPaisa: number }
export type Revenue = {
  /** The turnover hour: `hours[i]` is the hour `(startHour + i) % 24`. */
  startHour: number
  /** The slot the restaurant's clock is in now. */
  nowSlot: number
  today: RevenueDay
  yesterday: RevenueDay
}

/**
 * Money received, by hour of payment in the restaurant's time zone, for the
 * orders of today's and yesterday's business dates. Slots start at the
 * turnover hour, so 1 AM sits after 11 PM. One grouped query.
 */
export async function revenueByHour(executor: Executor, tenantId: string): Promise<Revenue> {
  const [clock] = await rows<{ today: string; yesterday: string; start_hour: number; now_slot: number }>(executor, sql`
    select business_date_at(t.id, now())::text as today,
           (business_date_at(t.id, now()) - 1)::text as yesterday,
           t.business_day_start_hour as start_hour,
           ((extract(hour from now() at time zone t.timezone)::int - t.business_day_start_hour + 24) % 24) as now_slot
      from tenants t where t.id = ${tenantId}`)
  if (!clock) throw new Error('No such tenant')

  const buckets = await rows<{ day: string; slot: number; paisa: number }>(executor, sql`
    select s.business_date::text as day,
           ((extract(hour from p.created_at at time zone t.timezone)::int - t.business_day_start_hour + 24) % 24) as slot,
           sum(p.amount_paisa)::int as paisa
      from payment_records p
      join order_sessions s on s.id = p.session_id
      join tenants t on t.id = s.tenant_id
     where s.tenant_id = ${tenantId}
       and s.business_date in (${clock.today}::date, ${clock.yesterday}::date)
     group by 1, 2`)

  const day = (businessDate: string): RevenueDay => {
    const hours = Array.from({ length: 24 }, () => 0)
    for (const bucket of buckets) if (bucket.day === businessDate) hours[bucket.slot] = Number(bucket.paisa)
    return { businessDate, hours, totalPaisa: hours.reduce((a, b) => a + b, 0) }
  }
  return {
    startHour: Number(clock.start_hour),
    nowSlot: Number(clock.now_slot),
    today: day(clock.today),
    yesterday: day(clock.yesterday),
  }
}

// ── The cards (Story 9.3) ────────────────────────────────────────────────────

export type CashCount = { countedPaisa: number; countedAt: string; countedBy: string }

/** The latest count of a business date, or null. A recount adds a row; the newest wins. */
export async function latestCashCount(
  executor: Executor,
  { tenantId, businessDate }: { tenantId: string; businessDate: string },
): Promise<CashCount | null> {
  const [row] = await rows<{ counted_paisa: number; created_at: Date; name: string }>(executor, sql`
    select c.counted_paisa, c.created_at, s.name
      from cash_counts c join staff s on s.id = c.staff_id
     where c.tenant_id = ${tenantId} and c.business_date = ${businessDate}::date
     order by c.created_at desc, c.id desc limit 1`)
  return row
    ? { countedPaisa: Number(row.counted_paisa), countedAt: new Date(row.created_at).toISOString(), countedBy: row.name }
    : null
}

export type DashboardSummary = {
  businessDate: string
  cash: { expectedPaisa: number; count: CashCount | null; gapPaisa: number | null }
  comps: { totalPaisa: number; entries: { itemName: string; amountPaisa: number; reason: string; staffName: string; at: string }[] }
  soldOut: { id: string; name: string; kind: 'depleted' | 'manual' }[]
  longOpen: { dailyNumber: number; tables: string[]; zone: string | null; openedAt: string; minutesOpen: number; openedBy: string }[]
  longOpenMinutes: number
}

/** Everything the four cards need, in one response. Reads in parallel on the pool. */
export async function loadSummary(executor: Executor, tenantId: string): Promise<DashboardSummary> {
  const [{ today, threshold }] = await rows<{ today: string; threshold: number }>(executor, sql`
    select business_date_at(${tenantId}, now())::text as today,
           coalesce((select long_open_minutes from tenant_config where tenant_id = ${tenantId}), 120) as threshold`)
  const day = sql`(select id from order_sessions where tenant_id = ${tenantId} and business_date = ${today}::date)`

  const [expected, count, comps, soldOut, longOpen] = await Promise.all([
    rows<{ n: number }>(executor, sql`
      select coalesce(sum(amount_paisa), 0)::int as n from payment_records
       where method = 'cash' and session_id in ${day}`),
    latestCashCount(executor, { tenantId, businessDate: today }),
    rows<{ item: string | null; amount: number; reason: string; staff: string; at: Date }>(executor, sql`
      select coalesce(e.custom_name, m.name) as item, c.amount_paisa as amount, c.reason, s.name as staff, c.created_at as at
        from comp_records c
        join order_events e on e.id = c.order_event_id
        left join menu_items m on m.id = e.menu_item_id
        join staff s on s.id = c.staff_id
       where c.session_id in ${day}
       order by c.created_at desc`),
    rows<{ id: string; name: string; portion_count: number | null }>(executor, sql`
      select id, name, portion_count from menu_items
       where tenant_id = ${tenantId} and is_active and not is_available
       order by lower(name)`),
    rows<{ daily_number: number; kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null; zone: string | null; opened_at: Date; minutes: number; opened_by: string }>(executor, sql`
      select s.daily_number, s.kind, s.tab_label, s.opened_at, st.name as opened_by,
             floor(extract(epoch from now() - s.opened_at) / 60)::int as minutes,
             (select array_agg(t.label order by t.label)
                from order_session_tables ot join tables t on t.id = ot.table_id
               where ot.session_id = s.id and ot.released_at is null) as tables,
             (select t.label from tables t where t.id = s.table_id) as primary_label,
             (select z.name from tables t join zones z on z.id = t.zone_id where t.id = s.table_id) as zone
        from order_sessions s join staff st on st.id = s.opened_by_staff_id
       where s.tenant_id = ${tenantId} and s.closed_at is null
         and s.opened_at < now() - make_interval(mins => ${threshold}::int)
       order by s.opened_at`),
  ])

  const expectedPaisa = Number(expected[0]?.n ?? 0)
  return {
    businessDate: today,
    cash: { expectedPaisa, count, gapPaisa: count ? count.countedPaisa - expectedPaisa : null },
    comps: {
      // Stored positive (the amount given away); shown as a reduction.
      totalPaisa: comps.reduce((total, row) => total + Number(row.amount), 0),
      entries: comps.map((row) => ({
        itemName: row.item ?? 'Item',
        amountPaisa: Number(row.amount),
        reason: row.reason,
        staffName: row.staff,
        at: new Date(row.at).toISOString(),
      })),
    },
    soldOut: soldOut.map((row) => ({ id: row.id, name: row.name, kind: row.portion_count === 0 ? 'depleted' : 'manual' })),
    longOpen: longOpen.map((row) => ({
      dailyNumber: row.daily_number,
      tables: openOrderPlace(row),
      zone: row.zone,
      openedAt: new Date(row.opened_at).toISOString(),
      minutesOpen: Number(row.minutes),
      openedBy: row.opened_by,
    })),
    longOpenMinutes: Number(threshold),
  }
}

/** Whole rupees, 0 to 10 million, as typed on the screen. */
export function checkCountedPaisa(countedPaisa: number): number {
  if (!Number.isInteger(countedPaisa) || countedPaisa < 0 || countedPaisa > 1_000_000_000 || countedPaisa % 100 !== 0) {
    throw new MenuRuleError('Enter the cash counted in whole rupees')
  }
  return countedPaisa
}

/** Records a count for TODAY's business date (append-only; a recount adds a row). */
export async function recordCashCount(
  executor: Executor,
  { tenantId, staffId, countedPaisa }: { tenantId: string; staffId: string; countedPaisa: number },
): Promise<CashCount> {
  const paisa = checkCountedPaisa(countedPaisa)
  const [row] = await rows<{ business_date: string }>(executor, sql`
    insert into cash_counts (tenant_id, business_date, counted_paisa, staff_id)
    values (${tenantId}, business_date_at(${tenantId}, now()), ${paisa}, ${staffId})
    returning business_date::text`)
  return (await latestCashCount(executor, { tenantId, businessDate: row!.business_date }))!
}
