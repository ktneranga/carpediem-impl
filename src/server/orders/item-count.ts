import 'server-only'
import { sql } from 'drizzle-orm'
import { orderEvents } from '@/server/db/schema'

/**
 * How many DISHES an order holds: the sum of `ITEM_ADDED` quantities.
 *
 * Every "items" figure in the app — the floor card, the counter list, the
 * walkout confirmation's wording, the close routes' abandoned/walkout decision
 * — used `count()`, which counts ROWS. That was the same thing until Story 4.4
 * began merging the same dish on the same seat into one line with a quantity,
 * after which "Cashew × 3" showed as 1 item everywhere it was DISPLAYED
 * (Story 4.5 Trap 4).
 *
 * The abandoned-vs-walkout decision itself was never wrong: it only tests the
 * count against zero, and rows and quantities always agreed on that.
 *
 * One expression, shared, so the sites cannot drift apart again. Callers must
 * still filter to `event_type = 'ITEM_ADDED'` — this sums what it is given.
 * `sum()` of an int column is a bigint, which the driver returns as a string;
 * `mapWith(Number)` turns it back into a number.
 */
export const dishCount = sql<number>`coalesce(sum(${orderEvents.quantity}), 0)`.mapWith(Number)

/**
 * What an order has RUN UP so far, in integer paisa.
 *
 * Priced from the event rows — `quantity × unit_price_paisa` — never from the
 * menu. The event carries the price as quoted when the dish was sent, which is
 * the whole reason `unit_price_paisa` is written into an append-only table: a
 * mid-service re-price must not change what a seated guest is charged.
 *
 * NOT a bill. There is no service charge, no tax, no comp and no discount here
 * — Epic 6 owns all four, and this figure is the floor card's running total, so
 * a waiter can see what a table is standing at before anyone asks. Same caller
 * contract as `dishCount`: filter to `event_type = 'ITEM_ADDED'` yourself.
 */
export const dishTotalPaisa = sql<number>`
  coalesce(sum(${orderEvents.quantity} * ${orderEvents.unitPricePaisa}), 0)
`.mapWith(Number)
