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
import { isDrawerKickPayload, isReceiptPayload, isTakingsPayload, type PrintDestination, type PrintPayload, type ReceiptPayload, type TicketPayload } from '@/types/tickets'
import { percentFromBp } from '@/lib/format'
import {
  calendarDate,
  clockTime,
  groupBySeat,
  receiptMoney,
  serveWithLine,
  ticketTypeOf,
} from './escpos'
import { dailyOrderLabel } from '@/lib/order-number'
import { escposTcpTransport } from './escpos-transport'
import { usbTransport } from './usb-transport'

export type TicketTransport = {
  /** For the log line and for `last_error` context. */
  readonly name: string
  /** A kitchen ticket or, since Story 6.6, a guest's bill. */
  deliver(ticket: PrintPayload): Promise<void>
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
/**
 * A line's options as the paper shows them — the same guard and the same
 * placeholder as the ESC/POS builder, so the log never disagrees with the
 * paper: a stored payload's `options` may be missing (a job from before 4.8)
 * or malformed, and a name that cleans to nothing still marks its line.
 */
function optionsOf(line: TicketPayload['lines'][number]): string[] {
  if (!Array.isArray(line.options)) return []
  return line.options.map((option) =>
    typeof option === 'string' && option.trim() !== '' ? option : '(option)',
  )
}

/** A guest's bill as plain text — the null transport's log of it (Story 6.6). */
function renderReceiptText(receipt: ReceiptPayload): string {
  const lines: string[] = []
  const row = (label: string, paisa: number) => lines.push(`${label}  ${receiptMoney(paisa)}`)
  lines.push(`${receipt.title}${receipt.copy ? ' (COPY)' : ''}  ·  ${receipt.tableLabels.join(' + ')}`)
  if (receipt.billLabel) lines.push(receipt.billLabel)
  lines.push('—'.repeat(32))
  for (const line of receipt.lines) {
    row(`${line.quantity} × ${line.name}`, line.amountPaisa)
    if (line.optionText) lines.push(`   - ${line.optionText}`)
    if (line.modifierText) lines.push(`   - ${line.modifierText}`)
  }
  for (const comp of receipt.comps) row(`Comp: ${comp.reason}`, comp.amountPaisa)
  row('Subtotal', receipt.subtotalPaisa)
  if ((receipt.discountPaisa ?? 0) > 0) row(`Discount ${percentFromBp(receipt.discountBp ?? 0)}%`, -(receipt.discountPaisa ?? 0))
  if (receipt.serviceChargeWaived === true) lines.push('Service charge  waived')
  else if (receipt.serviceChargeBp > 0) row(`Service ${percentFromBp(receipt.serviceChargeBp)}%`, receipt.serviceChargePaisa)
  if (receipt.taxBp > 0) row(`Tax ${percentFromBp(receipt.taxBp)}%`, receipt.taxPaisa)
  row('Total', receipt.totalPaisa)
  for (const tender of receipt.tenders) row(tender.method, tender.amountPaisa)
  return lines.join('\n')
}

export function renderTicketText(payload: PrintPayload): string {
  if (isDrawerKickPayload(payload)) return `CASH DRAWER (${payload.opening === 'no_sale' ? 'no sale' : 'sale'})`
  if (isReceiptPayload(payload)) return renderReceiptText(payload)
  if (isTakingsPayload(payload)) {
    const t = payload.takings
    return [
      `END OF DAY ${t.businessDate}`,
      `Orders ${t.orders}  ·  Billed ${t.billedPaisa}  ·  Paid ${t.paid.totalPaisa} (cash ${t.paid.cashPaisa}, card ${t.paid.cardPaisa})`,
      `Still open ${t.openOrders.length}  ·  No-sale ${t.noSales.length}`,
    ].join('\n')
  }
  const ticket: TicketPayload = payload
  const lines: string[] = []
  const number = Number.isInteger(ticket.dailyNumber) ? ` ${dailyOrderLabel(ticket.dailyNumber!)}` : ''
  lines.push(`${ticketTypeOf(ticket.destination)}${number}  ·  ${ticket.tableLabels.join(' + ')}${ticket.copy && ticket.copy.n > 1 ? `  (COPY ${ticket.copy.n}/${ticket.copy.of})` : ''}`)
  if (ticket.serverName) lines.push(`Waiter: ${ticket.serverName}`)
  lines.push(
    `Round ${ticket.roundNumber}  ·  ${calendarDate(ticket.submittedAt, ticket.timeZone)}  ${clockTime(ticket.submittedAt, ticket.timeZone)}`,
  )
  const serveWith = serveWithLine(ticket)
  if (serveWith) lines.push(serveWith)
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
        for (const option of optionsOf(line)) lines.push(`     - ${option}`)
        if (line.modifierText) lines.push(`     — ${line.modifierText}`)
      }
    }
  } else {
    for (const line of ticket.lines) {
      lines.push(`${line.quantity} × ${line.name}`)
      for (const option of optionsOf(line)) lines.push(`   - ${option}`)
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
export function resolveTransport(destination: PrintDestination): TicketTransport {
  // ── A configured printer gets the real transport (Story 5.2) ──────────────
  // Read HERE, at delivery time, never at module load or at enqueue: a printer
  // re-addressed at 7pm must not strand the jobs queued against its old address
  // at 6:55pm (Story 5.0, Decision 2).
  //
  // Every destination resolves to the same printer today. `station_configs` and
  // `printer_configs` hold no rows and have no `connection_mode`, so per-station
  // printers and the USB path wait for Story 10.3 — building a second delivery
  // path behind a flag that cannot be set is how untested code ships.
  // A printer on a USB cable (Teran, 2026-11-02) — its Windows printer name,
  // or a Linux device path. Checked first: a till with a USB printer has no
  // reason to also set an IP, and if both are set the cable is the one in use.
  const usbPrinter = process.env.PRINTER_USB_NAME?.trim()
  if (usbPrinter) return usbTransport(usbPrinter)

  const host = process.env.PRINTER_IP
  if (host) {
    // Every malformed value falls back to 9100 — including the two the first
    // version missed. `isFinite && > 0` let `91000` (a typo) and `9100.5`
    // through, and `net.createConnection` then throws `ERR_SOCKET_BAD_PORT`
    // for every ticket at every station: a one-digit mistake becomes a total
    // printing outage, while the same typo in the other direction silently
    // corrected itself.
    const configured = Number(process.env.PRINTER_PORT)
    const port =
      Number.isInteger(configured) && configured > 0 && configured <= 65535 ? configured : 9100
    return escposTcpTransport(host, port)
  }

  // No printer configured: log the ticket and move on. Named per destination so
  // the log says WHICH station had nowhere to print, which is the first
  // question asked when a ticket does not appear.
  return { ...nullTransport, name: `null:${destination}` }
}
