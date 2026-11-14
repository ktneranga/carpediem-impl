import 'server-only'
import { isNull, sql } from 'drizzle-orm'
import { bills } from '@/server/db/schema'

/**
 * How many units of an `ITEM_ADDED` line are billed, voided, and left (Story 7.5).
 *
 * ── One definition each, on purpose ──────────────────────────────────────────
 * "Already billed" was copied inline in three places (bill.service twice,
 * payment.service once). Voids and cancelled bills change all three at once, so
 * they live here and every caller uses these. The database triggers
 * `bill_lines_within_event_quantity` and `order_event_void_within_quantity`
 * (migration 0043) state the same rules and are the guarantee; these are what
 * the queries ask.
 *
 * Each expression is correlated on `order_events.id` of the OUTER query, so use
 * them where `order_events` (unaliased) is the row being read.
 *
 * ── Written as "order_events"."id", not as the Drizzle column ────────────────
 * Drizzle drops the table name from a column in the SELECT list of a
 * single-table query. Inside these subqueries a bare "id" binds to the INNER
 * table (`order_events v`, `bills b`), so the correlation silently became
 * "v.voids_event_id = v.id", always false. Spelled out, it cannot.
 */
const outerId = sql.raw('"order_events"."id"')
const outerQuantity = sql.raw('"order_events"."quantity"')

/** A bill that still counts: not cancelled. Use in every Drizzle query on `bills`. */
export const liveBill = isNull(bills.cancelledAt)

/** Units of this line on a live bill. */
export const billedUnits = sql<number>`coalesce((
  select sum(bl.quantity) from bill_lines bl join bills b on b.id = bl.bill_id
   where bl.order_event_id = ${outerId} and b.cancelled_at is null), 0)::int`

/** Units of this line voided. */
export const voidedUnits = sql<number>`coalesce((
  select sum(v.quantity) from order_events v
   where v.voids_event_id = ${outerId} and v.event_type = 'ITEM_VOIDED'), 0)::int`

/** Units still ordered: quantity − voided. Bill or not. */
export const liveUnits = sql<number>`(${outerQuantity} - ${voidedUnits})`

/** True while some units are neither billed nor voided. */
export const hasUnbilledUnits = sql<boolean>`${outerQuantity} > ${billedUnits} + ${voidedUnits}`
