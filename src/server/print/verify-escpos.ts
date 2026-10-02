/**
 * Story 5.2 — the ticket bytes and the socket, verified against a fake printer.
 *
 * No thermal printer exists on any machine this project runs on, so a local TCP
 * server stands in for one (`fake-printer.ts`) and every assertion is made
 * against the bytes it captured. That covers everything except the one thing it
 * cannot: whether a real printer of the model eventually bought agrees about
 * the code page and the cut command.
 *
 * ── Run it ───────────────────────────────────────────────────────────────────
 *   pnpm exec tsx --env-file=.env src/server/print/verify-escpos.ts
 *
 * Needs no database and no dev server: the byte builder is pure and the
 * transport talks to the fake. Safe to run at any time.
 */
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTicket, clockTime, foldToAscii, PAPER_COLUMNS, wrapLine } from './escpos'
import { escposTcpTransport } from './escpos-transport'
import { closedPort, startFakePrinter } from './fake-printer'
import type { TicketPayload } from '@/types/tickets'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const ticket = (over: Partial<TicketPayload> = {}): TicketPayload => ({
  destination: 'kitchen',
  roundNumber: 2,
  tableLabels: ['Table 3'],
  usesSeats: true,
  submittedAt: new Date(2026, 8, 25, 14, 34).toISOString(),
  lines: [
    { eventId: 'a', name: 'Butter Prawns', quantity: 2, modifierText: 'no chilli', seatLabel: 'Seat 1', seatNote: 'red shirt' },
    { eventId: 'b', name: 'Crab Curry', quantity: 1, modifierText: null, seatLabel: 'Seat 1', seatNote: 'red shirt' },
    { eventId: 'c', name: 'Fish Cutlets', quantity: 3, modifierText: null, seatLabel: 'Seat 2', seatNote: null },
  ],
  ...over,
})

const hex = (buffer: Buffer) => buffer.toString('hex')
const text = (buffer: Buffer) => buffer.toString('latin1')

async function main() {
  // ── The bytes ─────────────────────────────────────────────────────────────
  const kot = buildTicket(ticket())
  const asText = text(kot)

  check('starts with ESC @ (initialise)', hex(kot).startsWith('1b40'), hex(kot).slice(0, 8))
  check('ends with the partial cut GS V 66 3', hex(kot).endsWith('1d564203'), hex(kot).slice(-12))
  check('header is the ticket type, doubled and bold',
    asText.includes('KOT') && hex(kot).includes('1d2111') && hex(kot).includes('1b4501'),
    'KOT + GS!17 + ESC E 1')
  check('names the table (FR18)', asText.includes('Table 3'))
  check('carries the round and a readable time (AC-2)',
    asText.includes('Round 2') && asText.includes('2:34 PM'),
    asText.split('\n').find((l) => l.includes('Round')))
  check('groups items under their seat, with the note',
    asText.includes('Seat 1 (red shirt)') && asText.includes('Seat 2'))
  check('quantity and name on one line, modifier beneath',
    asText.includes('2 x Butter Prawns') && asText.includes('- no chilli'))
  check('a dish for a different seat is under that seat',
    asText.indexOf('Fish Cutlets') > asText.indexOf('Seat 2'))

  const bot = buildTicket(ticket({ destination: 'bar', lines: [] }))
  const kotp = buildTicket(ticket({ destination: 'pizza_kitchen', lines: [] }))
  check('BOT and KOT-P are typed correctly (FR14-16)',
    text(bot).includes('BOT') && text(kotp).includes('KOT-P'))

  const counter = buildTicket(ticket({ tableLabels: ['COUNTER'], usesSeats: false }))
  check('a counter sale prints COUNTER and no seat headings (FR18)',
    text(counter).includes('COUNTER') && !text(counter).includes('Seat 1'))

  // ── Text safety (AC-8) ────────────────────────────────────────────────────
  check('folds the characters this app actually emits',
    foldToAscii('Devilled Cashew × 3 · Crème — “quoted”') === 'Devilled Cashew x 3 - Creme - "quoted"',
    foldToAscii('Devilled Cashew × 3 · Crème — “quoted”'))
  check('drops what has no ASCII equivalent', foldToAscii('Fish 🐟 curry') === 'Fish  curry',
    JSON.stringify(foldToAscii('Fish 🐟 curry')))
  const dirty = buildTicket(ticket({
    lines: [{ eventId: 'd', name: 'Crème Brûlée × 2 🍮', quantity: 1, modifierText: null, seatLabel: 'Seat 1', seatNote: null }],
  }))
  check('no byte above 0x7F leaves the builder',
    dirty.every((byte) => byte <= 0x7e), `max=0x${Math.max(...dirty).toString(16)}`)

  // ── Wrapping (AC-9) ───────────────────────────────────────────────────────
  const long = 'Grilled Seer Fish with Coconut Sambol and Red Rice on the Side'
  const wrapped = wrapLine(`1 x ${long}`, 2)
  check('a long name wraps rather than truncating',
    wrapped.length > 1 && wrapped.join(' ').includes('Side') &&
      wrapped.every((line) => line.length <= PAPER_COLUMNS),
    JSON.stringify(wrapped))
  check('quantity and name stay on the same line', wrapped[0].trim().startsWith('1 x Grilled'))
  check('every line of a built ticket fits the paper',
    text(buildTicket(ticket({
      lines: [{ eventId: 'e', name: long, quantity: 1, modifierText: long, seatLabel: 'Seat 1', seatNote: null }],
    })))
      .split('\n')
      .every((line) => line.replace(/[\x00-\x1f]/g, '').length <= PAPER_COLUMNS))

  check('the clock is formatted here, not by the host locale',
    clockTime(new Date(2026, 0, 1, 0, 5).toISOString()) === '12:05 AM' &&
      clockTime(new Date(2026, 0, 1, 13, 0).toISOString()) === '1:00 PM')

  // ── The socket (AC-3) ─────────────────────────────────────────────────────
  const printer = await startFakePrinter('accept')
  await escposTcpTransport('127.0.0.1', printer.port).deliver(ticket())
  check('the printer received one connection', printer.received.length === 1, String(printer.received.length))
  check('and the bytes it got are the bytes the builder made',
    hex(printer.received[0]) === hex(kot), `${printer.received[0]?.length} bytes`)
  await printer.close()

  // ── The failures (AC-4) ───────────────────────────────────────────────────
  const dead = await closedPort()
  let refusedMessage = ''
  try {
    await escposTcpTransport('127.0.0.1', dead).deliver(ticket())
  } catch (error) {
    refusedMessage = String(error)
  }
  check('a refused connection REJECTS', refusedMessage.includes('ECONNREFUSED'), refusedMessage)

  const hanging = await startFakePrinter('hang')
  const startedAt = Date.now()
  let timedOut = ''
  try {
    await escposTcpTransport('127.0.0.1', hanging.port).deliver(ticket())
  } catch (error) {
    timedOut = String(error)
  }
  const waited = Date.now() - startedAt
  check('a printer that accepts and never reads REJECTS on timeout',
    timedOut.includes('did not respond'), timedOut)
  check('and it does so within the per-attempt budget, not for ever',
    waited >= 4_000 && waited < 8_000, `${waited}ms`)
  await hanging.close()

  const dropping = await startFakePrinter('dropMidWrite')
  let dropped = ''
  try {
    await escposTcpTransport('127.0.0.1', dropping.port).deliver(ticket())
  } catch (error) {
    dropped = String(error)
  }
  check('a printer that hangs up mid-write REJECTS', dropped !== '', dropped || 'resolved — WRONG')
  await dropping.close()

  // ── The seam (AC-7) ───────────────────────────────────────────────────────
  const { resolveTransport } = await import('./transport')
  delete process.env.PRINTER_IP
  check('no PRINTER_IP → the null transport', resolveTransport('kitchen').name.startsWith('null:'),
    resolveTransport('kitchen').name)
  process.env.PRINTER_IP = '127.0.0.1'
  process.env.PRINTER_PORT = '9100'
  check('PRINTER_IP set → the ESC/POS transport',
    resolveTransport('kitchen').name === 'escpos:127.0.0.1:9100', resolveTransport('kitchen').name)
  delete process.env.PRINTER_IP

  // ── Through the queue, end to end ─────────────────────────────────────────
  // The parts above are the builder and the socket in isolation. This is the
  // one that matters: a row in `print_jobs`, drained by the real worker with
  // the real `resolveTransport`, arriving at a printer as bytes.
  //
  // Needs the database, and the DEV SERVER STOPPED — its worker would claim
  // these jobs first with the null transport.
  const { Pool } = await import('pg')
  const { drainPrintQueue } = await import('./worker')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  const sql = async (query: string, params: unknown[] = []) => (await pool.query(query, params)).rows

  const seed = async (destination: string, roundNumber: number) => {
    const [row] = await sql(
      `INSERT INTO print_jobs (tenant_id, session_id, round_id, destination, ticket)
       SELECT s.tenant_id, s.id, o.id, $1::production_destination, $2::jsonb
         FROM order_rounds o JOIN order_sessions s ON s.id = o.session_id
        ORDER BY o.submitted_at DESC LIMIT 1
       RETURNING id`,
      [destination, JSON.stringify(ticket({ destination: destination as TicketPayload['destination'], roundNumber, tableLabels: ['E2E'] }))],
    )
    return (row as { id: string }).id
  }

  const live = await startFakePrinter('accept')
  process.env.PRINTER_IP = '127.0.0.1'
  process.env.PRINTER_PORT = String(live.port)

  const kitchenJob = await seed('kitchen', 801)
  const barJob = await seed('bar', 802)
  const drained = await drainPrintQueue()
  check('the worker delivered both jobs to the printer',
    drained.printed === 2 && live.received.length === 2,
    `printed=${drained.printed} connections=${live.received.length}`)
  check('each arrived as its own ticket, correctly typed',
    live.received.some((b) => text(b).includes('KOT')) && live.received.some((b) => text(b).includes('BOT')),
    live.received.map((b) => text(b).split('\n')[0].trim()).join(' | '))
  const states = await sql(`SELECT status::text FROM print_jobs WHERE id = ANY($1)`, [[kitchenJob, barJob]])
  check('and both rows are printed',
    states.every((row) => (row as { status: string }).status === 'printed'), JSON.stringify(states))
  await live.close()

  // A job already in the queue, delivered to a printer that refuses.
  const refusedPort = await closedPort()
  process.env.PRINTER_PORT = String(refusedPort)
  const orphan = await seed('kitchen', 803)
  const failedDrain = await drainPrintQueue()
  const [orphanRow] = await sql(
    `SELECT status::text, attempts, last_error FROM print_jobs WHERE id = $1`, [orphan])
  const row = orphanRow as { status: string; attempts: number; last_error: string }
  check('a refused printer sends the job back to the queue, not to printed',
    failedDrain.printed === 0 && row.status === 'pending' && row.attempts === 1,
    `${row.status} attempts=${row.attempts}`)
  check('and the printer error is what gets recorded',
    (row.last_error ?? '').includes('ECONNREFUSED'), row.last_error)

  await sql(`DELETE FROM print_jobs WHERE id = ANY($1)`, [[kitchenJob, barJob, orphan]])
  delete process.env.PRINTER_IP
  delete process.env.PRINTER_PORT
  await pool.end()

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
  process.exit(results.every(Boolean) ? 0 : 1)
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
} else {
  console.error('[verify-escpos] Imported rather than run directly — doing nothing.')
}
