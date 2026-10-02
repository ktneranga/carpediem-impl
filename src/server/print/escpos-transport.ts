/**
 * Delivering a ticket to a thermal printer over TCP (Story 5.2, Task 2).
 *
 * Node's built-in `net`, straight to `PRINTER_IP:PRINTER_PORT` — port 9100 is
 * the raw-printing convention and what `architecture.md:244` specifies. No
 * library: the protocol on the wire is "write the bytes and hang up".
 *
 * ── One attempt. That is the contract ────────────────────────────────────────
 * The queue owns retries: five waits at 1s, 2s, 5s, 15s, 30s, then a
 * dead-letter and an alert (Story 5.0). A retry loop in here would multiply
 * that ladder, push the alert three times further away, and hold the station's
 * queue the whole time under head-of-line ordering. `deliver()` tries once and
 * either resolves or rejects.
 *
 * ── Rejecting is the safety property ─────────────────────────────────────────
 * A resolve means `printed`, which is terminal and has no re-queue path. So
 * every uncertainty — refused, unreachable, timed out, closed mid-write, write
 * not flushed — must REJECT. The bar is not "did we try", it is "do we know the
 * bytes arrived".
 */
import net from 'node:net'
import { buildTicket } from './escpos'
import type { TicketTransport } from './transport'
import type { TicketPayload } from '@/types/tickets'

/**
 * Per-attempt budget.
 *
 * `epics.md:1488` set five seconds when this was a synchronous call inside the
 * order handler, where it was the WAITER's budget. It is not any more — nothing
 * on the request path waits for a printer. Five seconds is now simply longer
 * than a healthy printer takes to accept a few hundred bytes, and short enough
 * that a dead one reaches its dead-letter inside a minute.
 */
const PRINT_TIMEOUT_MS = 5_000

/**
 * Writes one ticket, then closes.
 *
 * The sequence matters. `socket.write()` returning true means the data reached
 * a userspace buffer, NOT the printer, and a socket destroyed straight after a
 * write can discard what is still buffered. So: write, wait for its callback,
 * `end()`, and resolve only on `close` — with `hadError` false. Anything else
 * is a reject.
 */
function deliverOverTcp(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }

    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)

    // Covers the connect AND the write: a printer that accepts the connection
    // and then never drains — out of paper on some models, or a half-open
    // socket after a Wi-Fi drop — is the case a connect-only timeout misses.
    socket.setTimeout(PRINT_TIMEOUT_MS)

    socket.on('timeout', () => {
      // `setTimeout` only EMITS. It does not close the socket and it does not
      // throw, so without this handler the promise never settles — and the
      // drain loop is awaiting it, which would hang the whole queue on one
      // unreachable printer rather than just its own ticket.
      finish(new Error(`printer at ${host}:${port} did not respond within ${PRINT_TIMEOUT_MS}ms`))
    })

    socket.on('error', (error) => {
      // ECONNREFUSED (nothing listening), EHOSTUNREACH (wrong subnet, printer
      // off), ECONNRESET (it hung up mid-write).
      finish(new Error(`printer at ${host}:${port}: ${error.message}`))
    })

    socket.on('connect', () => {
      socket.write(bytes, (writeError) => {
        if (writeError) {
          finish(new Error(`printer at ${host}:${port}: write failed — ${writeError.message}`))
          return
        }
        // Flushed to the kernel. Close our half and let the printer's FIN
        // confirm it took the connection to completion.
        socket.end()
      })
    })

    socket.on('close', (hadError) => {
      if (settled) return
      if (hadError) {
        finish(new Error(`printer at ${host}:${port}: connection closed with an error`))
        return
      }
      // A clean close AFTER the write callback fired. If the printer hung up
      // before that, the 'error' or 'timeout' handler has already settled this.
      finish()
    })
  })
}

/** The real transport, for a station that has a printer. */
export function escposTcpTransport(host: string, port: number): TicketTransport {
  return {
    name: `escpos:${host}:${port}`,
    deliver: (ticket: TicketPayload) => deliverOverTcp(host, port, buildTicket(ticket)),
  }
}
