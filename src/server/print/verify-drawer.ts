/**
 * Story 6.7 — the cash drawer, from the kick bytes to the audit rows.
 *
 *   pnpm exec tsx --conditions=react-server --env-file=.env src/server/print/verify-drawer.ts
 *   pnpm exec tsx --conditions=react-server --env-file=.env src/server/print/verify-drawer.ts --worker
 *
 * Part 1 is pure: the bytes. Part 2 goes through the real routes, so THE DEV
 * SERVER MUST BE RUNNING (`pnpm dev`, ideally with `PRINTER_USB_NAME=` empty so
 * the real drawer does not spring open). Part 3 (`--worker`) drains a kick and
 * a receipt through the worker with fake transports — dev server STOPPED.
 * `--conditions=react-server` lets the service (`server-only`) be imported.
 *
 * Every row it makes is its own; the append-only guards are switched off only
 * around its own cleanup, only on a local database, and always switched back.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- reads arbitrary API JSON; nothing here is imported by the app. */
import { Pool } from 'pg'
import { buildDrawerKick, buildPrintBytes, buildReceipt, buildTicket } from './escpos'
import { renderTicketText } from './transport'
import type { DrawerKickPayload, ReceiptPayload, TicketPayload } from '@/types/tickets'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const kick: DrawerKickPayload = { kind: 'drawer', destination: 'cashier', tableLabels: ['Cash drawer'], opening: 'sale' }

// ── Part 1: the bytes ────────────────────────────────────────────────────────

function part1() {
  console.log('\n── Part 1: the bytes ──')
  const hex = (bytes: Buffer) => bytes.toString('hex')
  check('pin 2 by default: 1B 40 1B 70 00 19 FA', hex(buildDrawerKick(undefined)) === '1b401b700019fa', hex(buildDrawerKick(undefined)))
  check('CASH_DRAWER_PIN=5: 1B 40 1B 70 01 19 FA', hex(buildDrawerKick('5')) === '1b401b700119fa')
  check('anything else is pin 2', hex(buildDrawerKick('7')) === '1b401b700019fa')
  const saved = process.env.CASH_DRAWER_PIN
  process.env.CASH_DRAWER_PIN = '5'
  check('a drawer job prints as the kick, pin read at delivery', hex(buildPrintBytes(kick)) === '1b401b700119fa')
  if (saved === undefined) delete process.env.CASH_DRAWER_PIN
  else process.env.CASH_DRAWER_PIN = saved
  check('no paper moves: no cut, no line feed', !buildPrintBytes(kick).includes(0x0a) && !buildPrintBytes(kick).includes(0x56))
  check('the log names it', renderTicketText(kick) === 'CASH DRAWER (sale)' &&
    renderTicketText({ ...kick, opening: 'no_sale' }) === 'CASH DRAWER (no sale)')

  // Old jobs: a ticket with no kind and a receipt print as they always did.
  const ticket = {
    destination: 'kitchen', roundNumber: 2, tableLabels: ['Table 5'], usesSeats: false,
    submittedAt: '2026-11-02T14:12:00Z', timeZone: 'Asia/Colombo',
    lines: [{ eventId: 'e', quantity: 1, name: 'Fried Rice', modifierText: null, seatLabel: 'Seat 1', seatNote: null }],
  } as TicketPayload
  check('a stored ticket prints the same bytes', buildPrintBytes(ticket).equals(buildTicket(ticket)))
  const receipt = {
    kind: 'receipt', destination: 'cashier', title: 'BILL', copy: false, restaurantName: 'Carpe Diem', headerLines: [],
    footerLines: [], tableLabels: ['Table 7'], billLabel: null, printedAt: '2026-11-02T14:12:00Z', dailyNumber: 1,
    businessDate: '2026-11-02', lines: [], comps: [], subtotalPaisa: 0, serviceChargePaisa: 0, serviceChargeBp: 0,
    taxPaisa: 0, taxBp: 0, totalPaisa: 0, tenders: [],
  } as ReceiptPayload
  check('a stored receipt prints the same bytes', buildPrintBytes(receipt).equals(buildReceipt(receipt)))
}

// ── Shared: database, logins ─────────────────────────────────────────────────

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows
/** Every session and no-sale job this run makes; cleanup deletes these and nothing else. */
const mine = { sessions: [] as string[], jobs: [] as string[] }

const GUARDS = [
  ['cash_drawer_openings', 'immutable_cash_drawer_openings'],
  ['payment_records', 'immutable_payment_records'],
  ['bill_lines', 'immutable_bill_lines'],
  ['bills', 'immutable_bills'],
  ['order_events', 'immutable_order_events'],
] as const

async function prepareDatabase() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL ?? '').hostname
    } catch {
      return ''
    }
  })()
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) && process.env.VERIFY_ALLOW_REMOTE_DB !== '1') {
    throw new Error(`verify-drawer disables append-only triggers; DATABASE_URL host "${host}" is not local.`)
  }
  for (const [table, trigger] of GUARDS) await sql(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
}

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

async function api(cookie: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as any }
}

/** A bar tab with one LKR 1,000 item, billed; returns the bill. */
async function billedTab(cookie: string) {
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const [waiter] = await sql(`SELECT id FROM staff WHERE role = 'waiter' AND is_active LIMIT 1`)
  const [item] = await sql(`SELECT id FROM menu_items LIMIT 1`)
  const [session] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, tab_label) VALUES ($1, 'counter', $2, 'Drawer test') RETURNING id`,
    [tenant.id, waiter.id],
  )
  mine.sessions.push(session.id)
  await sql(
    `INSERT INTO order_events (session_id, staff_id, menu_item_id, event_type, quantity, unit_price_paisa, round_number)
     VALUES ($1, $2, $3, 'ITEM_ADDED', 1, 100000, 1)`,
    [session.id, waiter.id, item.id],
  )
  const bill = await api(cookie, `/api/sessions/${session.id}/bills`, { type: 'consolidated' })
  if (bill.status !== 201) throw new Error(`setup: bill ${bill.status} ${JSON.stringify(bill.body)}`)
  return { sessionId: session.id as string, billId: bill.body.data.billId as string, totalPaisa: bill.body.data.totalPaisa as number }
}

const openingsFor = (sessionId: string) =>
  sql(
    `SELECT o.kind::text, o.payment_record_id, o.print_job_id, p.method::text AS method
       FROM cash_drawer_openings o LEFT JOIN payment_records p ON p.id = o.payment_record_id
      WHERE o.print_job_id IN (SELECT id FROM print_jobs WHERE session_id = $1)`,
    [sessionId],
  )
const kicksFor = (sessionId: string) =>
  sql(`SELECT id, created_at FROM print_jobs WHERE session_id = $1 AND ticket->>'kind' = 'drawer' ORDER BY created_at`, [sessionId])

// ── Part 2: through the routes ───────────────────────────────────────────────

async function part2() {
  console.log('\n── Part 2: the routes ──')
  await prepareDatabase()
  const owner = await login('5678')
  const waiter = await login('1234')

  // Case 2 + 5: cash that settles the bill — one kick, one row, before the receipt.
  const cash = await billedTab(owner)
  const paid = await api(owner, `/api/bills/${cash.billId}/payments`, {
    tenders: [{ method: 'cash', amountPaisa: cash.totalPaisa }],
    cashReceivedPaisa: cash.totalPaisa,
  })
  check('setup: paid in cash', paid.status === 201, JSON.stringify(paid.body))
  const cashKicks = await kicksFor(cash.sessionId)
  const cashRows = await openingsFor(cash.sessionId)
  check('a cash payment queues one kick', cashKicks.length === 1 && paid.body?.data?.drawerJobId === cashKicks[0]?.id)
  check('and records one sale opening, pointing at the cash payment',
    cashRows.length === 1 && cashRows[0].kind === 'sale' && cashRows[0].method === 'cash', JSON.stringify(cashRows))
  const [receiptJob] = await sql(`SELECT created_at FROM print_jobs WHERE id = $1`, [paid.body?.data?.receiptJobId])
  check('the kick is queued before the receipt',
    !!receiptJob && cashKicks[0]!.created_at.getTime() < receiptJob.created_at.getTime())
  const [kickJob] = await sql(`SELECT destination::text, bill_id, ticket FROM print_jobs WHERE id = $1`, [cashKicks[0]!.id])
  check('to the cashier printer, with no bill', kickJob.destination === 'cashier' && kickJob.bill_id === null &&
    kickJob.ticket.kind === 'drawer' && kickJob.ticket.tableLabels.join() === 'Cash drawer')

  // Case 3: card only — nothing.
  const card = await billedTab(owner)
  const cardPaid = await api(owner, `/api/bills/${card.billId}/payments`, { tenders: [{ method: 'card', amountPaisa: card.totalPaisa }] })
  check('a card-only payment opens nothing',
    cardPaid.status === 201 && cardPaid.body?.data?.drawerJobId === null &&
      (await kicksFor(card.sessionId)).length === 0 && (await openingsFor(card.sessionId)).length === 0)

  // Bank transfer (Teran, 2026-11-13): recorded as `transfer`, settles the bill, opens nothing,
  // and the receipt names it "Bank transfer".
  const transfer = await billedTab(owner)
  const transferPaid = await api(owner, `/api/bills/${transfer.billId}/payments`, {
    tenders: [{ method: 'transfer', amountPaisa: transfer.totalPaisa }],
  })
  const [transferRow] = await sql(`SELECT method::text, amount_paisa FROM payment_records WHERE bill_id = $1`, [transfer.billId])
  check('a bank transfer is accepted and recorded as transfer, for the whole bill',
    transferPaid.status === 201 && transferRow?.method === 'transfer' && transferRow?.amount_paisa === transfer.totalPaisa,
    JSON.stringify({ status: transferPaid.status, body: transferPaid.body, transferRow }))
  check('a bank transfer opens nothing',
    transferPaid.body?.data?.drawerJobId === null && (await kicksFor(transfer.sessionId)).length === 0 &&
      (await openingsFor(transfer.sessionId)).length === 0)
  const [transferReceipt] = await sql(`SELECT ticket FROM print_jobs WHERE id = $1`, [transferPaid.body?.data?.receiptJobId])
  check('its receipt prints "Bank transfer"',
    !transferPaid.body?.data?.receiptJobId ||
      buildReceipt(transferReceipt.ticket as ReceiptPayload).toString('latin1').includes('Bank transfer'))

  // "No receipt" (Teran, 2026-11-13): paid, the drawer still opens for cash, no receipt is queued.
  const quiet = await billedTab(owner)
  const quietPaid = await api(owner, `/api/bills/${quiet.billId}/payments`, {
    tenders: [{ method: 'cash', amountPaisa: quiet.totalPaisa }],
    cashReceivedPaisa: quiet.totalPaisa,
    printReceipt: false,
  })
  const quietReceipts = await sql(`SELECT 1 FROM print_jobs WHERE bill_id = $1 AND ticket->>'kind' = 'receipt'`, [quiet.billId])
  check('"No receipt": paid and settled, no receipt queued, skipped on purpose',
    quietPaid.status === 201 && quietPaid.body?.data?.settled === true && quietPaid.body?.data?.receiptJobId === null &&
      quietPaid.body?.data?.receiptSkipped === true && quietReceipts.length === 0, JSON.stringify(quietPaid.body))
  check('"No receipt" in cash still opens the drawer', (await kicksFor(quiet.sessionId)).length === 1)

  // Case 4: cash + card — one kick, at the cash row.
  const mixed = await billedTab(owner)
  const mixedPaid = await api(owner, `/api/bills/${mixed.billId}/payments`, {
    tenders: [{ method: 'cash', amountPaisa: 40000 }, { method: 'card', amountPaisa: mixed.totalPaisa - 40000 }],
  })
  const mixedRows = await openingsFor(mixed.sessionId)
  check('cash + card: one kick, one row, at the cash part',
    mixedPaid.status === 201 && (await kicksFor(mixed.sessionId)).length === 1 && mixedRows.length === 1 && mixedRows[0].method === 'cash',
    JSON.stringify(mixedRows))

  // Case 6: owner no-sale.
  const change = await api(owner, '/api/cash-drawer/open', { reason: 'change' })
  check('the owner opens it for change (202)', change.status === 202 && typeof change.body?.data?.jobId === 'string', JSON.stringify(change.body))
  if (change.body?.data?.jobId) mine.jobs.push(change.body.data.jobId)
  const [noSaleJob] = await sql(`SELECT session_id, destination::text, ticket FROM print_jobs WHERE id = $1`, [change.body?.data?.jobId])
  check('a no-sale job belongs to no order', noSaleJob?.session_id === null && noSaleJob?.destination === 'cashier' &&
    noSaleJob?.ticket?.opening === 'no_sale')
  const [noSaleRow] = await sql(`SELECT kind::text, reason::text, note, payment_record_id FROM cash_drawer_openings WHERE print_job_id = $1`, [change.body?.data?.jobId])
  check('and records a no-sale with its reason', noSaleRow?.kind === 'no_sale' && noSaleRow?.reason === 'change' &&
    noSaleRow?.note === null && noSaleRow?.payment_record_id === null)

  const other = await api(owner, '/api/cash-drawer/open', { reason: 'other', note: '  Supplier paid in cash  ' })
  if (other.body?.data?.jobId) mine.jobs.push(other.body.data.jobId)
  const [otherRow] = await sql(`SELECT note FROM cash_drawer_openings WHERE print_job_id = $1`, [other.body?.data?.jobId])
  check('Other with a note is recorded, trimmed', other.status === 202 && otherRow?.note === 'Supplier paid in cash')

  // Case 7 + 8: refused, nothing written.
  const before = (await sql(`SELECT count(*)::int n FROM cash_drawer_openings`))[0].n
  const noNote = await api(owner, '/api/cash-drawer/open', { reason: 'other', note: '   ' })
  check('Other with no note is refused (400)', noNote.status === 400, String(noNote.status))
  const unknown = await api(owner, '/api/cash-drawer/open', { reason: 'birthday' })
  check('an unknown reason is refused (400)', unknown.status === 400)
  const tooLong = await api(owner, '/api/cash-drawer/open', { reason: 'other', note: 'x'.repeat(121) })
  check('a note over 120 characters is refused (400)', tooLong.status === 400)
  const byWaiter = await api(waiter, '/api/cash-drawer/open', { reason: 'change' })
  check('a waiter is refused (403)', byWaiter.status === 403, String(byWaiter.status))
  const after = (await sql(`SELECT count(*)::int n FROM cash_drawer_openings`))[0].n
  check('and nothing was written for any of them', after === before, `${before} -> ${after}`)

  // Case 9: append-only.
  const refused = async (statement: string) => {
    try {
      await sql(statement, [change.body?.data?.jobId])
      return false
    } catch (error) {
      return String(error).includes('immutable-table')
    }
  }
  check('UPDATE on an opening is refused', await refused(`UPDATE cash_drawer_openings SET note = 'x' WHERE print_job_id = $1`))
  check('DELETE on an opening is refused', await refused(`DELETE FROM cash_drawer_openings WHERE print_job_id = $1`))

  // The database's own rules, without the route in front.
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const [ownerRow] = await sql(`SELECT id FROM staff WHERE role = 'owner' LIMIT 1`)
  // One client, so BEGIN and ROLLBACK land on the same connection.
  const client = await pool.connect()
  const probe = async (statement: string, params: unknown[]) => {
    await client.query('BEGIN')
    try {
      await client.query(statement, params)
      return false
    } catch {
      return true
    } finally {
      await client.query('ROLLBACK')
    }
  }
  check('a kitchen job with no order is refused by the database',
    await probe(`INSERT INTO print_jobs (tenant_id, session_id, destination, round_id, ticket) VALUES ($1, NULL, 'kitchen', NULL, '{}')`, [tenant.id]))
  check('a no-sale with no reason is refused by the database',
    await probe(
      `WITH j AS (INSERT INTO print_jobs (tenant_id, destination, ticket) VALUES ($1, 'cashier', '{}') RETURNING id)
       INSERT INTO cash_drawer_openings (tenant_id, kind, print_job_id, staff_id) SELECT $1, 'no_sale', id, $2 FROM j`,
      [tenant.id, ownerRow.id],
    ))
  check('Other with an empty note is refused by the database',
    await probe(
      `WITH j AS (INSERT INTO print_jobs (tenant_id, destination, ticket) VALUES ($1, 'cashier', '{}') RETURNING id)
       INSERT INTO cash_drawer_openings (tenant_id, kind, reason, note, print_job_id, staff_id) SELECT $1, 'no_sale', 'other', '  ', id, $2 FROM j`,
      [tenant.id, ownerRow.id],
    ))
  client.release()

  // Case 10: the end-of-day read.
  const { listNoSaleOpenings } = await import('@/server/services/cash-drawer.service')
  const { db } = await import('@/server/db')
  const [{ today }] = await sql(`SELECT business_date_at($1, clock_timestamp())::text AS today`, [tenant.id])
  const listed = await listNoSaleOpenings(db, { tenantId: tenant.id, businessDate: today })
  const mineIds = new Set(
    (
      await sql(`SELECT id FROM cash_drawer_openings WHERE print_job_id = ANY($1::uuid[])`, [
        [change.body?.data?.jobId, other.body?.data?.jobId],
      ])
    ).map((row) => row.id as string),
  )
  const ours = listed.filter((row) => mineIds.has(row.id))
  check("today's list has both no-sales, with name, reason and note",
    ours.length === 2 &&
      ours.some((row) => row.reason === 'change' && row.staffName === 'Aruna') &&
      ours.some((row) => row.reason === 'other' && row.note === 'Supplier paid in cash'),
    JSON.stringify(ours))
  check('and no sale openings',
    (await sql(`SELECT count(*)::int n FROM cash_drawer_openings WHERE kind = 'sale' AND id = ANY($1::uuid[])`, [listed.map((row) => row.id)]))[0].n === 0)
  const yesterday = await listNoSaleOpenings(db, { tenantId: tenant.id, businessDate: '2000-01-01' })
  check('another day lists nothing of ours', !yesterday.some((row) => mineIds.has(row.id)))
  await (db as any).$client?.end?.().catch?.(() => {})
}

// ── Part 3: the worker (dev server STOPPED) ──────────────────────────────────

async function part3() {
  console.log('\n── Part 3: the worker ──')
  await prepareDatabase()
  const { drainPrintQueue } = await import('./worker')
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const seed = async (ticket: object) => {
    const [job] = await sql(
      `INSERT INTO print_jobs (tenant_id, destination, ticket) VALUES ($1, 'cashier', $2::jsonb) RETURNING id`,
      [tenant.id, JSON.stringify(ticket)],
    )
    mine.jobs.push(job.id)
    return job.id as string
  }
  // Case 11: kick then receipt, delivered in that order.
  await seed(kick)
  await seed({ kind: 'receipt', destination: 'cashier', tableLabels: ['T'], title: 'RECEIPT', lines: [], tenders: [] })
  const delivered: string[] = []
  await drainPrintQueue(() => ({
    name: 'fake',
    deliver: (payload) => {
      delivered.push('kind' in payload ? String(payload.kind) : 'ticket')
      return Promise.resolve()
    },
  }))
  check('the worker delivers the kick, then the receipt', delivered.join() === 'drawer,receipt', delivered.join())

  const failing = await seed(kick)
  const alerts: { kind: string; destination: string }[] = []
  ;(globalThis as { __io?: unknown }).__io = { emit: (_event: string, payload: any) => alerts.push(payload) }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await drainPrintQueue(() => ({ name: 'broken', deliver: () => Promise.reject(new Error('printer off')) }))
    await sql(`UPDATE print_jobs SET next_attempt_at = now() WHERE id = $1`, [failing])
  }
  const [row] = await sql(`SELECT status::text FROM print_jobs WHERE id = $1`, [failing])
  check('a failing kick retries, then dead-letters with a cashier alert',
    row.status === 'dead' && alerts.some((alert) => alert.kind === 'dead' && alert.destination === 'cashier'), row.status)
}

// ── Case 12: a kick that cannot be queued never costs the payment ────────────

async function part2Failure() {
  // Forced by a temporary trigger that refuses drawer rows, on this run's
  // session only — the savepoint must swallow it and keep the payment.
  const owner = await login('5678')
  const tab = await billedTab(owner)
  await sql(`
    CREATE OR REPLACE FUNCTION verify_drawer_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM print_jobs WHERE id = NEW.print_job_id AND session_id = '${tab.sessionId}') THEN
        RAISE EXCEPTION 'forced by verify-drawer';
      END IF;
      RETURN NEW;
    END $$`)
  await sql(`CREATE TRIGGER verify_drawer_refuse BEFORE INSERT ON cash_drawer_openings FOR EACH ROW EXECUTE FUNCTION verify_drawer_refuse()`)
  try {
    const paid = await api(owner, `/api/bills/${tab.billId}/payments`, {
      tenders: [{ method: 'cash', amountPaisa: tab.totalPaisa }],
    })
    const [{ n }] = await sql(`SELECT count(*)::int n FROM payment_records WHERE bill_id = $1`, [tab.billId])
    check('a kick that fails to queue: payment recorded, drawerJobId null, receipt still queued',
      paid.status === 201 && n === 1 && paid.body?.data?.drawerJobId === null && typeof paid.body?.data?.receiptJobId === 'string',
      JSON.stringify(paid.body?.data))
    check('and no stray kick job is left', (await kicksFor(tab.sessionId)).length === 0)
  } finally {
    await sql(`DROP TRIGGER IF EXISTS verify_drawer_refuse ON cash_drawer_openings`)
    await sql(`DROP FUNCTION IF EXISTS verify_drawer_refuse()`)
  }
}

async function cleanup() {
  if (mine.sessions.length === 0 && mine.jobs.length === 0) return
  try {
    for (const [table, trigger] of GUARDS) await sql(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
    await sql(
      `DELETE FROM cash_drawer_openings
        WHERE print_job_id = ANY($2::uuid[])
           OR print_job_id IN (SELECT id FROM print_jobs WHERE session_id = ANY($1::uuid[]))`,
      [mine.sessions, mine.jobs],
    )
    await sql(`DELETE FROM print_jobs WHERE id = ANY($2::uuid[]) OR session_id = ANY($1::uuid[])`, [mine.sessions, mine.jobs])
    await sql(`DELETE FROM payment_records WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
    await sql(`DELETE FROM bill_lines WHERE bill_id IN (SELECT id FROM bills WHERE session_id = ANY($1::uuid[]))`, [mine.sessions])
    await sql(`DELETE FROM bills WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
    await sql(`DELETE FROM order_events WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
  } finally {
    for (const [table, trigger] of GUARDS) {
      await sql(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`).catch((error) =>
        console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error),
      )
    }
  }
  await sql(`DELETE FROM seat_slots WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
  await sql(`DELETE FROM order_sessions WHERE id = ANY($1::uuid[])`, [mine.sessions])
}

async function main() {
  part1()
  try {
    if (process.argv.includes('--worker')) await part3()
    else if (!process.argv.includes('--bytes-only')) {
      await part2()
      await part2Failure()
    }
  } finally {
    await cleanup()
    await pool.end()
  }
}

main()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(() => {
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exitCode = results.every(Boolean) ? 0 : 1
  })
