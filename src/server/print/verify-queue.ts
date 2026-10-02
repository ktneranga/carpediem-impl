/**
 * Story 5.0 — the print queue's mechanics, verified against a real database.
 *
 * Retry, backoff, dead-lettering, the owner alert, backlog flushing, delivery
 * order, stale-claim recovery, and two workers racing. This project has no test
 * framework by decision, so every story verifies with a script; this one lives
 * in the repo rather than in a scratchpad because it is the only way to
 * exercise a FAILING printer, and Story 5.2 will want it again when it replaces
 * the transport.
 *
 * ── Run it ───────────────────────────────────────────────────────────────────
 *   pnpm exec tsx --env-file=.env src/server/print/verify-queue.ts
 *
 * STOP THE DEV SERVER FIRST. Its worker ticks every three seconds with the null
 * transport, which always succeeds — leave it running and it claims these jobs
 * first, so every failure case "passes" by printing.
 *
 * It touches only the rows THIS RUN created: every id it inserts is kept in
 * `mine`, and the cleanup deletes by id. An earlier version deleted by
 * `ticket->>'tableLabels' LIKE '%TEST%'`, which renders the whole JSON array as
 * text and would therefore have deleted the live, pending tickets of any real
 * table whose label contains that substring — an order with no ticket in the
 * kitchen, caused by the script that exists to prove that cannot happen.
 *
 * It borrows the most recent real round to satisfy the foreign keys, and never
 * writes to any other table.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { drainPrintQueue } from './worker'
import { resolveTransport, type TicketTransport } from './transport'
import type { TicketPayload } from '@/types/tickets'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

/** Every print_jobs id this run inserted. The cleanup deletes exactly these. */
const mine: string[] = []

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const failing: TicketTransport = {
  name: 'always-fails',
  deliver: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.9:9100')),
}
const delivered: string[] = []
const recording = (label: string): TicketTransport => ({
  name: label,
  deliver: (ticket: TicketPayload) => {
    delivered.push(`${label}:${ticket.roundNumber}`)
    return Promise.resolve()
  },
})

/** A job row written straight in — the queue does not care who queued it. */
async function seedJob(
  roundNumber: number,
  destination: TicketPayload['destination'] = 'kitchen',
): Promise<string> {
  const [row] = await sql(
    `INSERT INTO print_jobs (tenant_id, session_id, round_id, destination, ticket)
     SELECT s.tenant_id, s.id, o.id, $1::production_destination, $2::jsonb
       FROM order_rounds o
       JOIN order_sessions s ON s.id = o.session_id
      ORDER BY o.submitted_at DESC LIMIT 1
     RETURNING id`,
    [
      destination,
      JSON.stringify({
        destination,
        roundNumber,
        tableLabels: ['TEST'],
        usesSeats: false,
        submittedAt: new Date().toISOString(),
        lines: [{ eventId: 'x', name: 'Test dish', quantity: 1, modifierText: null, seatLabel: 'Seat 1', seatNote: null }],
      } satisfies TicketPayload),
    ],
  )
  const id = (row as { id: string }).id
  mine.push(id)
  return id
}

const jobRow = async (id: string) =>
  (
    await sql(
      `SELECT status::text, attempts, last_error, printed_at,
              round(extract(epoch from (next_attempt_at - now()))) AS wait_s
         FROM print_jobs WHERE id = $1`,
      [id],
    )
  )[0] as { status: string; attempts: number; last_error: string | null; printed_at: Date | null; wait_s: string }

async function main() {
  // No pre-clean: this run's rows do not exist yet, and anything matching from
  // an earlier run is either already `printed` or belongs to a real order.

  // ── 1. Delivery marks the job printed ─────────────────────────────────────
  const ok = await seedJob(101)
  await drainPrintQueue(() => recording('ok'))
  let row = await jobRow(ok)
  check('a delivered job is printed, with a timestamp',
    row.status === 'printed' && row.printed_at !== null && row.attempts === 1,
    `${row.status} attempts=${row.attempts}`)

  // ── 2. Failure retries with backoff (AC-4) ────────────────────────────────
  const retry = await seedJob(102)
  const waits: number[] = []
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await drainPrintQueue(() => failing)
    row = await jobRow(retry)
    waits.push(Number(row.wait_s))
    // Fast-forward so the next drain finds it ready, instead of waiting 30s.
    await sql(`UPDATE print_jobs SET next_attempt_at = now() WHERE id = $1`, [retry])
  }
  check('attempts climb and last_error is recorded',
    row.attempts === 5 && (row.last_error ?? '').includes('ECONNREFUSED'),
    `attempts=${row.attempts} err=${row.last_error}`)
  // Five waits, one per rung. The fifth (30s) used to be unreachable: attempts
  // were capped at 5 and incremented at claim, so the job died before the last
  // rung was ever read, while the comment claimed it repeated (review finding).
  check('backoff walks the whole ladder: 1s, 2s, 5s, 15s, 30s',
    JSON.stringify(waits) === '[1,2,5,15,30]', JSON.stringify(waits))

  // ── 3. Dead-lettering alerts and keeps the row (AC-6) ─────────────────────
  const alerts: unknown[] = []
  // Story 5.2 made `printer:alert` a broadcast (the payload carries no guest
  // data, and nothing joins the owner room until Epic 9). The stub accepts both
  // shapes so this file does not have to care which one the worker chose.
  ;(globalThis as { __io?: unknown }).__io = {
    emit: (event: string, payload: unknown) => alerts.push({ room: '*', event, payload }),
    to: (room: string) => ({ emit: (event: string, payload: unknown) => alerts.push({ room, event, payload }) }),
  }
  await drainPrintQueue(() => failing)
  row = await jobRow(retry)
  check('the sixth failure dead-letters', row.status === 'dead' && row.attempts === 6,
    `${row.status} attempts=${row.attempts}`)
  check('the row is still there, with its last error',
    (row.last_error ?? '').includes('ECONNREFUSED'), String(row.last_error))
  const alert = alerts[0] as {
    room: string
    event: string
    payload: { attempts: number; tableLabels: string[]; kind: string }
  }
  check('printer:alert fired to every staff device',
    alerts.length === 1 && alert.room === '*' && alert.event === 'printer:alert',
    JSON.stringify(alerts.length ? { room: alert.room, event: alert.event } : 'none'))
  check('the alert names the tables and the attempt count',
    alert?.payload?.attempts === 6 && alert?.payload?.kind === 'dead' &&
      JSON.stringify(alert?.payload?.tableLabels) === '["TEST"]',
    JSON.stringify(alert?.payload))

  // ── 4. A returning printer flushes the backlog, in order (AC-5) ───────────
  const backlog: string[] = []
  for (const n of [201, 202, 203, 204, 205]) backlog.push(await seedJob(n))
  await drainPrintQueue(() => failing) // printer is down: nothing gets through
  const stillPending = await sql(
    `SELECT count(*) FROM print_jobs WHERE id = ANY($1) AND status = 'pending'`, [backlog])
  check('a down printer leaves the whole backlog queued',
    (stillPending[0] as { count: string }).count === '5', JSON.stringify(stillPending[0]))

  await sql(`UPDATE print_jobs SET next_attempt_at = now() WHERE id = ANY($1)`, [backlog])
  delivered.length = 0
  await drainPrintQueue(() => recording('flush')) // printer is back
  check('every job flushes with no restart and no staff action',
    delivered.length === 5, JSON.stringify(delivered.length))
  check('and they go out in creation order',
    JSON.stringify(delivered) === JSON.stringify(['flush:201', 'flush:202', 'flush:203', 'flush:204', 'flush:205']),
    JSON.stringify(delivered))

  // ── 4b. A station's order survives a failure (AC-3, AC-5) ────────────────
  // The case the original verification could not see: round 2 fails and backs
  // off, round 3 arrives while it is waiting. Before the head-of-line rule,
  // round 3 printed first — the kitchen cooking in the wrong order.
  const second = await seedJob(501)
  await drainPrintQueue(() => failing) // 501 fails, now backing off ~1s
  const third = await seedJob(502) // arrives during the backoff, ready at once
  delivered.length = 0
  await drainPrintQueue(() => recording('order'))
  check('a later ticket does NOT overtake one that is backing off',
    delivered.length === 0, JSON.stringify(delivered))
  check('and the later one is still queued, not skipped',
    (await jobRow(third)).status === 'pending')

  await sql(`UPDATE print_jobs SET next_attempt_at = now() WHERE id = $1`, [second])
  await drainPrintQueue(() => recording('order'))
  check('once the older ticket goes, the queue follows in order',
    JSON.stringify(delivered) === JSON.stringify(['order:501', 'order:502']), JSON.stringify(delivered))

  // A dead station must not block its queue for ever: `dead` is not "in play".
  const stuck = await seedJob(503)
  await sql(`UPDATE print_jobs SET status = 'dead', attempts = 6 WHERE id = $1`, [stuck])
  const after = await seedJob(504)
  delivered.length = 0
  await drainPrintQueue(() => recording('after-dead'))
  check('a dead-lettered ticket stops blocking the station',
    delivered.length === 1 && (await jobRow(after)).status === 'printed', JSON.stringify(delivered))

  // One station's backlog must never delay another's.
  const kitchenStuck = await seedJob(505, 'kitchen')
  await drainPrintQueue(() => failing) // kitchen is now backing off
  const barJob = await seedJob(506, 'bar')
  delivered.length = 0
  await drainPrintQueue(() => recording('bar'))
  check('a jammed kitchen printer does not hold up the bar',
    JSON.stringify(delivered) === JSON.stringify(['bar:506']), JSON.stringify(delivered))
  await sql(`UPDATE print_jobs SET status = 'dead' WHERE id = ANY($1)`, [[kitchenStuck, barJob]])

  // ── 5. A crash mid-print is recovered, once (AC-7) ────────────────────────
  const crashed = await seedJob(301)
  await sql(
    `UPDATE print_jobs SET status = 'printing', claimed_at = now() - interval '5 minutes', attempts = 1
      WHERE id = $1`, [crashed])
  delivered.length = 0
  const recovery = await drainPrintQueue(() => recording('recovered'))
  row = await jobRow(crashed)
  check('the recovery note survives on the printed row (Trap 3)',
    (row.last_error ?? '').includes('may already have printed'), String(row.last_error))
  check('a stale claim is recovered and delivered',
    recovery.recovered === 1 && row.status === 'printed' && delivered.length === 1,
    `recovered=${recovery.recovered} status=${row.status} deliveries=${delivered.length}`)

  // A job that keeps killing the worker mid-delivery must not be revived for
  // ever. Recovery used to have no ceiling, so `attempts` climbed past the
  // limit and the job never reached `dead` and never alerted — the crash loop
  // the design claimed to bound (review finding).
  const looping = await seedJob(303)
  await sql(
    `UPDATE print_jobs SET status = 'printing', claimed_at = now() - interval '5 minutes', attempts = 6
      WHERE id = $1`, [looping])
  alerts.length = 0
  const bounded = await drainPrintQueue(() => recording('should-not-run'))
  row = await jobRow(looping)
  check('a crash loop past the attempt ceiling dead-letters instead of reviving',
    row.status === 'dead' && bounded.recovered === 0 && bounded.dead === 1,
    `${row.status} recovered=${bounded.recovered} dead=${bounded.dead}`)
  check('and it alerts the owner on the way out', alerts.length === 1, String(alerts.length))

  const fresh = await seedJob(302)
  await sql(`UPDATE print_jobs SET status = 'printing', claimed_at = now() WHERE id = $1`, [fresh])
  const noRecovery = await drainPrintQueue(() => recording('should-not-run'))
  row = await jobRow(fresh)
  check('a FRESH claim is left alone — no double print',
    noRecovery.recovered === 0 && row.status === 'printing',
    `recovered=${noRecovery.recovered} status=${row.status}`)
  await sql(`DELETE FROM print_jobs WHERE id = $1`, [fresh])

  // ── 6. Two workers never claim the same job (AC-3) ────────────────────────
  const raced: string[] = []
  for (let n = 0; n < 12; n += 1) raced.push(await seedJob(400 + n))
  const seen: string[] = []
  const counting = (label: string): TicketTransport => ({
    name: label,
    deliver: (ticket) => { seen.push(String(ticket.roundNumber)); return Promise.resolve() },
  })
  const [a, b] = await Promise.all([
    drainPrintQueue(() => counting('A')),
    drainPrintQueue(() => counting('B')),
  ])
  const unique = new Set(seen)
  check('two workers deliver every job exactly once',
    seen.length === 12 && unique.size === 12 && a.printed + b.printed === 12,
    `deliveries=${seen.length} unique=${unique.size} A=${a.printed} B=${b.printed}`)

  // ── 6b. A configured printer must not resolve to "pretend" ────────────────
  // `resolveTransport` ignored PRINTER_IP entirely, so setting it marked every
  // ticket `printed` while nothing came out (review finding). Until Story 5.2
  // writes the bytes, a configured printer has to FAIL so the job retries and
  // eventually alerts.
  const noPrinter = resolveTransport('kitchen')
  let nullOk = false
  try {
    await noPrinter.deliver({
      destination: 'kitchen', roundNumber: 1, tableLabels: ['TEST'], usesSeats: false,
      submittedAt: new Date().toISOString(), lines: [],
    })
    nullOk = true
  } catch {
    nullOk = false
  }
  check('with no PRINTER_IP, delivery is the null transport and succeeds', nullOk, noPrinter.name)

  // Story 5.2 filled this branch with the real ESC/POS transport. The rule it
  // has to keep is the one that made the placeholder necessary: a station with
  // a printer configured must never fall back to something that reports
  // success without printing. `verify-escpos.ts` proves the delivery itself.
  process.env.PRINTER_IP = '10.0.0.9'
  const configured = resolveTransport('kitchen')
  delete process.env.PRINTER_IP
  check('with PRINTER_IP set, a REAL transport is chosen — never the null one',
    configured.name.startsWith('escpos:') && !configured.name.startsWith('null:'),
    configured.name)

  // ── 7. The table is mutable (AC-10) ───────────────────────────────────────
  let mutable = true
  try {
    await sql(`UPDATE print_jobs SET last_error = 'touched' WHERE id = $1`, [ok])
    await sql(`DELETE FROM print_jobs WHERE id = ANY($1)`, [mine])
  } catch {
    mutable = false
  }
  check('print_jobs accepts UPDATE and DELETE — it is not an audit table', mutable)

  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
  await pool.end()
  process.exit(results.every(Boolean) ? 0 : 1)
}

// Only when run directly. As a plain `void main()` at module scope, any glob,
// barrel export or module-graph trace that touched this file would have run a
// DELETE against DATABASE_URL and then called process.exit().
//
// Compared as resolved PATHS, not as strings: `import.meta.url` is percent-
// encoded ("New%20folder"), so an `endsWith` against argv[1] silently never
// matched and the script quietly did nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
} else {
  console.error('[verify-queue] Imported rather than run directly — doing nothing.')
}
