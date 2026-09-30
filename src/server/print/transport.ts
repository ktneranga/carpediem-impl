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

export type TicketTransport = {
  /** For the log line and for `last_error` context. */
  readonly name: string
  deliver(ticket: TicketPayload): Promise<void>
}

/** KOT / KOT-P / BOT (FR14–FR16). */
export function ticketTypeOf(destination: TicketPayload['destination']): string {
  if (destination === 'pizza_kitchen') return 'KOT-P'
  if (destination === 'bar') return 'BOT'
  return 'KOT'
}

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
  lines.push(`Round ${ticket.roundNumber}  ·  ${new Date(ticket.submittedAt).toLocaleTimeString()}`)
  lines.push('—'.repeat(32))

  if (ticket.usesSeats) {
    // Grouped by seat, because that is how the runner hands the plates out
    // (epics.md Story 5.1: items grouped by seat slot with the seat as header).
    const bySeat = new Map<string, typeof ticket.lines>()
    for (const line of ticket.lines) {
      const header = line.seatNote ? `${line.seatLabel} (${line.seatNote})` : line.seatLabel
      const existing = bySeat.get(header)
      if (existing) existing.push(line)
      else bySeat.set(header, [line])
    }
    for (const [seat, seatLines] of bySeat) {
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
  // ── A CONFIGURED printer must never resolve to the null transport ─────────
  // It did, unconditionally. Set `PRINTER_IP` today and every ticket was
  // recorded `printed` — a terminal state with no re-queue — while nothing came
  // out of the printer. Found in review, and it is the exact rule the null
  // transport's own header states ("It must NEVER be what a real station
  // silently falls back to").
  //
  // Until Story 5.2 writes the bytes there is nothing to deliver WITH, so the
  // honest outcome is failure: the job retries, dead-letters, and alerts the
  // owner, which is visible. Pretending to print is not.
  if (process.env.PRINTER_IP) {
    return {
      name: `unimplemented:${destination}`,
      deliver: () =>
        Promise.reject(
          new Error(
            `PRINTER_IP is set but ESC/POS delivery is not implemented yet (Story 5.2). ` +
              `Unset PRINTER_IP to queue tickets without printing them.`,
          ),
        ),
    }
  }

  // Story 5.2: return the ESC/POS TCP (or USB) transport for this destination's
  // station, reading its address at DELIVERY time so a re-pointed printer does
  // not strand queued jobs.
  //
  // Named per destination so the log says WHICH station had nowhere to print,
  // which is the first question asked when a ticket does not appear.
  return { ...nullTransport, name: `null:${destination}` }
}
