/**
 * Whether a zone's orders track seats (see the note above `zoneUsesSeats`'s
 * re-export in `lib/design.ts`). Its own module, importing nothing, so server
 * code run outside Next (the verify scripts) can use it without pulling the
 * icon set into a react-server process.
 */
const SEATED_ZONES = new Set(['tables'])

export function zoneUsesSeats(zoneName: string | null): boolean {
  // A counter sale has no zone, and no seats.
  return zoneName !== null && SEATED_ZONES.has(zoneName.trim().toLowerCase())
}
