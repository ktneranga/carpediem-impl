/**
 * Order numbers (Teran, 2026-11-02) — migration 0032's triggers, end to end
 * against the real database.
 *
 *   pnpm exec tsx --env-file=.env src/server/services/verify-order-number.ts
 *
 * Works on business days in 2010 (Colombo on +5:30 since 2006), which no real order can have, and removes
 * every row it made.
 */
import pg from 'pg'
import { buildTicket } from '@/server/print/escpos'
import { dailyOrderLabel, orderReference } from '@/lib/order-number'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const made: string[] = []

/** Opens an order at a given instant, as the service does: no number sent. */
async function open(tenantId: string, staffId: string, openedAt: string, client: pg.PoolClient | pg.Pool = pool) {
  const { rows } = await client.query<{ id: string; business_date: string; daily_number: number }>(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, opened_at)
     VALUES ($1, 'counter', $2, $3)
     RETURNING id, business_date::text, daily_number`,
    [tenantId, staffId, openedAt],
  )
  made.push(rows[0]!.id)
  return rows[0]!
}

async function main() {
  const { rows: [who] } = await pool.query<{ tenant_id: string; id: string; timezone: string; start: number }>(
    `SELECT s.tenant_id, s.id, t.timezone, t.business_day_start_hour AS start
       FROM staff s JOIN tenants t ON t.id = s.tenant_id LIMIT 1`,
  )
  if (!who) throw new Error('no staff to open orders with — run the seed')
  check('the restaurant day starts at 4 AM by default', who.start === 4, String(who.start))

  // ── Numbered in order, per business day ───────────────────────────────────
  // Colombo is UTC+5:30, so 2010-03-10 12:00 local is 06:30Z.
  const a = await open(who.tenant_id, who.id, '2010-03-10T06:30:00Z')
  const b = await open(who.tenant_id, who.id, '2010-03-10T07:30:00Z')
  check('the first order of a day is #001', a.daily_number === 1 && a.business_date === '2010-03-10',
    `${a.business_date} #${a.daily_number}`)
  check('the next is #002', b.daily_number === 2, String(b.daily_number))

  // ── The 4 AM cut-off ──────────────────────────────────────────────────────
  // 03:59 local on the 11th is still the night of the 10th; 04:00 is the 11th.
  const late = await open(who.tenant_id, who.id, '2010-03-10T22:29:00Z') // 03:59 local, 11th
  const early = await open(who.tenant_id, who.id, '2010-03-10T22:30:00Z') // 04:00 local, 11th
  check('1 AM–3:59 AM belongs to last night\'s service', late.business_date === '2010-03-10' && late.daily_number === 3,
    `${late.business_date} #${late.daily_number}`)
  check('4 AM starts a new day at #001', early.business_date === '2010-03-11' && early.daily_number === 1,
    `${early.business_date} #${early.daily_number}`)

  // ── A caller cannot choose its number ─────────────────────────────────────
  const { rows: [forced] } = await pool.query<{ id: string; business_date: string; daily_number: number }>(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, opened_at, business_date, daily_number)
     VALUES ($1, 'counter', $2, '2010-03-10T08:00:00Z', '1999-01-01', 1)
     RETURNING id, business_date::text, daily_number`,
    [who.tenant_id, who.id],
  )
  made.push(forced!.id)
  check('a number sent with the insert is overwritten', forced!.business_date === '2010-03-10' && forced!.daily_number === 4,
    `${forced!.business_date} #${forced!.daily_number}`)

  // ── Two tablets at the same moment ────────────────────────────────────────
  // Each in its own transaction, committed independently — they queue on the
  // counter row's lock, exactly as eight real opens would.
  const clients = await Promise.all(Array.from({ length: 8 }, () => pool.connect()))
  try {
    const opened = await Promise.all(
      clients.map(async (client) => {
        await client.query('BEGIN')
        const row = await open(who.tenant_id, who.id, '2010-03-12T06:30:00Z', client)
        await client.query('COMMIT')
        return row
      }),
    )
    const numbers = opened.map((row) => row.daily_number).sort((x, y) => x - y)
    check('eight orders opened at once get #001–#008, no repeats',
      numbers.join(',') === '1,2,3,4,5,6,7,8', numbers.join(','))
  } finally {
    clients.forEach((client) => client.release())
  }

  // ── A rolled-back open gives its number back ──────────────────────────────
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const ghost = await open(who.tenant_id, who.id, '2010-03-13T06:30:00Z', client)
    made.pop()
    await client.query('ROLLBACK')
    const real = await open(who.tenant_id, who.id, '2010-03-13T06:30:00Z')
    check('a rolled-back open leaves no gap', ghost.daily_number === 1 && real.daily_number === 1,
      `ghost #${ghost.daily_number}, then #${real.daily_number}`)
  } finally {
    client.release()
  }

  // ── Never changes afterwards ──────────────────────────────────────────────
  const refused = await pool
    .query(`UPDATE order_sessions SET daily_number = 99 WHERE id = $1`, [a.id])
    .then(() => 'updated', (error: Error) => error.message)
  check('an order number cannot be changed', refused.includes('immutable'), refused)
  const closed = await pool
    .query(`UPDATE order_sessions SET closed_at = now() WHERE id = $1`, [a.id])
    .then(() => 'ok', (error: Error) => error.message)
  check('the rest of the order still updates (closing it)', closed === 'ok', closed)

  // ── How it reads, and on paper ────────────────────────────────────────────
  check('#042 and 20261102-042', dailyOrderLabel(42) === '#042' && orderReference('2026-11-02', 42) === '20261102-042')
  const paper = buildTicket({
    destination: 'kitchen', roundNumber: 2, tableLabels: ['Table 5'], usesSeats: false,
    submittedAt: '2026-11-02T14:12:00Z', timeZone: 'Asia/Colombo', dailyNumber: 42, businessDate: '2026-11-02',
    lines: [{ quantity: 1, name: 'Fried Rice', modifierText: null, seatLabel: 'Seat 1', seatNote: null }],
  } as never).toString('latin1')
  check('the ticket header reads "KOT #042"', paper.includes('KOT #042'))
  check('the ticket shows the date and time', paper.includes('02 Nov 2026  7:42 PM'))
  check('the foot shows the unique number', paper.includes('Order 20261102-042'))
  const old = buildTicket({
    destination: 'bar', roundNumber: 1, tableLabels: ['Table 5'], usesSeats: false,
    submittedAt: '2026-11-02T14:12:00Z', lines: [],
  } as never).toString('latin1')
  check('a job queued before order numbers prints without them', !old.includes('#') && !old.includes('Order '))
}

main()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(async () => {
    if (made.length > 0) {
      await pool.query(`DELETE FROM seat_slots WHERE session_id = ANY($1)`, [made]).catch(() => {})
      await pool.query(`DELETE FROM order_sessions WHERE id = ANY($1)`, [made])
    }
    await pool.query(`DELETE FROM order_number_counters WHERE business_date < '2011-01-01'`)
    await pool.end()
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exitCode = results.every(Boolean) ? 0 : 1
  })
