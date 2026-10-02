/**
 * How a ticket reaches a station (Story 5.0, Task 4).
 *
 * ── A seam, on purpose ───────────────────────────────────────────────────────
 * This story builds the QUEUE: durability, ordering, retries, dead-lettering.
 * It deliberately does not print. Story 5.2 owns ESC/POS byte assembly, the TCP
 * client and the USB/TCP mode split, and lands as one more implementation of
 * `TicketTransport` — `resolveTransport` gains a branch and nothing else in the
 * queue changes.
 *
 * ── Resolved at DELIVERY time, not at enqueue time ───────────────────────────
 * A job names its production destination; which device that destination points
 * at is read when the job is delivered. A printer swapped or re-addressed at
 * 7pm must not strand the jobs queued against its old address at 6:55pm.
 *
 * No `server-only` anywhere in this folder: the worker is loaded from
 * `server.ts`, outside Next, where that module throws at import time.
 */
import type { TicketPayload } from '@/types/tickets'
import { clockTime, groupBySeat, ticketTypeOf } from './escpos'
import { escposTcpTransport } from './escpos-transport'

export type TicketTransport = {
  /** For the log line and for `last_error` context. */
  readonly name: string
  deliver(ticket: TicketPayload): Promise<void>
}

// `ticketTypeOf` moved to `escpos.ts` with the rest of the layout in Story 5.2,
// and is re-exported here because callers already import it from this module.
export { ticketTypeOf }

/**
 * The ticket as plain text.
 *
 * Only the null transport uses this, to make a queued ticket READABLE in the
 * log — a queue you cannot see is a queue you cannot verify. Story 5.2's byte
 * builder is a separate thing and owns the real layout: paper width, code page,
 * bold, double-height and the cut command.
 */
export function renderTicketText(ticket: TicketPayload): string {
  const lines: string[] = []
  lines.push(`${ticketTypeOf(ticket.destination)}  ·  ${ticket.tableLabels.join(' + ')}`)
  lines.push(`Round ${ticket.roundNumber}  ·  ${clockTime(ticket.submittedAt)}`)
  lines.push('—'.repeat(32))

  // Grouped by seat, because that is how the runner hands the plates out
  // (epics.md Story 5.1: items grouped by seat slot with the seat as header).
  // `groupBySeat` is shared with the byte builder — these were two loops with
  // the same intent, which is how the log and the paper start disagreeing.
  if (ticket.usesSeats) {
    for (const [seat, seatLines] of groupBySeat(ticket.lines)) {
      lines.push(seat)
      for (const line of seatLines) {
        lines.push(`  ${line.quantity} × ${line.name}`)
        if (line.modifierText) lines.push(`     — ${line.modifierText}`)
      }
    }
  } else {
    for (const line of ticket.lines) {
      lines.push(`${line.quantity} × ${line.name}`)
      if (line.modifierText) lines.push(`   — ${line.modifierText}`)
    }
  }

  return lines.join('\n')
}

/**
 * Where a ticket goes when no printer is configured.
 *
 * Every development machine (`.env:34` — `PRINTER_IP=` is blank on purpose,
 * "no printer on a dev machine"), and any station that has not been given one
 * yet. It marks the job `printed`, which is the honest outcome: the queue did
 * its part and there is nothing to deliver to. The ticket is logged so the
 * whole pipeline can be watched end to end without hardware.
 *
 * It must NEVER be what a real station silently falls back to — when Story 5.2
 * adds the TCP transport, a station configured to print and unreachable has to
 * fail and retry, not quietly "succeed" here.
 */
export const nullTransport: TicketTransport = {
  name: 'null',
  deliver(ticket) {
    console.log(
      `[print] no printer configured — ticket not delivered:\n${renderTicketText(ticket)}\n`,
    )
    return Promise.resolve()
  },
}

/**
 * The transport for a destination.
 *
 * Today every destination resolves the same way, because there is exactly one
 * printer in the environment (`PRINTER_IP`) and `station_configs` /
 * `printer_configs` hold no rows. When Story 10.3 gives stations real rows this
 * reads them — per destination, and per `connection_mode` for USB.
 *
 * Story 5.2 replaces the `TODO` branch with the ESC/POS TCP transport. Until it
 * does, a configured `PRINTER_IP` still resolves to the null transport rather
 * than pretending to print: this story has no byte builder to hand it.
 */
export function resolveTransport(destination: TicketPayload['destination']): TicketTransport {
  // ── A configured printer gets the real transport (Story 5.2) ──────────────
  // Read HERE, at delivery time, never at module load or at enqueue: a printer
  // re-addressed at 7pm must not strand the jobs queued against its old address
  // at 6:55pm (Story 5.0, Decision 2).
  //
  // Every destination resolves to the same printer today. `station_configs` and
  // `printer_configs` hold no rows and have no `connection_mode`, so per-station
  // printers and the USB path wait for Story 10.3 — building a second delivery
  // path behind a flag that cannot be set is how untested code ships.
  const host = process.env.PRINTER_IP
  if (host) {
    const port = Number(process.env.PRINTER_PORT ?? 9100)
    return escposTcpTransport(host, Number.isFinite(port) && port > 0 ? port : 9100)
  }

  // No printer configured: log the ticket and move on. Named per destination so
  // the log says WHICH station had nowhere to print, which is the first
  // question asked when a ticket does not appear.
  return { ...nullTransport, name: `null:${destination}` }
}
