import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { dailyOrderLabel } from '@/lib/order-number'

/**
 * Manage → Orders (Story 7.7, Teran 2026-11-17): every order of a span of
 * business days, one row each — where, who looked after it, when, how much,
 * and how it ended. Tapping a row opens the order's story (Story 7.6).
 * Read-only.
 *
 * ── The total ───────────────────────────────────────────────────────────────
 * What its bills came to, plus any dishes no bill covers at their quoted price
 * (before service and tax, like the floor card): an open order's running
 * total, or what a walkout left owing. The bill screen has the exact figure.
 */

export const ORDER_STATUSES = ['open', 'paid', 'cancelled', 'walkout', 'empty'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export type OrderRow = {
  sessionId: string
  /** "#042". */
  orderLabel: string
  /** `YYYY-MM-DD` business day. */
  businessDate: string
  /** "Table 3 + Table 4", "S1", "Bar tab". */
  place: string
  waiter: string | null
  openedAt: string
  closedAt: string | null
  items: number
  totalPaisa: number
  paidPaisa: number
  /** Written off by short payments (Teran, 2026-11-21); 0 when none. Shown red. */
  shortPaisa: number
  /** "cash", "card", "cash + card". Null when nothing was paid. */
  paidBy: string | null
  status: OrderStatus
  /** The reason a cancelled order gave. */
  note: string | null
}

export async function listOrders({
  tenantId,
  from,
  to,
  status,
  search,
}: {
  tenantId: string
  from: string
  to: string
  status?: OrderStatus | null
  search?: string | null
}): Promise<{ orders: OrderRow[]; totals: { orders: number; paidPaisa: number; openPaisa: number } }> {
  const result = await db.execute(sql`
    with live as (
      select e.session_id,
             sum(e.quantity - coalesce((select sum(v.quantity) from order_events v
                                         where v.voids_event_id = e.id and v.event_type = 'ITEM_VOIDED'), 0)) as units,
             sum((e.quantity - coalesce((select sum(v.quantity) from order_events v
                                          where v.voids_event_id = e.id and v.event_type = 'ITEM_VOIDED'), 0)
                  - coalesce((select sum(l.quantity) from bill_lines l join bills b on b.id = l.bill_id
                               where l.order_event_id = e.id and b.cancelled_at is null), 0))
                 * coalesce(e.unit_price_paisa, 0)) as unbilled_paisa
        from order_events e
        join order_sessions s on s.id = e.session_id
       where s.tenant_id = ${tenantId} and s.business_date between ${from}::date and ${to}::date
         and e.event_type = 'ITEM_ADDED'
       group by e.session_id
    )
    select s.id, s.daily_number, s.business_date::text as business_date, s.kind, s.tab_label,
           s.opened_at, s.closed_at,
           w.name as waiter,
           coalesce(
             (select string_agg(t.label, ' + ' order by t.label) from order_session_tables ot join tables t on t.id = ot.table_id
               -- Open: the tables it has now. Closed: the ones it had at closing
               -- (released by the close itself), not tables it moved away from.
               where ot.session_id = s.id
                 and (ot.released_at is null or (s.closed_at is not null and ot.released_at >= s.closed_at - interval '1 second'))),
             (select t.label from tables t where t.id = s.table_id)
           ) as tables,
           coalesce(live.units, 0)::int as items,
           coalesce(live.unbilled_paisa, 0)::bigint as unbilled_paisa,
           (select coalesce(sum(b.total_paisa), 0) from bills b where b.session_id = s.id and b.cancelled_at is null)::bigint as billed_paisa,
           (select coalesce(sum(p.amount_paisa), 0) from payment_records p where p.session_id = s.id)::bigint as paid_paisa,
           (select coalesce(sum(b.short_paisa), 0) from bills b where b.session_id = s.id and b.cancelled_at is null)::bigint as short_paisa,
           (select string_agg(distinct p.method::text, ' + ') from payment_records p where p.session_id = s.id) as paid_by,
           (select e.notes from order_events e where e.session_id = s.id and e.event_type = 'SESSION_CLOSED'
             order by e.created_at desc limit 1) as close_notes
      from order_sessions s
      left join live on live.session_id = s.id
      left join staff w on w.id = coalesce(s.served_by_staff_id, s.opened_by_staff_id)
     where s.tenant_id = ${tenantId} and s.business_date between ${from}::date and ${to}::date
     order by s.business_date desc, s.daily_number desc`)

  let orders: OrderRow[] = (result.rows as Record<string, unknown>[]).map((row) => {
    const notes = row.close_notes === null ? null : String(row.close_notes)
    const status: OrderStatus =
      row.closed_at === null
        ? 'open'
        : notes === 'walkout'
          ? 'walkout'
          : notes?.startsWith('cancelled')
            ? 'cancelled'
            : notes === 'abandoned'
              ? 'empty'
              : 'paid'
    const billed = Number(row.billed_paisa)
    const unbilled = Number(row.unbilled_paisa)
    const place =
      row.tables !== null && row.tables !== undefined
        ? String(row.tables)
        : row.kind === 'counter'
          ? 'Bar tab'
          : 'Counter'
    return {
      sessionId: String(row.id),
      orderLabel: dailyOrderLabel(Number(row.daily_number)),
      businessDate: String(row.business_date),
      place,
      waiter: row.waiter === null ? null : String(row.waiter),
      openedAt: new Date(row.opened_at as string).toISOString(),
      closedAt: row.closed_at === null ? null : new Date(row.closed_at as string).toISOString(),
      items: Number(row.items),
      // Billed, plus dishes no bill covers (an open order, or a walkout that left
      // before its bill): never 0 for food that went out.
      totalPaisa: billed + unbilled,
      paidPaisa: Number(row.paid_paisa),
      shortPaisa: Number(row.short_paisa),
      paidBy: row.paid_by === null ? null : String(row.paid_by),
      status,
      note: status === 'cancelled' && notes ? notes.replace(/^cancelled — /, '') : null,
    }
  })

  if (status) orders = orders.filter((order) => order.status === status)
  const q = search?.trim().toLowerCase().replace(/^#/, '')
  if (q) {
    orders = orders.filter(
      (order) =>
        Number(order.orderLabel.slice(1)) === Number(q) ||
        order.place.toLowerCase().includes(q) ||
        (order.waiter ?? '').toLowerCase().includes(q),
    )
  }
  return {
    orders,
    totals: {
      orders: orders.length,
      paidPaisa: orders.reduce((sum, order) => sum + order.paidPaisa, 0),
      openPaisa: orders.filter((order) => order.status === 'open').reduce((sum, order) => sum + Math.max(order.totalPaisa - order.paidPaisa - order.shortPaisa, 0), 0),
    },
  }
}
