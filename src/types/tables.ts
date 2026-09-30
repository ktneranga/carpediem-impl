/**
 * Floor-plan types shared by the server and the grid.
 *
 * Here, not in `src/server/`, for the reason `src/types/orders.ts` gives:
 * `architecture.md` states that components never import from `src/server/`, and
 * `events.ts` carries `server-only`. The grid therefore kept its OWN copy of the
 * payload below — a second declaration of one contract, which drifted the moment
 * the emit side gained a field: the compiler was happy, the patch dropped the
 * new value on the floor, and the card showed a stale number.
 *
 * It imports nothing.
 */

/** `table:status_changed`, broadcast to every connected device. */
export type TableStatusChangedPayload = {
  tableId: string
  status: 'open' | 'occupied' | 'unavailable'
  sessionId: string | null
  openedAt: string | null
  itemCount: number
  /**
   * The session's running total in paisa. 0 when there is no session.
   *
   * Carried for the same reason as everything else here: the client PATCHES its
   * cache, so a field the payload omits keeps its stale value. The card shows
   * the count and the money side by side — an item count that moved while the
   * money beside it did not is worse than neither moving.
   */
  totalPaisa: number
  /**
   * Why the table is out of service; null otherwise.
   *
   * Carried on the event because the client PATCHES its cache rather than
   * refetching — so a field the payload omits keeps whatever stale value the
   * row already had. Without this, a device that did not initiate the change
   * showed "No reason recorded", and after a return-to-service the previous
   * outage's reason survived to be displayed against the next one.
   */
  unavailableReason: string | null
  /**
   * Every table on this session, in label order. Empty when there is no session.
   *
   * Carried because the client PATCHES its cache rather than refetching, and
   * `toGridUnits` decides a merged group exists SOLELY by this array's length.
   * Without it in the payload, a merge collapsed into one card only on the
   * device that performed it — every other tablet kept `groupTableLabels: []`
   * on the patched row and rendered the party as two separate occupied cards
   * with identical timers, which is the exact ambiguity collapsing exists to
   * remove. Un-merge was the mirror: survivors kept labels naming a table that
   * was already back on the floor as a free card in the same grid.
   *
   * Same reasoning as `unavailableReason` above — a field the payload omits
   * keeps whatever stale value the cached row already had.
   */
  groupTableLabels: string[]
}
