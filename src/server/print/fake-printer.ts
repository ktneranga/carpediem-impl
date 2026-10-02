/**
 * A thermal printer, for machines that do not have one (Story 5.2, Task 5).
 *
 * A real ESC/POS printer on a network is a TCP socket that accepts bytes and
 * says nothing back. That is reproducible in twenty lines, and it is the only
 * way this story can be verified: there is no printer on any machine this
 * project runs on, and "I read the code and it looks right" is how a wrong
 * cut command ships.
 *
 * It also reproduces the failures that matter, which a real printer cannot be
 * asked to do on demand:
 *
 * - `refuse`    — nothing listening. ECONNREFUSED.
 * - `hang`      — accepts the connection and never reads. The half-open case a
 *                 connect-only timeout misses, and what an out-of-paper printer
 *                 looks like on some models.
 * - `dropMidWrite` — accepts, then destroys the socket. ECONNRESET.
 * - `politeRefusal` — accepts, reads NOTHING, and sends a clean FIN. Added
 *                 after review: this is the shape that produced neither an
 *                 `error` nor a `timeout`, so the transport resolved and a
 *                 ticket was recorded as printed that never was. Out of paper,
 *                 spooler full, firmware restarting, a print server deferring.
 * - `chatty`    — reads everything, writes a status byte back, then FINs.
 *                 ESC/POS Automatic Status Back is on by default on many
 *                 models; an unread reply meant EOF was never reached and a
 *                 SUCCESSFUL print timed out and was reprinted five times.
 *
 * Used by the verification scripts only. Nothing that ships imports it.
 */
import net from 'node:net'

export type FakePrinterMode = 'accept' | 'hang' | 'dropMidWrite' | 'politeRefusal' | 'chatty'

export type FakePrinter = {
  port: number
  /** Every byte stream received, one entry per connection, in arrival order. */
  received: Buffer[]
  /** The last stream, decoded as latin1 so command bytes survive the round trip. */
  lastAsText(): string
  close(): Promise<void>
}

/**
 * Starts one on an ephemeral port on the loopback interface.
 *
 * Port 0 lets the OS choose, so two verification runs cannot collide on 9100 —
 * and so nothing binds a port a real printer might be using.
 */
export function startFakePrinter(mode: FakePrinterMode = 'accept'): Promise<FakePrinter> {
  const received: Buffer[] = []
  // Every socket this fake has accepted. `server.close()` only stops it
  // listening — it waits for live connections to end before its callback runs,
  // and the `hang` mode's socket never does. Closing without destroying these
  // first left `close()` pending for ever, which stopped the verification
  // script mid-run with no error and no output: Node simply ran out of work and
  // exited 0 while an `await` was still outstanding.
  const live = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    live.add(socket)
    socket.on('close', () => live.delete(socket))

    if (mode === 'hang') {
      // Accept and ignore. Read nothing, write nothing, do not close: the
      // client's own timeout has to be what ends this.
      socket.pause()
      return
    }
    if (mode === 'dropMidWrite') {
      socket.destroy()
      return
    }
    if (mode === 'politeRefusal') {
      // Accept, read nothing, close cleanly. No RST, so the client sees no
      // error — the whole point of this mode.
      socket.pause()
      socket.end()
      return
    }

    const chunks: Buffer[] = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      // A real printer with ASB enabled volunteers status bytes. The client
      // must consume them, or it never sees EOF.
      if (mode === 'chatty') socket.write(Buffer.from([0x14]))
    })
    socket.on('end', () => {
      received.push(Buffer.concat(chunks))
      socket.end()
    })
    socket.on('error', () => {
      // A client that hangs up rudely is not this fake's problem.
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('fake printer did not get a port'))
        return
      }
      resolve({
        port: address.port,
        received,
        lastAsText: () => (received.at(-1) ?? Buffer.alloc(0)).toString('latin1'),
        close: () =>
          new Promise<void>((done) => {
            for (const socket of live) socket.destroy()
            live.clear()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * A port with nothing behind it — the ECONNREFUSED case.
 *
 * Opens a listener only long enough to be given a free port, then closes it, so
 * the number is one nothing is using. Racy in principle, fine on a dev machine.
 */
export async function closedPort(): Promise<number> {
  const printer = await startFakePrinter('accept')
  const { port } = printer
  await printer.close()
  return port
}
