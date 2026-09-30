/**
 * Socket.io room names — the ONE place they are spelled.
 *
 * Dependency-free on purpose (no `server-only`, no aliases): the emit side
 * (`events.ts`, inside Next) and the join side (`authenticate.ts`, loaded from
 * `server.ts`) both import this. They used to hardcode the same strings
 * separately, so a rename on one side would have stopped delivery with no error
 * — the exact failure `events.ts`'s header warns about for `table:statusChanged`
 * and `menu:itemUpdated`. Same reasoning as `src/server/auth/session-cookie.ts`.
 */

export type ProductionRoom = 'kitchen' | 'pizza_kitchen' | 'bar'

/** FR9's destinations are the room names, one per production station. */
export function productionRoom(
  destination: 'kitchen' | 'pizza_kitchen' | 'bar',
): ProductionRoom {
  return destination
}

/** Everyone looking at one order. */
export function sessionRoom(sessionId: string): string {
  return `session:${sessionId}`
}

export const OWNER_ROOM = 'owner'

/** Subscribe command → the production room it joins. */
export const PRODUCTION_SUBSCRIBE: Record<string, ProductionRoom> = {
  'kitchen:subscribe': 'kitchen',
  'pizza:subscribe': 'pizza_kitchen',
  'bar:subscribe': 'bar',
}

export const SESSION_ROOM_PREFIX = 'session:'
