import 'server-only'
import { getIO } from './index'

/**
 * Typed broadcast helpers.
 *
 * Event names follow architecture.md:372-386 — `domain:action`, snake_case after
 * the colon, past tense for broadcasts. epics.md wrote `table:statusChanged` in
 * seven places; that was corrected on 2026-08-21. A camelCase listener never
 * fires, and nothing errors — real-time simply stops working silently.
 */

export type TableStatusChangedPayload = {
  tableId: string
  status: 'open' | 'occupied' | 'unavailable'
  sessionId: string | null
  openedAt: string | null
  itemCount: number
}

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
