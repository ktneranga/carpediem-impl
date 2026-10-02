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
 * every uncertainty this layer CAN see — refused, unreachable, timed out,
 * closed mid-write, a write that errored, a close before the write flushed —
 * rejects, and the queue retries.
 *
 * ── What it cannot see, stated plainly ───────────────────────────────────────
 * A peer that accepts the bytes and throws them away is indistinguishable from
 * one that prints them. TCP acknowledges delivery to the far end's KERNEL; no
 * part of raw ESC/POS over port 9100 acknowledges that anything was printed.
 *
 * Measured, not assumed: against a printer that accepts, reads nothing and
 * sends a clean FIN, the write callback fires at 6ms with no error and the
 * peer's FIN is not observed until 9ms. So "did the peer close before we
 * finished sending" cannot be answered in time to decide the outcome.
 *
 * The obvious heuristic — wait after writing and treat an early FIN as a
 * refusal — is worse than the problem: printers that close the connection
 * after every job are common, and each would be retried six times and
 * dead-lettered, so every ticket would print six times. Choosing between a
 * rare silent loss and a routine six-fold duplicate is a service decision, not
 * a coding one; it is recorded in `deferred-work.md` rather than guessed at
 * here. If it has to be closed, the answer is `DLE EOT` real-time status, and
 * that is a protocol conversation, not a flag.
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
 * on the request path waits for a printer. Five seconds is simply longer than a
 * healthy printer takes to accept a few hundred bytes.
 *
 * It is NOT free, and the queue's comments used to understate this: six
 * attempts against an unresponsive printer spend 30 seconds BLOCKING on top of
 * the ladder's 53 seconds of waiting, so a dead station reaches its
 * dead-letter in about 83 seconds, and every ticket behind it waits that long.
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
    /**
     * Did the write actually flush?
     *
     * Without this, the `close` handler resolved on `hadError === false`
     * alone — and a printer that accepts the connection and then sends a clean
     * FIN (out of paper, spooler full, firmware restarting, a print server
     * that accepts and defers) produces no `error` and no `timeout`. The
     * promise resolved, the job was marked `printed`, which is terminal, and
     * the ticket was lost in silence: no retry, no dead-letter, no alert.
     * Reproduced twice in review — "RESOLVED after 6ms".
     */
    let wrote = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }

    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)

    // Consume the read side, even though a printer has nothing to say worth
    // reading. ESC/POS Automatic Status Back is ON by default on many
    // Epson-compatible models: those bytes arrive, and with the socket paused
    // and no reader, EOF is never reached, `close` never fires, and the idle
    // timer rejects a print that ALREADY HAPPENED — which the queue then
    // retries five more times. Measured in review: 400 bytes delivered, then
    // "did not respond within 5000ms".
    socket.resume()

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
        wrote = true
        // Flushed to the kernel. Close our half; the peer's FIN follows.
        socket.end()
      })
    })

    socket.on('close', (hadError) => {
      if (settled) return
      if (hadError) {
        finish(new Error(`printer at ${host}:${port}: connection closed with an error`))
        return
      }
      if (!wrote) {
        // The peer hung up politely before our bytes were out. No `error`, no
        // `timeout` — this branch is the only thing between that and a ticket
        // recorded as printed that never was.
        finish(
          new Error(`printer at ${host}:${port}: closed the connection before the ticket was sent`),
        )
        return
      }
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
