import 'server-only'
import { sql } from 'drizzle-orm'
import { orderEvents } from '@/server/db/schema'

/**
 * How many DISHES an order holds: the sum of `ITEM_ADDED` quantities.
 *
 * Every "items" figure in the app — the floor card, the counter list, the
 * walkout confirmation, the close routes' abandoned/walkout decision — used
 * `count()`, which counts ROWS. That was the same thing until Story 4.4 began
 * merging the same dish on the same seat into one line with a quantity, after
 * which "Cashew × 3" showed as 1 item and a walkout was recorded against a
 * waiter with the wrong count (Story 4.5 Trap 4).
 *
 * One expression, shared, so the sites cannot drift apart again. Callers must
 * still filter to `event_type = 'ITEM_ADDED'` — this sums what it is given.
 * `sum()` of an int column is a bigint, which the driver returns as a string;
 * `mapWith(Number)` turns it back into a number.
 */
export const dishCount = sql<number>`coalesce(sum(${orderEvents.quantity}), 0)`.mapWith(Number)
