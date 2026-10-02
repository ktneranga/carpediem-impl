/**
 * Turning a committed round into ticket payloads (Story 5.0, Task 2).
 *
 * ── Nothing in `src/server/print/` may import `server-only` ──────────────────
 * The worker in this folder is loaded from `server.ts`, outside Next's module
 * graph, where `server-only`'s default export throws at import time. This file
 * is only used by the enqueue side today, but keeping the whole folder free of
 * it means a later import from the worker cannot take the server down at boot.
 */
import type { TicketPayload } from '@/types/tickets'
import type { ProductionDestination, TicketLine } from '@/types/orders'

/**
 * Removes C0 and C1 control characters from text bound for a printer.
 *
 * ESC/POS treats control bytes as COMMANDS. `order_events.modifier_text` accepts
 * 120 characters of anything a waiter can type or paste — a newline, an escape,
 * a stray `\x1b` — and those bytes would be interpreted by printer firmware
 * rather than printed: cut the paper mid-ticket, switch to double-width for the
 * rest of the run, or drop the remainder entirely. Logged as deferred in the
 * Story 4.5 review; this is the story that carries the text toward the printer,
 * so it stops being deferred here.
 *
 * Tabs and newlines go too: ticket layout is decided by the byte builder in
 * Story 5.2, not by what someone typed into a modifier box.
 *
 * This is NOT the ESC/POS escaping layer. Story 5.2 still owns encoding the
 * remaining text for the printer's codepage.
 */
export function sanitizeTicketText(text: string | null): string | null {
  if (text === null) return null
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned === '' ? null : cleaned
}

/**
 * EVERY string on the line, not just the two a waiter types.
 *
 * The first version cleaned `modifierText` and `seatNote` only, on the grounds
 * that they are the free-text fields. But a dish name comes from `menu_items`
 * and a seat label from `seat_slots`, and Epic 10's menu admin will let an
 * owner type either — at which point an escape byte in a dish name reaches the
 * printer exactly as one in a modifier would. Control bytes are a property of
 * the PAPER, not of who typed them.
 */
function sanitizeLine(line: TicketLine): TicketLine {
  return {
    ...line,
    name: sanitizeTicketText(line.name) ?? line.name,
    seatLabel: sanitizeTicketText(line.seatLabel) ?? line.seatLabel,
    modifierText: sanitizeTicketText(line.modifierText),
    seatNote: sanitizeTicketText(line.seatNote),
  }
}

/**
 * One payload per destination present in the round.
 *
 * Everything is COPIED, never referenced: see `TicketPayload`'s header for why a
 * job printed six minutes late must not re-read its session.
 */
export function buildTicketPayloads(input: {
  byDestination: Map<ProductionDestination, TicketLine[]>
  roundNumber: number
  tableLabels: string[]
  usesSeats: boolean
  submittedAt: Date
  /**
   * The restaurant's zone, from `tenants.timezone`. Copied in here so the
   * printed time does not depend on whether `TZ` was set on the host — the
   * rule `src/server/time.ts` exists to enforce.
   */
  timeZone?: string
}): TicketPayload[] {
  return [...input.byDestination.entries()].map(([destination, lines]) => ({
    destination,
    roundNumber: input.roundNumber,
    // FR18: every table on the session, or the label COUNTER where it has none.
    // A counter sale still gets a ticket; it just has no table to name.
    tableLabels:
      input.tableLabels.length > 0
        ? // Sanitized like every other string that reaches paper: a table label
          // is owner-editable from Epic 10's configuration screens.
          input.tableLabels.map((label) => sanitizeTicketText(label) ?? label)
        : ['COUNTER'],
    usesSeats: input.usesSeats,
    submittedAt: input.submittedAt.toISOString(),
    timeZone: input.timeZone,
    lines: lines.map(sanitizeLine),
  }))
}
