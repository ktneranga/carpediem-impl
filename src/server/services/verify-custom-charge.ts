/* eslint-disable @typescript-eslint/no-explicit-any -- This script reads
   arbitrary API JSON and asserts on its shape, as verify-bills.ts does.
   Nothing here is imported by the app. */
/**
 * Story 4.9 — custom charges, verified against the running server and
 * database. The story's 11-case matrix.
 *
 *   pnpm exec tsx --env-file=.env <this file>
 *
 * The DEV SERVER MUST BE RUNNING (pnpm dev): the sends go through the real
 * route and the proxy, so the owner-only gate is exercised for real.
 *
 * It creates its own sessions and deletes exactly the ids it created.
 */
import { Pool } from 'pg'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const mine = {
  bills: [] as string[],
  seats: [] as string[],
  sessionTables: [] as string[],
  sessions: [] as string[],
}

// ── Auth and HTTP ────────────────────────────────────────────────────────────
async function login(pin: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  const setCookie = response.headers.get('set-cookie')
  if (!response.ok || !setCookie) throw new Error(`login ${pin} failed: ${response.status}`)
  return setCookie.split(';')[0]!
}

type Json = { status: number; body: any }
async function api(cookie: string, path: string, init?: RequestInit): Promise<Json> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', cookie, ...(init?.headers ?? {}) },
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
async function makeSession(): Promise<{ sessionId: string; seatId: string; seat2Id: string }> {
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const [waiter] = await sql(`SELECT id FROM staff WHERE role = 'waiter' AND is_active LIMIT 1`)
  const [session] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id) VALUES ($1, 'table', $2) RETURNING id`,
    [tenant.id, waiter.id],
  )
  mine.sessions.push(session.id)
  const seatIds: string[] = []
  for (const label of ['S1', 'S2']) {
    const [seat] = await sql(
      `INSERT INTO seat_slots (session_id, seat_label) VALUES ($1, $2) RETURNING id`,
      [session.id, label],
    )
    mine.seats.push(seat.id)
    seatIds.push(seat.id)
  }
  const [table] = await sql(
    `SELECT t.id FROM tables t
      WHERE NOT EXISTS (
        SELECT 1 FROM order_session_tables ost
         WHERE ost.table_id = t.id AND ost.released_at IS NULL)
      LIMIT 1`,
  )
  if (!table) throw new Error('no free table for the fixture')
  await sql(`INSERT INTO order_session_tables (session_id, table_id) VALUES ($1, $2)`, [
    session.id,
    table.id,
  ])
  mine.sessionTables.push(`${session.id}|${table.id}`)
  return { sessionId: session.id, seatId: seatIds[0]!, seat2Id: seatIds[1]! }
}

/** A dish the send route accepts with no options. */
async function plainDish(): Promise<{ id: string; price_paisa: number }> {
  const [item] = await sql(`SELECT id, price_paisa FROM menu_items m
    WHERE m.is_available
      AND NOT EXISTS (
        SELECT 1 FROM modifier_groups g
         WHERE g.menu_item_id = m.id AND g.is_active AND g.is_required)
    ORDER BY production_destination LIMIT 1`)
  return item
}

async function send(cookie: string, sessionId: string, lines: unknown[], submissionId = crypto.randomUUID()) {
  return api(cookie, `/api/sessions/${sessionId}/orders`, {
    method: 'POST',
    body: JSON.stringify({ submissionId, lines }),
  })
}

const count = async (text: string, params: unknown[]) => (await sql(text, params))[0].n as number

// ── The matrix ───────────────────────────────────────────────────────────────
async function main() {
  try {
    await run()
  } finally {
    await cleanup()
  }
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

async function run() {
  const owner = await login('5678')
  const waiter = await login('1234')
  const [ownerRow] = await sql(`SELECT id FROM staff WHERE role = 'owner' AND is_active LIMIT 1`)
  const dish = await plainDish()

  const { sessionId, seatId, seat2Id } = await makeSession()
  const corkage = { customName: 'Corkage', pricePaisa: 150_000, quantity: 2, seatSlotId: seatId }

  // 1 — owner, custom only
  const submissionId = crypto.randomUUID()
  const first = await send(owner, sessionId, [corkage], submissionId)
  check('1 owner sends a custom-only round → 201', first.status === 201,
    `${first.status} ${JSON.stringify(first.body?.error ?? '')}`)
  const [event] = await sql(
    `SELECT menu_item_id, custom_name, unit_price_paisa, quantity, staff_id FROM order_events
      WHERE session_id = $1 AND custom_name IS NOT NULL`,
    [sessionId],
  )
  check('1 one ITEM_ADDED row: no menu item, the name, the price, the owner',
    event?.menu_item_id === null && event?.custom_name === 'Corkage' &&
      event?.unit_price_paisa === 150_000 && event?.quantity === 2 && event?.staff_id === ownerRow.id,
    JSON.stringify(event))
  check('1 and NO print job', (await count(
    `SELECT count(*)::int AS n FROM print_jobs WHERE round_id = $1`, [submissionId])) === 0)

  // 6 — replay
  const replay = await send(owner, sessionId, [corkage], submissionId)
  check('6 a replay is 200 replayed and writes nothing',
    replay.status === 200 && replay.body?.data?.replayed === true &&
      (await count(`SELECT count(*)::int AS n FROM order_events WHERE session_id = $1 AND custom_name IS NOT NULL`, [sessionId])) === 1,
    `${replay.status} ${replay.body?.data?.replayed}`)

  // 2 — mixed round
  const mixedId = crypto.randomUUID()
  const mixed = await send(owner, sessionId, [
    { menuItemId: dish.id, seatSlotId: seatId, quantity: 1, modifierText: '', quotedPricePaisa: dish.price_paisa },
    { customName: 'Broken glass', pricePaisa: 50_000, quantity: 1, seatSlotId: seatId },
  ], mixedId)
  const jobs = await sql(`SELECT ticket FROM print_jobs WHERE round_id = $1`, [mixedId])
  const ticketNames = jobs.flatMap((job: any) => job.ticket.lines.map((line: any) => line.name))
  check('2 a mixed round → 201, its tickets carry the dish only',
    mixed.status === 201 && jobs.length >= 1 && !ticketNames.includes('Broken glass'),
    `${mixed.status} ${JSON.stringify(ticketNames)}`)

  // 3 — waiter refused
  const before = await count(`SELECT count(*)::int AS n FROM order_events WHERE session_id = $1`, [sessionId])
  const refused = await send(waiter, sessionId, [{ ...corkage, customName: 'Waiter tries' }])
  check('3 a waiter\'s custom line → 403 CUSTOM_CHARGE_NOT_ALLOWED',
    refused.status === 403 && refused.body?.error?.code === 'CUSTOM_CHARGE_NOT_ALLOWED',
    `${refused.status} ${refused.body?.error?.code}`)
  check('3 and nothing was written',
    (await count(`SELECT count(*)::int AS n FROM order_events WHERE session_id = $1`, [sessionId])) === before)

  // 4 / 5 — bad bodies
  const bad = async (label: string, line: unknown) => {
    const response = await send(owner, sessionId, [line])
    check(`${label} → 400`, response.status === 400, `${response.status} ${response.body?.error?.code}`)
  }
  await bad('4 price 0', { ...corkage, pricePaisa: 0 })
  await bad('4 a negative price', { ...corkage, pricePaisa: -500 })
  await bad('4 over LKR 100,000', { ...corkage, pricePaisa: 10_000_001 })
  await bad('4 a fractional paisa', { ...corkage, pricePaisa: 100.5 })
  await bad('4 an empty name', { ...corkage, customName: '   ' })
  await bad('4 a 61-character name', { ...corkage, customName: 'x'.repeat(61) })
  await bad('4 a name of control characters only', { ...corkage, customName: '\u0007\u001b' })
  await bad('5 a line with BOTH a menu item and a custom name', {
    menuItemId: dish.id, seatSlotId: seatId, quantity: 1, modifierText: '',
    quotedPricePaisa: dish.price_paisa, customName: 'Sneaky',
  })

  // 8 — history names it
  const history = await api(owner, `/api/sessions/${sessionId}/orders`)
  const historyNames = (history.body?.data?.rounds ?? history.body?.data ?? [])
    .flatMap?.((round: any) => (round.items ?? []).map((item: any) => item.name)) ?? []
  check('8 round history names the custom charge',
    historyNames.includes('Corkage') && historyNames.includes('Broken glass'),
    JSON.stringify(historyNames))

  // 9 — unbilled → walkout
  const close = await api(owner, `/api/sessions/${sessionId}/close`, {
    method: 'POST', body: JSON.stringify({ reason: 'abandoned' }),
  })
  check('9 an unpaid custom charge stops a plain close (money is owed)', close.status !== 200 && close.status !== 201,
    `${close.status} ${close.body?.error?.code}`)

  // 11 — seat guard: bill seat 2, then a custom line on it
  const [seat2Event] = await sql(
    `INSERT INTO order_events (session_id, staff_id, custom_name, event_type, seat_slot_id, quantity, unit_price_paisa, round_number)
     VALUES ($1, $2, 'Seat two thing', 'ITEM_ADDED', $3, 1, 10000, 9) RETURNING id`,
    [sessionId, ownerRow.id, seat2Id],
  )
  // Per-seat bills have their own endpoint (Story 6.4), as verify-bills uses.
  const seatBill = await api(owner, `/api/sessions/${sessionId}/seats/${seat2Id}/bill`, {
    method: 'POST', body: '{}',
  })
  if (seatBill.body?.data?.billId) mine.bills.push(seatBill.body.data.billId)
  const onBilledSeat = await send(owner, sessionId, [{ ...corkage, seatSlotId: seat2Id }])
  check('11 a custom line on an already-billed seat → SEAT_ALREADY_BILLED',
    seatBill.status === 201 && onBilledSeat.body?.error?.code === 'SEAT_ALREADY_BILLED',
    `${seatBill.status} ${JSON.stringify(seatBill.body?.error ?? '')} / ${onBilledSeat.status} ${onBilledSeat.body?.error?.code}`)
  void seat2Event

  // 7 — consolidated bill
  const bill = await api(owner, `/api/sessions/${sessionId}/bills`, {
    method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
  })
  if (bill.body?.data?.billId) mine.bills.push(bill.body.data.billId)
  const [line] = await sql(
    `SELECT bl.name, bl.amount_paisa, bl.quantity FROM bill_lines bl
       JOIN order_events e ON e.id = bl.order_event_id
      WHERE bl.bill_id = $1 AND e.custom_name = 'Corkage'`,
    [bill.body?.data?.billId ?? '00000000-0000-0000-0000-000000000000'],
  )
  check('7 the consolidated bill carries it by name at price × quantity',
    bill.status === 201 && line?.name === 'Corkage' && line?.amount_paisa === 300_000 && line?.quantity === 2,
    `${bill.status} ${JSON.stringify(bill.body?.error ?? '')} ${JSON.stringify(line)}`)
  const subtotal = bill.body?.data?.subtotalPaisa
  check('7 the bill subtotal includes it', typeof subtotal === 'number' && subtotal >= 300_000 + 50_000,
    String(subtotal))

  // 10 — the CHECK
  const neither = await sql(
    `INSERT INTO order_events (session_id, staff_id, event_type, quantity, unit_price_paisa)
     VALUES ($1, $2, 'ITEM_ADDED', 1, 100) RETURNING id`, [sessionId, ownerRow.id],
  ).then(() => false, () => true)
  const both = await sql(
    `INSERT INTO order_events (session_id, staff_id, menu_item_id, custom_name, event_type, quantity, unit_price_paisa)
     VALUES ($1, $2, $3, 'Both', 'ITEM_ADDED', 1, 100) RETURNING id`, [sessionId, ownerRow.id, dish.id],
  ).then(() => false, () => true)
  check('10 the database refuses an item line with neither or both name sources', neither && both,
    `neither refused: ${neither}, both refused: ${both}`)
}

async function cleanup() {
  const GUARDED = [
    ['order_rounds', 'immutable_order_rounds'],
    ['bill_lines', 'immutable_bill_lines'],
    ['bills', 'immutable_bills'],
    ['order_events', 'immutable_order_events'],
  ] as const
  try {
    for (const [table, trigger] of GUARDED) await sql(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
    if (mine.bills.length) {
      await sql(`DELETE FROM bill_lines WHERE bill_id = ANY($1::uuid[])`, [mine.bills])
      await sql(`DELETE FROM bills WHERE id = ANY($1::uuid[])`, [mine.bills])
    }
    if (mine.sessions.length) {
      await sql(`DELETE FROM print_jobs WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
      await sql(`DELETE FROM order_rounds WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
      await sql(`DELETE FROM order_events WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
    }
  } finally {
    for (const [table, trigger] of GUARDED) {
      try {
        await sql(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
      } catch (error) {
        console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error)
      }
    }
  }
  for (const pair of mine.sessionTables) {
    const [sid, tid] = pair.split('|')
    await sql(`DELETE FROM order_session_tables WHERE session_id = $1 AND table_id = $2`, [sid, tid])
  }
  if (mine.seats.length) await sql(`DELETE FROM seat_slots WHERE id = ANY($1::uuid[])`, [mine.seats])
  if (mine.sessions.length) await sql(`DELETE FROM order_sessions WHERE id = ANY($1::uuid[])`, [mine.sessions])
}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
