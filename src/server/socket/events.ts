import 'server-only'
import type { OrderConfirmedPayload, OrderSubmittedPayload } from '@/types/orders'
import type { TableStatusChangedPayload } from '@/types/tables'
import type { PrinterAlertPayload } from '@/types/tickets'
import { OWNER_ROOM, productionRoom, sessionRoom } from './rooms'
import { getIO } from './index'

/**
 * Typed broadcast helpers.
 *
 * Event names follow architecture.md:372-386 — `domain:action`, snake_case after
 * the colon, past tense for broadcasts. epics.md wrote `table:statusChanged` in
 * seven places; that was corrected on 2026-08-21. A camelCase listener never
 * fires, and nothing errors — real-time simply stops working silently.
 *
 * The PAYLOAD shapes live under `src/types/`, which a component may import.
 * This module carries `server-only`, so the grid had been keeping its own
 * copy of `TableStatusChangedPayload` — one contract declared twice, which
 * drifts the moment either side gains a field.
 */

export type { TableStatusChangedPayload }


/**
 * Broadcasts a table occupancy change to every connected device.
 *
 * MUST be called from inside a request function, never at module top level —
 * `getIO()` throws if `server.ts` has not started yet, and a module-level call
 * runs at import time. (Deferred item from Story 1.1's review.)
 *
 * Broadcast rather than room-scoped: every device shows the table grid, so every
 * device wants this. Room-scoped emits (`table:{id}`, `kitchen`, `bar`) matter
 * from Epic 4 onward where payloads are order-specific.
 */
export function emitTableStatusChanged(payload: TableStatusChangedPayload): void {
  try {
    getIO().emit('table:status_changed', payload)
  } catch (error) {
    // A missing Socket.io server must not fail the database write that already
    // succeeded.
    //
    // Note there is no automatic recovery for the clients that missed this
    // event: staleTime MARKS data stale, it never schedules a fetch. The grid
    // resyncs on socket reconnect (see the 'connect' handler in table-grid.tsx),
    // which covers a dropped connection — but an emit swallowed here while the
    // socket stayed up is simply lost. Prefer failing loudly in development.
    console.error('[socket] Failed to emit table:status_changed:', error)
  }
}

/**
 * Broadcasts that the set of open counter sales changed.
 *
 * Payload-free by design. `table:status_changed` carries a row patch because the
 * grid patches rows; the counter list is a QUERY, so the only thing a device
 * needs to know is "refetch". Reconstructing a sequence-numbered list from
 * incremental patches would mean recomputing every other row's identity on the
 * client, which is work the server already does.
 *
 * Wrapped like `emitTableStatusChanged`, and for the same reason: this is called
 * after a committed transaction, so a throwing `getIO()` — server not yet
 * initialised, a hot reload — would turn a successful write into a 500 on work
 * that already happened.
 */
export function emitCounterSalesChanged(): void {
  try {
    getIO().emit('counter:changed')
  } catch (error) {
    console.error('[socket] Failed to emit counter:changed:', error)
  }
}

/**
 * One menu item's availability changed — 86'd, restocked, or manually toggled.
 *
 * ── The name ─────────────────────────────────────────────────────────────────
 * `menu:item_updated`, NOT `menu:itemUpdated`. `architecture.md:399` sets the
 * rule — `domain:action`, snake_case after the colon — and every event here
 * follows it. epics.md wrote the camelCase spelling in six places; that was
 * corrected on 2026-09-11, exactly as `table:statusChanged` was corrected on
 * 2026-08-21.
 *
 * The stakes are higher than a convention breach here. Story 4.2 writes the
 * LISTENER; Epic 8 writes the EMITTER. Two spellings means no error, no log, and
 * an 86'd item that silently fails to grey out on every other tablet — found, if
 * ever, by a waiter selling something the kitchen ran out of an hour ago.
 *
 * Payload carries what the client patches. Story 3.8's review found a socket
 * payload missing the one field the client keyed on, so a merge only worked on
 * the device that made it; the rule since is that the payload carries every
 * field the receiver writes.
 */
export type MenuItemUpdatedPayload = {
  itemId: string
  available: boolean
  /** Null when the item is not portion-tracked. */
  portionCount: number | null
}

export function emitMenuItemUpdated(payload: MenuItemUpdatedPayload): void {
  try {
    getIO().emit('menu:item_updated', payload)
  } catch (error) {
    // Never let a socket failure fail the write that already committed.
    console.error('[socket] Failed to emit menu:item_updated:', error)
  }
}

// ── Rooms ────────────────────────────────────────────────────────────────────
//
// Everything ABOVE is a broadcast to every connected (and, since Story 4.5,
// authenticated) socket, because every device shows the floor and the menu.
// Order events are not: a kitchen ticket carries guests' seat notes and belongs
// on the kitchen's screen only.
//
// Joining is policed in `src/server/socket/authenticate.ts` (`server.ts` only
// registers it): the kitchen role may join a production room; a waiter or owner
// may join a session room, and only for an order in their own restaurant.
//
// The room NAMES come from `./rooms`, shared with the join side — they used to
// be spelled separately in both files.

/**
 * A round reached one production destination: its lines only.
 *
 * Emitted AFTER the transaction commits and never for a replay (Story 4.5
 * Trap 3). Nothing listens yet — the kitchen display (5.3) and the print queue
 * (5.0) are later — and a socket event is not durable, so the committed
 * `order_rounds` / `order_events` rows are the record, not this.
 */
export function emitOrderSubmitted(payload: OrderSubmittedPayload): void {
  try {
    getIO().to(productionRoom(payload.destination)).emit('order:submitted', payload)
  } catch (error) {
    // The round is already committed. A socket failure must not undo that.
    console.error('[socket] Failed to emit order:submitted:', error)
  }
}

/** A round was sent on this order — for the other tablets that have it open. */
export function emitOrderConfirmed(payload: OrderConfirmedPayload): void {
  try {
    getIO().to(sessionRoom(payload.sessionId)).emit('order:confirmed', payload)
  } catch (error) {
    console.error('[socket] Failed to emit order:confirmed:', error)
  }
}

/**
 * A print job gave up after its retries (Story 5.0, AC-6).
 *
 * Owner room only: it names tables, and the job behind it holds guests' seat
 * notes.
 *
 * ── The worker does NOT call this ────────────────────────────────────────────
 * It cannot: this module is `server-only` and the worker is loaded from
 * `server.ts`. `src/server/print/worker.ts` emits the same event through the
 * same `global.__io` handle `getIO()` reads. This function exists for callers
 * INSIDE Next — Story 5.2's reprint, and Epic 9's dashboard — so they do not
 * hand-type the event name. Both sides take `PrinterAlertPayload`, which is
 * where the shape is kept honest.
 */
export function emitPrinterAlert(payload: PrinterAlertPayload): void {
  try {
    getIO().to(OWNER_ROOM).emit('printer:alert', payload)
  } catch (error) {
    console.error('[socket] Failed to emit printer:alert:', error)
  }
}

