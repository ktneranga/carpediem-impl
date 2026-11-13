import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/server/db'

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
