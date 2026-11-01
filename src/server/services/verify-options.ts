/* eslint-disable @typescript-eslint/no-explicit-any -- This script reads
   arbitrary API JSON and asserts on its shape, as verify-bills.ts does.
   Nothing here is imported by the app. */
/**
 * Story 4.8 — priced options, verified against the running server and
 * database. The story's 13-case matrix, plus 14: countable options.
 *
 *   pnpm exec tsx --env-file=.env <this file>
 *
 * The DEV SERVER MUST BE RUNNING (pnpm dev): the sends go through the real
 * route, so validation, pricing and the snapshot are exercised end to end.
 *
 * Its dishes live in an INACTIVE category, so no live tablet ever shows them,
 * and it deletes exactly the ids it created.
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

// ── Cleanup registry ─────────────────────────────────────────────────────────
const mine = {
  bills: [] as string[],
  seats: [] as string[],
  sessionTables: [] as string[],
  sessions: [] as string[],
  options: [] as string[],
  groups: [] as string[],
  items: [] as string[],
  categories: [] as string[],
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
async function tenantId(): Promise<string> {
  const [row] = await sql(`SELECT id FROM tenants LIMIT 1`)
  return row.id
}

async function makeItem(categoryId: string, name: string, pricePaisa: number): Promise<string> {
  const [item] = await sql(
    `INSERT INTO menu_items (tenant_id, category_id, name, price_paisa, production_destination)
     VALUES ($1, $2, $3, $4, 'bar') RETURNING id`,
    [await tenantId(), categoryId, name, pricePaisa],
  )
  mine.items.push(item.id)
  return item.id
}

async function makeGroup(
  itemId: string,
  name: string,
  selection: 'single' | 'multi',
  required: boolean,
  options: { name: string; delta: number; isDefault?: boolean; available?: boolean; maxCount?: number }[],
): Promise<{ id: string; options: Record<string, string> }> {
  const tid = await tenantId()
  const [group] = await sql(
    `INSERT INTO modifier_groups (tenant_id, menu_item_id, name, selection, is_required)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tid, itemId, name, selection, required],
  )
  mine.groups.push(group.id)
  const ids: Record<string, string> = {}
  for (const [index, option] of options.entries()) {
    const [row] = await sql(
      `INSERT INTO modifier_options
         (tenant_id, group_id, name, price_delta_paisa, is_default, is_available, display_order, max_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [tid, group.id, option.name, option.delta, option.isDefault ?? false, option.available ?? true, index, option.maxCount ?? 1],
    )
    mine.options.push(row.id)
    ids[option.name] = row.id
  }
  return { id: group.id, options: ids }
}

/** A table session with one seat on a free table. */
async function makeSession(): Promise<{ sessionId: string; seatId: string }> {
  const tid = await tenantId()
  const [waiter] = await sql(`SELECT id FROM staff WHERE role = 'waiter' AND is_active LIMIT 1`)
  const [session] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id) VALUES ($1, 'table', $2) RETURNING id`,
    [tid, waiter.id],
  )
  mine.sessions.push(session.id)
  const [seat] = await sql(
    `INSERT INTO seat_slots (session_id, seat_label) VALUES ($1, 'S1') RETURNING id`,
    [session.id],
  )
  mine.seats.push(seat.id)
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
  return { sessionId: session.id, seatId: seat.id }
}

type Line = { menuItemId: string; optionIds?: string[]; quotedPricePaisa: number; quantity?: number }

async function send(
  cookie: string,
  sessionId: string,
  seatId: string,
  lines: Line[],
  submissionId: string = crypto.randomUUID(),
): Promise<Json> {
  return api(cookie, `/api/sessions/${sessionId}/orders`, {
    method: 'POST',
    body: JSON.stringify({
      submissionId,
      lines: lines.map((line) => ({
        menuItemId: line.menuItemId,
        seatSlotId: seatId,
        quantity: line.quantity ?? 1,
        modifierText: '',
        quotedPricePaisa: line.quotedPricePaisa,
        ...(line.optionIds ? { optionIds: line.optionIds } : {}),
      })),
    }),
  })
}

const eventCount = async (sessionId: string) =>
  (await sql(`SELECT count(*)::int AS n FROM order_events WHERE session_id = $1`, [sessionId]))[0].n

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
  const waiter = await login('1234')

  const [category] = await sql(
    `INSERT INTO menu_categories (tenant_id, name, display_order, is_active)
     VALUES ($1, $2, 999, false) RETURNING id`,
    [await tenantId(), `verify-options ${crypto.randomUUID().slice(0, 8)}`],
  )
  mine.categories.push(category.id)

  // A LKR 2,500 cocktail: Alcohol (required) and Ice (optional, any).
  const mojito = await makeItem(category.id, 'VO Mojito', 250_000)
  const alcohol = await makeGroup(mojito, 'Alcohol', 'single', true, [
    { name: 'No alcohol', delta: -100_000 },
    { name: 'Single', delta: 0, isDefault: true },
    { name: 'Double shot', delta: 100_000 },
    { name: 'Triple', delta: 200_000, available: false },
  ])
  const shots = await makeGroup(mojito, 'Extra shots', 'multi', false, [
    { name: 'Extra shot', delta: 100_000, maxCount: 4 },
  ])
  const ice = await makeGroup(mojito, 'Ice', 'multi', false, [
    { name: 'No ice', delta: 0 },
    { name: 'Crushed', delta: 5_000 },
  ])
  // Another dish's option, for the "not this dish's" case.
  const coffee = await makeItem(category.id, 'VO Coffee', 90_000)
  const extras = await makeGroup(coffee, 'Extras', 'multi', false, [{ name: 'Oat milk', delta: 25_000 }])
  // LKR 500 with a −LKR 1,000 option: the unit price must stop at zero.
  const cheap = await makeItem(category.id, 'VO Cheap', 50_000)
  const cheapGroup = await makeGroup(cheap, 'Alcohol', 'single', false, [
    { name: 'No alcohol', delta: -100_000 },
  ])
  const plain = await makeItem(category.id, 'VO Plain', 70_000)

  const { sessionId, seatId } = await makeSession()
  const double = alcohol.options['Double shot']!
  const noIce = ice.options['No ice']!

  // 1 — correct quote with options
  const first = await send(waiter, sessionId, seatId, [
    { menuItemId: mojito, optionIds: [double, noIce], quotedPricePaisa: 350_000 },
  ])
  check('1 correct quote with options → 201', first.status === 201, `${first.status} ${JSON.stringify(first.body?.error ?? '')}`)
  const [event] = await sql(
    `SELECT unit_price_paisa, options FROM order_events WHERE session_id = $1 AND menu_item_id = $2`,
    [sessionId, mojito],
  )
  check('1 unit price is base + deltas', event?.unit_price_paisa === 350_000, String(event?.unit_price_paisa))
  check('1 the options are snapshotted with names and deltas',
    Array.isArray(event?.options) &&
      event.options.length === 2 &&
      event.options.some((o: any) => o.optionId === double && o.name === 'Double shot' && o.group === 'Alcohol' && o.priceDeltaPaisa === 100_000) &&
      event.options.some((o: any) => o.optionId === noIce && o.name === 'No ice'),
    JSON.stringify(event?.options))

  // 2 — wrong quote
  const before = await eventCount(sessionId)
  const wrong = await send(waiter, sessionId, seatId, [
    { menuItemId: plain, quotedPricePaisa: 70_000 },
    { menuItemId: mojito, optionIds: [double], quotedPricePaisa: 250_000 },
  ])
  check('2 a quote without the options\' deltas → 409 PRICE_CHANGED',
    wrong.status === 409 && wrong.body?.error?.code === 'PRICE_CHANGED', `${wrong.status} ${wrong.body?.error?.code}`)
  check('2 it carries the computed UNIT price and the line',
    wrong.body?.error?.currentPricePaisa === 350_000 && wrong.body?.error?.lineIndex === 1,
    JSON.stringify(wrong.body?.error))

  // 3–7 — invalid selections
  const invalid = async (label: string, optionIds: string[], reason: string, quote: number) => {
    const response = await send(waiter, sessionId, seatId, [
      { menuItemId: mojito, optionIds, quotedPricePaisa: quote },
    ])
    check(`${label} → 422 OPTION_INVALID (${reason})`,
      response.status === 422 &&
        response.body?.error?.code === 'OPTION_INVALID' &&
        response.body?.error?.reason === reason &&
        response.body?.error?.lineIndex === 0 &&
        response.body?.error?.itemId === mojito,
      `${response.status} ${JSON.stringify(response.body?.error)}`)
  }
  // `unknown` covers another dish's option: it is not an option of THIS dish,
  // which is the same refusal as a retired or made-up id.
  await invalid('3 another dish\'s option', [alcohol.options['Single']!, extras.options['Oat milk']!], 'unknown', 275_000)
  await invalid('4 two options in a single group', [alcohol.options['Single']!, double], 'too-many', 350_000)
  await invalid('5 a required group left empty', [noIce], 'required', 250_000)
  await invalid('6 an unavailable option', [alcohol.options['Triple']!], 'unavailable', 450_000)
  await invalid('7 the same option twice', [double, double], 'duplicate', 450_000)
  check('2–7 refusals wrote nothing', (await eventCount(sessionId)) === before)

  // 8 — clamp at zero
  const clamped = await send(waiter, sessionId, seatId, [
    { menuItemId: cheap, optionIds: [cheapGroup.options['No alcohol']!], quotedPricePaisa: 0 },
  ])
  const [cheapEvent] = await sql(
    `SELECT unit_price_paisa FROM order_events WHERE session_id = $1 AND menu_item_id = $2`,
    [sessionId, cheap],
  )
  check('8 deltas below zero clamp the unit to 0, accepted at quote 0',
    clamped.status === 201 && cheapEvent?.unit_price_paisa === 0,
    `${clamped.status} ${cheapEvent?.unit_price_paisa}`)

  // 12 — an old tablet's body: no optionIds, dish with no groups
  const legacy = await send(waiter, sessionId, seatId, [{ menuItemId: plain, quotedPricePaisa: 70_000 }])
  const [plainEvent] = await sql(
    `SELECT options FROM order_events WHERE session_id = $1 AND menu_item_id = $2`,
    [sessionId, plain],
  )
  check('12 a body without optionIds on a dish with none → 201, options NULL',
    legacy.status === 201 && plainEvent?.options === null, `${legacy.status} ${JSON.stringify(plainEvent?.options)}`)

  // 13 — replay
  const replayId = crypto.randomUUID()
  const once = await send(waiter, sessionId, seatId, [
    { menuItemId: mojito, optionIds: [alcohol.options['Single']!], quotedPricePaisa: 250_000 },
  ], replayId)
  const afterOnce = await eventCount(sessionId)
  const twice = await send(waiter, sessionId, seatId, [
    { menuItemId: mojito, optionIds: [alcohol.options['Single']!], quotedPricePaisa: 250_000 },
  ], replayId)
  check('13 a replay is 200 replayed and writes nothing',
    once.status === 201 && twice.status === 200 && twice.body?.data?.replayed === true &&
      (await eventCount(sessionId)) === afterOnce,
    `${once.status} ${twice.status} ${twice.body?.data?.replayed}`)

  // 10 — the ticket
  const [job] = await sql(
    `SELECT ticket FROM print_jobs WHERE round_id = $1`,
    [first.body?.data?.submissionId],
  )
  const ticketLine = job?.ticket?.lines?.[0]
  check('10 the bar ticket carries the option names in menu order',
    JSON.stringify(ticketLine?.options) === JSON.stringify(['Double shot', 'No ice']),
    JSON.stringify(ticketLine?.options))

  // 14 — countable options (Teran, 2026-11-01): "more than two shots"
  const extra = shots.options['Extra shot']!
  const threeExtra = await send(waiter, sessionId, seatId, [
    { menuItemId: mojito, optionIds: [double, extra, extra, extra], quotedPricePaisa: 650_000 },
  ])
  check('14 Double + 3 extra shots → 201 at base + 1,000 + 3 × 1,000',
    threeExtra.status === 201, `${threeExtra.status} ${JSON.stringify(threeExtra.body?.error ?? '')}`)
  const [counted] = await sql(
    `SELECT unit_price_paisa, options FROM order_events WHERE session_id = $1 AND unit_price_paisa = 650000`,
    [sessionId],
  )
  check('14 the snapshot stores the option ONCE with its count',
    counted?.options?.filter((o: any) => o.optionId === extra).length === 1 &&
      counted?.options?.find((o: any) => o.optionId === extra)?.count === 3,
    JSON.stringify(counted?.options))
  const [countedJob] = await sql(`SELECT ticket FROM print_jobs WHERE round_id = $1`, [
    threeExtra.body?.data?.submissionId,
  ])
  check('14 the ticket prints "Extra shot ×3" on one line',
    JSON.stringify(countedJob?.ticket?.lines?.[0]?.options) === JSON.stringify(['Double shot', 'Extra shot ×3']),
    JSON.stringify(countedJob?.ticket?.lines?.[0]?.options))
  const fiveExtra = await send(waiter, sessionId, seatId, [
    { menuItemId: mojito, optionIds: [alcohol.options['Single']!, extra, extra, extra, extra, extra], quotedPricePaisa: 750_000 },
  ])
  check('14 a fifth extra shot over the limit of 4 → 422 duplicate',
    fiveExtra.status === 422 && fiveExtra.body?.error?.reason === 'duplicate',
    `${fiveExtra.status} ${fiveExtra.body?.error?.reason}`)
  const underQuoted = await send(waiter, sessionId, seatId, [
    { menuItemId: mojito, optionIds: [alcohol.options['Single']!, extra, extra], quotedPricePaisa: 350_000 },
  ])
  check('14 a quote that counts one shot, not two → 409 with the counted price',
    underQuoted.status === 409 && underQuoted.body?.error?.currentPricePaisa === 450_000,
    `${underQuoted.status} ${underQuoted.body?.error?.currentPricePaisa}`)

  // 9 / 11 — re-price and rename AFTER the send, then bill
  await sql(`UPDATE modifier_options SET price_delta_paisa = 300000, name = 'Double (renamed)' WHERE id = $1`, [double])
  const [unchanged] = await sql(
    `SELECT unit_price_paisa, options FROM order_events WHERE session_id = $1 AND menu_item_id = $2 ORDER BY created_at LIMIT 1`,
    [sessionId, mojito],
  )
  check('9 a re-priced option does not move the sent event',
    unchanged?.unit_price_paisa === 350_000 && unchanged?.options?.[0]?.name === 'Double shot',
    JSON.stringify(unchanged))

  const bill = await api(waiter, `/api/sessions/${sessionId}/bills`, {
    method: 'POST',
    body: JSON.stringify({ type: 'consolidated' }),
  })
  if (bill.body?.data?.billId) mine.bills.push(bill.body.data.billId)
  check('9 the bill is created', bill.status === 201, `${bill.status} ${JSON.stringify(bill.body?.error ?? '')}`)
  const [countedLine] = await sql(
    `SELECT bl.option_text FROM bill_lines bl
       JOIN order_events e ON e.id = bl.order_event_id
      WHERE bl.bill_id = $1 AND e.unit_price_paisa = 650000`,
    [bill.body?.data?.billId ?? '00000000-0000-0000-0000-000000000000'],
  )
  check('14 the bill line reads "Double shot, Extra shot ×3"',
    countedLine?.option_text === 'Double shot, Extra shot ×3', String(countedLine?.option_text))
  const [billLine] = await sql(
    `SELECT bl.amount_paisa, bl.option_text FROM bill_lines bl
       JOIN order_events e ON e.id = bl.order_event_id
      WHERE bl.bill_id = $1 AND e.unit_price_paisa = 350000`,
    [bill.body?.data?.billId ?? '00000000-0000-0000-0000-000000000000'],
  )
  check('9 the bill charges the price as SENT, not the new one',
    billLine?.amount_paisa === 350_000, String(billLine?.amount_paisa))
  check('11 bill_lines.option_text snapshots the options as sent',
    billLine?.option_text === 'Double shot, No ice', String(billLine?.option_text))

  const detail = await api(waiter, `/api/bills/${bill.body?.data?.billId}`)
  const detailLine = detail.body?.data?.lines?.find((line: any) => line.unitPricePaisa === 350_000)
  check('11 GET bill returns the option text after the rename',
    detailLine?.optionText === 'Double shot, No ice', JSON.stringify(detailLine?.optionText))
  const postedLine = bill.body?.data?.lines?.find((line: any) => line.unitPricePaisa === 350_000)
  check('11 POST bill returns it too', postedLine?.optionText === 'Double shot, No ice',
    JSON.stringify(postedLine?.optionText))
}

async function cleanup() {
  // `DISABLE TRIGGER` is a persistent catalog change — always re-enabled in
  // `finally`, as verify-bills.ts explains.
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
  if (mine.options.length) await sql(`DELETE FROM modifier_options WHERE id = ANY($1::uuid[])`, [mine.options])
  if (mine.groups.length) await sql(`DELETE FROM modifier_groups WHERE id = ANY($1::uuid[])`, [mine.groups])
  if (mine.items.length) await sql(`DELETE FROM menu_items WHERE id = ANY($1::uuid[])`, [mine.items])
  if (mine.categories.length) await sql(`DELETE FROM menu_categories WHERE id = ANY($1::uuid[])`, [mine.categories])
}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
