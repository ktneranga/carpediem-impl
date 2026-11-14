import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { printJobs, staff, tenantConfig, tenants } from '@/server/db/schema'
import { listNoSaleOpenings } from '@/server/services/cash-drawer.service'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import type { Takings, TakingsPayload } from '@/types/tickets'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Executor = Tx | typeof db

/**
 * End-of-day takings (Story 9.5): one business day's figures for Manage → End
 * of day and the printed slip.
 *
 * ── Which day ────────────────────────────────────────────────────────────────
 * An order belongs to `order_sessions.business_date` (the order-number trigger
 * sets it from `opened_at` and the turnover hour). Its bills and payments count
 * on that day even when paid after the turnover. No-sale openings use
 * `business_date_at()` on their own time — the same definition.
 *
 * ── Only what was recorded ───────────────────────────────────────────────────
 * Bills, bill lines, comps and payments as stored; nothing is re-priced. Each
 * figure group is its own query, so joining lines and payments to the same
 * bills can never multiply rows.
 */

const int = (value: unknown) => Number(value ?? 0)

async function rows<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as T[]
}

/** Today, as the restaurant counts days. */
export async function todayBusinessDate(executor: Executor, tenantId: string): Promise<string> {
  const [row] = await rows<{ today: string }>(executor, sql`select business_date_at(${tenantId}, now())::text as today`)
  return row!.today
}

/** A real `YYYY-MM-DD` that is not after today. */
export async function checkTakingsDate(executor: Executor, tenantId: string, date: string): Promise<string> {
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  if (!valid || date > (await todayBusinessDate(executor, tenantId))) {
    throw new MenuRuleError('Choose a date up to today')
  }
  return date
}

/** The orders of a span of business days, as a subquery every figure filters on. */
const spanOrders = (tenantId: string, from: string, to: string) => sql`(
  select id from order_sessions
   where tenant_id = ${tenantId} and business_date between ${from}::date and ${to}::date)`

/**
 * What was sold and paid over a span of business days — the ONE definition the
 * Dashboard and the end-of-day slip share, so their figures can never differ.
 * Comps are the comps on bills (`bill_comps`): items − comps = subtotal.
 * Cancelled bills (Story 7.5) count nowhere.
 */
export type Sales = {
  orders: number
  itemsPaisa: number
  compsPaisa: number
  compLines: number
  subtotalPaisa: number
  serviceChargePaisa: number
  taxPaisa: number
  billedPaisa: number
  paid: { cashPaisa: number; cardPaisa: number; transferPaisa: number; totalPaisa: number }
}

/** Takes the POOL (parallel queries). */
export async function loadSales(
  executor: typeof db,
  { tenantId, from, to }: { tenantId: string; from: string; to: string },
): Promise<Sales> {
  const span = spanOrders(tenantId, from, to)
  const [orders, billed, items, comps, paid] = await Promise.all([
    rows<{ n: number }>(executor, sql`
      select count(*)::int as n from order_sessions s
       where s.id in ${span}
         and exists (select 1 from order_events e where e.session_id = s.id and e.event_type = 'ITEM_ADDED')`),
    rows<{ subtotal: number; service: number; tax: number; total: number }>(executor, sql`
      select coalesce(sum(subtotal_paisa), 0)::bigint as subtotal,
             coalesce(sum(service_charge_paisa), 0)::bigint as service,
             coalesce(sum(tax_paisa), 0)::bigint as tax,
             coalesce(sum(total_paisa), 0)::bigint as total
        from bills where session_id in ${span} and cancelled_at is null`),
    rows<{ n: number }>(executor, sql`
      select coalesce(sum(l.amount_paisa), 0)::bigint as n
        from bill_lines l join bills b on b.id = l.bill_id
       where b.session_id in ${span} and b.cancelled_at is null`),
    rows<{ n: number; lines: number }>(executor, sql`
      select coalesce(sum(c.amount_paisa), 0)::bigint as n, count(*)::int as lines
        from bill_comps c join bills b on b.id = c.bill_id
       where b.session_id in ${span} and b.cancelled_at is null`),
    rows<{ cash: number; card: number; transfer: number }>(executor, sql`
      select coalesce(sum(amount_paisa) filter (where method = 'cash'), 0)::bigint as cash,
             coalesce(sum(amount_paisa) filter (where method = 'card'), 0)::bigint as card,
             coalesce(sum(amount_paisa) filter (where method = 'transfer'), 0)::bigint as transfer
        from payment_records where session_id in ${span}`),
  ])
  const b = billed[0]!
  const p = paid[0]!
  return {
    orders: int(orders[0]?.n),
    itemsPaisa: int(items[0]?.n),
    compsPaisa: int(comps[0]?.n),
    compLines: int(comps[0]?.lines),
    subtotalPaisa: int(b.subtotal),
    serviceChargePaisa: int(b.service),
    taxPaisa: int(b.tax),
    billedPaisa: int(b.total),
    paid: {
      cashPaisa: int(p.cash),
      cardPaisa: int(p.card),
      transferPaisa: int(p.transfer),
      totalPaisa: int(p.cash) + int(p.card) + int(p.transfer),
    },
  }
}

/**
 * The figures. Takes the POOL, not a transaction: its queries run in parallel,
 * each on its own connection, and one transaction's connection can't do that.
 */
export async function loadTakings(
  executor: typeof db,
  { tenantId, businessDate }: { tenantId: string; businessDate: string },
): Promise<Takings> {
  const day = spanOrders(tenantId, businessDate, businessDate)

  const [sales, closedUnpaid, open, noSales, counted] = await Promise.all([
    loadSales(executor, { tenantId, from: businessDate, to: businessDate }),
    // Closed as walkout / abandoned: what their bills still owed.
    rows<{ n: number; owed: number }>(executor, sql`
      select count(*)::int as n,
             coalesce(sum(
               (select coalesce(sum(b.total_paisa), 0) from bills b where b.session_id = s.id and b.cancelled_at is null)
             - (select coalesce(sum(p.amount_paisa), 0) from payment_records p where p.session_id = s.id)
             ), 0)::int as owed
        from order_sessions s
       where s.id in ${day} and s.closed_at is not null
         and exists (select 1 from order_events e where e.session_id = s.id and e.event_type = 'ITEM_ADDED')
         and exists (select 1 from order_events e
                      where e.session_id = s.id and e.event_type = 'SESSION_CLOSED'
                        and e.notes in ('walkout', 'abandoned'))`),
    rows<{ daily_number: number; kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null; opened_at: Date; opened_by: string }>(executor, sql`
      select s.daily_number, s.kind, s.tab_label, s.opened_at, st.name as opened_by,
             (select array_agg(t.label order by t.label)
                from order_session_tables ot join tables t on t.id = ot.table_id
               where ot.session_id = s.id and ot.released_at is null) as tables,
             (select t.label from tables t where t.id = s.table_id) as primary_label
        from order_sessions s join staff st on st.id = s.opened_by_staff_id
       where s.id in ${day} and s.closed_at is null
       order by s.daily_number`),
    listNoSaleOpenings(executor, { tenantId, businessDate }),
    // The owner's latest drawer count (Story 9.3); a recount adds a row.
    rows<{ n: number }>(executor, sql`
      select counted_paisa as n from cash_counts
       where tenant_id = ${tenantId} and business_date = ${businessDate}::date
       order by created_at desc, id desc limit 1`),
  ])

  const { compLines, ...money } = sales
  void compLines // the slip shows the amount, not the count
  return {
    businessDate,
    ...money,
    closedUnpaid: { count: int(closedUnpaid[0]?.n), owedPaisa: int(closedUnpaid[0]?.owed) },
    cashCount: counted[0] ? { countedPaisa: int(counted[0].n), gapPaisa: int(counted[0].n) - sales.paid.cashPaisa } : null,
    openOrders: open.map((row) => ({
      dailyNumber: row.daily_number,
      tables: openOrderPlace(row),
      openedAt: new Date(row.opened_at).toISOString(),
      openedBy: row.opened_by,
    })),
    noSales: noSales.map(({ openedAt, staffName, reason, note }) => ({ openedAt, staffName, reason, note })),
  }
}

/**
 * Where an open order is, as the floor names it. A bar tab shows its nickname
 * here — this is the owner's screen and slip, never a guest's paper.
 */
export function openOrderPlace(row: { kind: string; tab_label: string | null; tables: string[] | null; primary_label: string | null }) {
  const tables = [...(row.tables ?? [])].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
  if (tables.length > 0) return tables
  if (row.kind === 'counter') return [row.tab_label ? `Bar tab (${row.tab_label})` : 'Bar tab']
  return [row.primary_label ?? 'Counter']
}

/** Queues the day's slip on the receipt printer. The caller wakes the queue after commit. */
export async function printTakings(
  tx: Tx,
  { tenantId, staffId, businessDate }: { tenantId: string; staffId: string; businessDate: string },
): Promise<{ jobId: string }> {
  const date = await checkTakingsDate(tx, tenantId, businessDate)
  // Read-only figures through the pool; only the job insert is in the transaction.
  const takings = await loadTakings(db, { tenantId, businessDate: date })
  const [heading] = await tx
    .select({
      tenantName: tenants.name,
      timeZone: tenants.timezone,
      restaurantName: tenantConfig.restaurantName,
      now: sql<string>`clock_timestamp()`,
    })
    .from(tenants)
    .leftJoin(tenantConfig, eq(tenantConfig.tenantId, tenants.id))
    .where(eq(tenants.id, tenantId))
    .limit(1)
  const [printer] = await tx.select({ name: staff.name }).from(staff).where(eq(staff.id, staffId)).limit(1)

  const payload: TakingsPayload = {
    kind: 'takings',
    destination: 'cashier',
    tableLabels: ['End of day'],
    restaurantName: heading?.restaurantName ?? heading?.tenantName ?? '',
    printedAt: new Date(heading?.now ?? Date.now()).toISOString(),
    timeZone: heading?.timeZone,
    printedBy: printer?.name ?? null,
    takings,
  }
  const [job] = await tx
    .insert(printJobs)
    .values({ tenantId, sessionId: null, roundId: null, destination: 'cashier', billId: null, ticket: payload })
    .returning({ id: printJobs.id })
  return { jobId: job!.id }
}
