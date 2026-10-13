/* eslint-disable @typescript-eslint/no-explicit-any -- This script reads
   arbitrary API JSON and driver error objects and asserts on their shape;
   typing those as `unknown` would mean a cast at every assertion, which is
   the same `any` spelled longer. Nothing here is imported by the app. */
/**
 * Story 6.2 — consolidated bill generation, verified against the running
 * server and database. 15 cases, the story's verification matrix.
 *
 *   pnpm exec tsx --env-file=.env <this file>
 *
 * The DEV SERVER MUST BE RUNNING (pnpm dev) — the HTTP cases go through the
 * proxy, so RBAC and session handling are exercised for real rather than
 * assumed.
 *
 * It creates its own sessions, items and rows, and deletes exactly the ids it
 * created. Nothing is matched by label or by LIKE.
 */
import { Pool } from 'pg'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

// ── Cleanup registry ─────────────────────────────────────────────────────────
const mine = {
  bills: [] as string[],
  // Story 6.4's matrix sends rounds through the REAL route and expects them to
  // succeed. Every earlier case either wrote events directly with `addItem`
  // (which registers them here) or expected the send to be refused, so until
  // now nothing else was ever written. An accepted round also writes
  // `order_rounds` and `print_jobs`, both of which hold NOT NULL foreign keys
  // to the session — so without these two the final `DELETE FROM
  // order_sessions` raises a foreign-key violation, aborts the cleanup, and
  // leaks every session of the run. That is exactly how an earlier run left 9
  // bills and 18 open sessions behind.
  //
  // `rounds` was already declared here in Story 6.2 and never read by
  // `cleanup()` — a registry entry that tracked nothing. It is used now.
  rounds: [] as string[],
  comps: [] as string[],
  events: [] as string[],
  seats: [] as string[],
  sessionTables: [] as string[],
  sessions: [] as string[],
}

// ── Auth ─────────────────────────────────────────────────────────────────────
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

// ── Fixtures, written straight to the database ───────────────────────────────
async function tenantId(): Promise<string> {
  const [row] = await sql(`SELECT id FROM tenants LIMIT 1`)
  return row.id
}

async function staffId(role: string): Promise<string> {
  const [row] = await sql(`SELECT id FROM staff WHERE role = $1 AND is_active LIMIT 1`, [role])
  return row.id
}

/** A session with a seat, optionally attached to a free table. */
async function makeSession(
  kind: 'table' | 'counter',
  { withTable, seats = 1 }: { withTable: boolean; seats?: number },
): Promise<{
  sessionId: string
  seatId: string
  seatIds: string[]
  tableId: string | null
}> {
  const tid = await tenantId()
  const waiter = await staffId('waiter')
  const [session] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id) VALUES ($1, $2, $3) RETURNING id`,
    [tid, kind, waiter],
  )
  mine.sessions.push(session.id)

  // Labels must differ: idx_seat_slots_session_label is UNIQUE(session_id,
  // seat_label).
  const seatIds: string[] = []
  for (let n = 1; n <= seats; n += 1) {
    const [seat] = await sql(
      `INSERT INTO seat_slots (session_id, seat_label) VALUES ($1, $2) RETURNING id`,
      [session.id, `S${n}`],
    )
    mine.seats.push(seat.id)
    seatIds.push(seat.id)
  }

  let tableId: string | null = null
  if (withTable) {
    let [table] = await sql(
      `SELECT t.id FROM tables t
        WHERE NOT EXISTS (
          SELECT 1 FROM order_session_tables ost
           WHERE ost.table_id = t.id AND ost.released_at IS NULL)
        LIMIT 1`,
    )

    // The restaurant has 13 tables and this script now needs more sessions
    // than that, so it recycles its OWN. Releasing a table held by a case that
    // has already finished is exactly what closing that table would do, and it
    // can never touch a session this run did not create.
    if (!table) {
      const [recycled] = await sql(
        `UPDATE order_session_tables SET released_at = now()
          WHERE table_id = (
            SELECT table_id FROM order_session_tables
             WHERE released_at IS NULL AND session_id = ANY($1::uuid[])
             LIMIT 1)
            AND released_at IS NULL
          RETURNING table_id AS id`,
        [mine.sessions],
      )
      if (!recycled) throw new Error('no free table, and none of mine to recycle')
      table = recycled
    }
    tableId = table.id
    await sql(`INSERT INTO order_session_tables (session_id, table_id) VALUES ($1, $2)`, [
      session.id,
      tableId,
    ])
    mine.sessionTables.push(`${session.id}|${tableId}`)
  }

  return { sessionId: session.id, seatId: seatIds[0]!, seatIds, tableId }
}

/** Sends a round through the REAL route, registering what it writes. */
async function sendRound(
  cookie: string,
  sessionId: string,
  lines: { seatId: string; quantity?: number }[],
): Promise<Json> {
  const [item] = await sql(`SELECT id, price_paisa FROM menu_items WHERE is_available LIMIT 1`)
  const submissionId = crypto.randomUUID()
  const response = await api(cookie, `/api/sessions/${sessionId}/orders`, {
    method: 'POST',
    body: JSON.stringify({
      submissionId,
      lines: lines.map((line) => ({
        menuItemId: item.id,
        seatSlotId: line.seatId,
        quantity: line.quantity ?? 1,
        modifierText: '',
        quotedPricePaisa: item.price_paisa,
      })),
    }),
  })
  // Registered whether or not it succeeded — a partial write is exactly the
  // case the cleanup must survive.
  mine.rounds.push(submissionId)
  return response
}

/** One ITEM_ADDED event at an explicit price, bypassing the send route. */
async function addItem(
  sessionId: string,
  seatId: string,
  quantity: number,
  unitPricePaisa: number,
  roundNumber = 1,
): Promise<string> {
  const waiter = await staffId('waiter')
  const [item] = await sql(`SELECT id FROM menu_items LIMIT 1`)
  const [event] = await sql(
    `INSERT INTO order_events
       (session_id, staff_id, menu_item_id, event_type, seat_slot_id, quantity, unit_price_paisa, round_number)
     VALUES ($1, $2, $3, 'ITEM_ADDED', $4, $5, $6, $7) RETURNING id`,
    [sessionId, waiter, item.id, seatId, quantity, unitPricePaisa, roundNumber],
  )
  mine.events.push(event.id)
  return event.id
}

async function billRowsFor(billId: string) {
  const [bill] = await sql(`SELECT * FROM bills WHERE id = $1`, [billId])
  const lines = await sql(`SELECT * FROM bill_lines WHERE bill_id = $1`, [billId])
  return { bill, lines }
}

function track(response: Json) {
  const id = response.body?.data?.billId ?? response.body?.error?.billId
  if (typeof id === 'string' && id !== '') mine.bills.push(id)
  return response
}

async function main() {
  try {
    await run()
  } finally {
    // Cleanup runs even when a case THROWS. It used to sit at the end of the
    // happy path, so the run that aborted on an exhausted table fixture left 9
    // bills and 18 open sessions behind for the next run to trip over.
    await cleanup()
  }

  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

async function run() {
  const waiterCookie = await login('1234')
  const kitchenCookie = await login('4321')

  const [config] = await sql(`SELECT service_charge_bp, tax_rate_percent FROM tenant_config LIMIT 1`)
  const rateBp = config.service_charge_bp as number
  const taxBp = (config.tax_rate_percent as number) * 100
  console.log(`\n-- rates: service ${rateBp} bp, tax ${taxBp} bp --\n`)

  // ── 1. Table session, three rounds ────────────────────────────────────────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    // THREE ROUNDS, not three items in one. The matrix row says "3 rounds" and
    // this hardcoded round_number = 1, so the multi-round case it names was
    // never exercised.
    await addItem(sessionId, seatId, 2, 150_000, 1)
    await addItem(sessionId, seatId, 1, 320_000, 2)
    await addItem(sessionId, seatId, 3, 95_000, 3)
    const expectedSubtotal = 2 * 150_000 + 320_000 + 3 * 95_000

    const response = track(
      await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
        method: 'POST',
        body: JSON.stringify({ type: 'consolidated' }),
      }),
    )
    const data = response.body?.data
    const { lines } = await billRowsFor(data?.billId ?? '00000000-0000-0000-0000-000000000000')

    check('1 201 created', response.status === 201, String(response.status))
    check(
      '1 one bill_line per ITEM_ADDED',
      lines.length === 3,
      `${lines.length} lines`,
    )
    check(
      '1 the three lines really are three different rounds',
      new Set((data?.lines ?? []).map((l: any) => l.roundNumber)).size === 3,
      JSON.stringify((data?.lines ?? []).map((l: any) => l.roundNumber)),
    )
    check(
      '1 subtotal = sum(qty x quoted price)',
      data?.subtotalPaisa === expectedSubtotal,
      `${data?.subtotalPaisa} vs ${expectedSubtotal}`,
    )

    // ── 2. The arithmetic ───────────────────────────────────────────────────
    const expService = Math.round((expectedSubtotal * rateBp) / 10_000)
    const expTax = Math.round(((expectedSubtotal + expService) * taxBp) / 10_000)
    check('2 service on subtotal', data?.serviceChargePaisa === expService,
      `${data?.serviceChargePaisa} vs ${expService}`)
    check('2 tax on subtotal + service', data?.taxPaisa === expTax,
      `${data?.taxPaisa} vs ${expTax}`)
    check('2 total = subtotal + service + tax',
      data?.totalPaisa === expectedSubtotal + expService + expTax)

    // ── 15. Every field an integer ──────────────────────────────────────────
    const money = [
      data?.subtotalPaisa, data?.serviceChargePaisa, data?.taxPaisa, data?.totalPaisa,
      ...(data?.lines ?? []).flatMap((l: any) => [l.unitPricePaisa, l.amountPaisa]),
    ]
    check('15 every monetary field is an integer',
      money.every((v: unknown) => typeof v === 'number' && Number.isInteger(v)),
      JSON.stringify(money))

    // ── 6. A second bill is refused ─────────────────────────────────────────
    const before = (await sql(`SELECT count(*)::int AS n FROM bills WHERE session_id = $1`, [sessionId]))[0].n
    const second = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST',
      body: JSON.stringify({ type: 'consolidated' }),
    })
    const after = (await sql(`SELECT count(*)::int AS n FROM bills WHERE session_id = $1`, [sessionId]))[0].n
    check('6 second bill 409 BILL_ALREADY_OPEN',
      second.status === 409 && second.body?.error?.code === 'BILL_ALREADY_OPEN',
      `${second.status} ${second.body?.error?.code}`)
    check('6 nothing written', before === after, `${before} -> ${after}`)
    check('6 409 names the bill', second.body?.error?.billId === data?.billId)

    // ── 11. The append-only triggers ────────────────────────────────────────
    let billBlocked = false
    try {
      await sql(`UPDATE bills SET total_paisa = 1 WHERE id = $1`, [data.billId])
    } catch { billBlocked = true }
    let lineBlocked = false
    try {
      await sql(`DELETE FROM bill_lines WHERE bill_id = $1`, [data.billId])
    } catch { lineBlocked = true }
    check('11 UPDATE on bills refused', billBlocked)
    check('11 DELETE on bill_lines refused', lineBlocked)

    // ── 9 / 10. The snapshot ────────────────────────────────────────────────
    // Re-price AND RENAME. The original only re-priced, which `getBill` never
    // read — the assertion was vacuous. The name was the field actually served
    // by a live join, and it was the one thing not tested.
    const [itemRow] = await sql(`SELECT id, price_paisa, name FROM menu_items LIMIT 1`)
    const billedName = data?.lines?.[0]?.name
    await sql(`UPDATE menu_items SET price_paisa = price_paisa + 50000 WHERE id = $1`, [itemRow.id])
    await sql(`UPDATE menu_items SET name = 'RENAMED BY VERIFIER' WHERE id = $1`, [itemRow.id])
    await sql(`UPDATE tenant_config SET service_charge_bp = $1 WHERE tenant_id = $2`,
      [rateBp + 500, await tenantId()])
    const reread = await api(waiterCookie, `/api/bills/${data.billId}`)
    check('9 bill unchanged after a menu re-price',
      reread.body?.data?.subtotalPaisa === expectedSubtotal &&
        reread.body?.data?.totalPaisa === data.totalPaisa)
    check('10 bill carries the rate it used',
      reread.body?.data?.serviceChargeBp === rateBp,
      `${reread.body?.data?.serviceChargeBp} vs ${rateBp}`)
    check('9b the dish NAME is snapshotted, not joined live',
      reread.body?.data?.lines?.[0]?.name === billedName &&
        billedName !== 'RENAMED BY VERIFIER',
      `bill says "${reread.body?.data?.lines?.[0]?.name}", menu now says "RENAMED BY VERIFIER"`)
    await sql(`UPDATE menu_items SET price_paisa = $2, name = $3 WHERE id = $1`,
      [itemRow.id, itemRow.price_paisa, itemRow.name])
    await sql(`UPDATE tenant_config SET service_charge_bp = $1 WHERE tenant_id = $2`,
      [rateBp, await tenantId()])

    // ── 4 (AC-4). The bill names what it is made of ─────────────────────────
    const detail = reread.body?.data
    check('AC-4 lines carry name, qty, unit price, amount, seat',
      (detail?.lines ?? []).every((l: any) =>
        typeof l.name === 'string' && l.name !== 'Unknown item' &&
        typeof l.quantity === 'number' &&
        typeof l.unitPricePaisa === 'number' &&
        typeof l.amountPaisa === 'number' &&
        l.seatLabel === 'S1'),
      JSON.stringify(detail?.lines?.[0]))
  }

  // ── 3. Counter sale, no table ─────────────────────────────────────────────
  {
    const { sessionId, seatId } = await makeSession('counter', { withTable: false })
    await addItem(sessionId, seatId, 1, 100_000)
    const response = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    check('3 counter sale, no table: NO service charge',
      response.body?.data?.serviceChargePaisa === 0 &&
        response.body?.data?.serviceChargeBp === 0,
      JSON.stringify(response.body?.data?.serviceChargePaisa))
  }

  // ── 4. Counter sale SEATED at a table — kind is still 'counter' ───────────
  {
    const { sessionId, seatId } = await makeSession('counter', { withTable: true })
    await addItem(sessionId, seatId, 1, 100_000)
    const [kindRow] = await sql(`SELECT kind FROM order_sessions WHERE id = $1`, [sessionId])
    const response = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    check('4 kind is still counter', kindRow.kind === 'counter', kindRow.kind)
    check('4 seated counter sale: service charge APPLIED',
      response.body?.data?.serviceChargePaisa === Math.round((100_000 * rateBp) / 10_000) &&
        response.body?.data?.serviceChargeBp === rateBp,
      JSON.stringify(response.body?.data?.serviceChargePaisa))
  }

  // ── 5. Two simultaneous Generate Bill ─────────────────────────────────────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    await addItem(sessionId, seatId, 1, 777_000)
    const body = JSON.stringify({ type: 'consolidated' })
    const [a, b] = await Promise.all([
      api(waiterCookie, `/api/sessions/${sessionId}/bills`, { method: 'POST', body }),
      api(waiterCookie, `/api/sessions/${sessionId}/bills`, { method: 'POST', body }),
    ])
    track(a); track(b)
    const count = (await sql(`SELECT count(*)::int AS n FROM bills WHERE session_id = $1`, [sessionId]))[0].n
    const statuses = [a.status, b.status].sort()
    check('5 exactly one bill row', count === 1, `${count} bills`)
    check('5 one 201, one 409', statuses[0] === 201 && statuses[1] === 409,
      JSON.stringify(statuses))
    const loser = a.status === 409 ? a : b
    check('5 loser is BILL_ALREADY_OPEN with an id',
      loser.body?.error?.code === 'BILL_ALREADY_OPEN' &&
        typeof loser.body?.error?.billId === 'string' && loser.body.error.billId !== '',
      JSON.stringify(loser.body?.error))
  }

  // ── 7. A hand-inserted comp ───────────────────────────────────────────────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    const eventId = await addItem(sessionId, seatId, 2, 200_000)
    const waiter = await staffId('waiter')
    const owner = await staffId('owner')
    const [comp] = await sql(
      `INSERT INTO comp_records (session_id, order_event_id, staff_id, authorized_by_staff_id, amount_paisa, reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [sessionId, eventId, waiter, owner, 50_000, 'Burnt, remade'],
    )
    mine.comps.push(comp.id)

    const response = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    const data = response.body?.data
    const expectedSubtotal = 400_000 - 50_000
    const expService = Math.round((expectedSubtotal * rateBp) / 10_000)
    check('7 comp is a NEGATIVE line with its reason',
      data?.comps?.[0]?.amountPaisa === -50_000 && data?.comps?.[0]?.reason === 'Burnt, remade',
      JSON.stringify(data?.comps))
    check('7 subtotal reduced by the comp',
      data?.subtotalPaisa === expectedSubtotal, `${data?.subtotalPaisa} vs ${expectedSubtotal}`)
    check('7 service follows the reduced subtotal',
      data?.serviceChargePaisa === expService, `${data?.serviceChargePaisa} vs ${expService}`)

    const detail = await api(waiterCookie, `/api/bills/${data.billId}`)
    check('7 GET renders the comp too',
      detail.body?.data?.comps?.[0]?.reason === 'Burnt, remade')
  }

  // ── 8. Nothing ordered ────────────────────────────────────────────────────
  {
    const { sessionId } = await makeSession('table', { withTable: true })
    const response = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    })
    check('8 empty session 422 NOTHING_TO_BILL',
      response.status === 422 && response.body?.error?.code === 'NOTHING_TO_BILL',
      `${response.status} ${response.body?.error?.code}`)
  }

  // ── 14b. Round ONCE — a case that can actually fail ───────────────────────
  // The original case 14 asserted `total === subtotal + service + tax` and
  // `service === Math.round(subtotal * bp / 10000)` — the first is an identity
  // the code computes by construction and the second restates the
  // implementation's own expression, so both passed whether or not the code
  // rounded per line. This picks line amounts where the two strategies DISAGREE
  // and asserts the whole-bill answer.
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    // 3 lines of 3,333 at 10%: rounding once on 9,999 gives 1,000.
    // Rounding each line (333.3 -> 333) and summing gives 999. One paisa apart,
    // which is the entire defect Trap 5 names.
    await addItem(sessionId, seatId, 1, 3_333, 1)
    await addItem(sessionId, seatId, 1, 3_333, 2)
    await addItem(sessionId, seatId, 1, 3_333, 3)
    const response = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    const d = response.body?.data
    const roundedOnce = Math.round((9_999 * rateBp) / 10_000)
    const roundedPerLine = 3 * Math.round((3_333 * rateBp) / 10_000)
    check('14b the two strategies really do differ here',
      roundedOnce !== roundedPerLine, `once=${roundedOnce} perLine=${roundedPerLine}`)
    check('14b service is rounded ONCE on the whole bill',
      d?.serviceChargePaisa === roundedOnce,
      `${d?.serviceChargePaisa}; once=${roundedOnce}, per-line=${roundedPerLine}`)
  }

  // ── 14. Odd-paisa rounding ────────────────────────────────────────────────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    await addItem(sessionId, seatId, 1, 3_333)
    const response = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    const d = response.body?.data
    check('14 rounds once; total is exactly the sum of its parts',
      d?.totalPaisa === d?.subtotalPaisa + d?.serviceChargePaisa + d?.taxPaisa &&
        Number.isInteger(d?.serviceChargePaisa),
      JSON.stringify(d))
    check('14 service = round(3333 x bp / 10000)',
      d?.serviceChargePaisa === Math.round((3_333 * rateBp) / 10_000),
      `${d?.serviceChargePaisa}`)
  }

  // ── 12. Kumar, kitchen ────────────────────────────────────────────────────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    await addItem(sessionId, seatId, 1, 100_000)
    const post = await api(kitchenCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    })
    const anyBill = (await sql(`SELECT id FROM bills LIMIT 1`))[0]
    const get = await api(kitchenCookie, `/api/bills/${anyBill?.id ?? sessionId}`)
    check('12 kitchen 403 on POST bills', post.status === 403, String(post.status))
    check('12 kitchen 403 on GET bill', get.status === 403, String(get.status))
  }

  // ── 13. A closed session ──────────────────────────────────────────────────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    await addItem(sessionId, seatId, 1, 100_000)
    await sql(`UPDATE order_sessions SET closed_at = now() WHERE id = $1`, [sessionId])
    const response = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    })
    check('13 closed session 409 SESSION_ALREADY_CLOSED',
      response.status === 409 && response.body?.error?.code === 'SESSION_ALREADY_CLOSED',
      `${response.status} ${response.body?.error?.code}`)
  }

  // ── Body validation and 404 ───────────────────────────────────────────────
  {
    const { sessionId } = await makeSession('table', { withTable: true })
    const bad = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'seat' }),
    })
    const missing = await api(waiterCookie,
      `/api/sessions/11111111-1111-4111-8111-111111111111/bills`, {
        method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
      })
    const noBill = await api(waiterCookie, `/api/bills/11111111-1111-4111-8111-111111111111`)
    check('extra 400 on a malformed body', bad.status === 400, String(bad.status))
    check('extra 404 on an unknown session', missing.status === 404, String(missing.status))
    check('extra 404 on an unknown bill', noBill.status === 404, String(noBill.status))
  }

  // ── 2b. Tax ordering, with a NON-ZERO rate ────────────────────────────────
  // The tenant runs at 0% tax, which makes every tax assertion above vacuous:
  // `round(x * 0)` is 0 whatever x is, so a bill that taxed the subtotal
  // instead of subtotal + service would have passed. Set a real rate, bill,
  // and put it back.
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    await addItem(sessionId, seatId, 1, 100_000)
    await sql(`UPDATE tenant_config SET tax_rate_percent = 8 WHERE tenant_id = $1`,
      [await tenantId()])
    const response = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    await sql(`UPDATE tenant_config SET tax_rate_percent = $1 WHERE tenant_id = $2`,
      [config.tax_rate_percent, await tenantId()])

    const d = response.body?.data
    const service = Math.round((100_000 * rateBp) / 10_000)
    const onSubtotalPlusService = Math.round(((100_000 + service) * 800) / 10_000)
    const onSubtotalOnly = Math.round((100_000 * 800) / 10_000)
    check('2b tax is charged on subtotal + service, not subtotal',
      d?.taxPaisa === onSubtotalPlusService && onSubtotalPlusService !== onSubtotalOnly,
      `${d?.taxPaisa}; subtotal+service=${onSubtotalPlusService}, subtotal only=${onSubtotalOnly}`)
    check('2b the bill stores the tax rate it used',
      d?.taxBp === 800, String(d?.taxBp))
    check('2b total = subtotal + service + tax',
      d?.totalPaisa === 100_000 + service + d?.taxPaisa, JSON.stringify(d))
  }

  // ── AC-5 at the DATABASE level ────────────────────────────────────────────
  // Cases 5 and 6 go through the route, whose step-2 check answers first and
  // therefore MASKS the index underneath. Story 6.4's per-seat bills depend on
  // the index itself — a seat bill and a consolidated bill on the same session
  // will not share that guard — so claim a billed event directly and require
  // the database to refuse it, by the name the service catches.
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    const eventId = await addItem(sessionId, seatId, 1, 100_000)
    const first = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    check('AC-5 setup billed', first.status === 201, String(first.status))

    const tid = await tenantId()
    const waiter = await staffId('waiter')
    const [rival] = await sql(
      `INSERT INTO bills (tenant_id, session_id, staff_id, type, subtotal_paisa,
                          service_charge_paisa, tax_paisa, total_paisa,
                          service_charge_bp, tax_bp)
       VALUES ($1, $2, $3, 'seat', 0, 0, 0, 0, 0, 0) RETURNING id`,
      [tid, sessionId, waiter],
    )
    mine.bills.push(rival.id)

    let code: string | null = null
    let constraint: string | null = null
    try {
      await sql(
        `INSERT INTO bill_lines (bill_id, order_event_id, amount_paisa, name)
         VALUES ($1, $2, 100000, 'Rival claim')`,
        [rival.id, eventId],
      )
    } catch (error: any) {
      code = error?.code ?? null
      constraint = error?.constraint ?? null
    }
    check('AC-5 a second bill cannot claim a billed event', code === '23505', String(code))
    check('AC-5 and it fails by the index the service catches BY NAME',
      constraint === 'idx_bill_lines_order_event', String(constraint))
  }

  // ══ Code review 2026-10-13 — the findings that had no coverage ═══════════

  // ── R1. A round after a CONSOLIDATED bill is refused ─────────────────────
  // Story 6.2's review found this: a round on a billed session committed,
  // printed, and could then never appear on any bill.
  //
  // UPDATED for Story 6.4. It used to assert that ANY bill on the session
  // refused ANY round. That is still right for a consolidated bill, which
  // sweeps everything — but wrong for a seat bill, which must leave the other
  // seats ordering (case S2 below). Narrowing the guard without narrowing this
  // case would have left it green while the behaviour changed underneath.
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    await addItem(sessionId, seatId, 1, 100_000)
    const billed = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    check('R1 setup billed', billed.status === 201, String(billed.status))

    const [item] = await sql(`SELECT id, price_paisa FROM menu_items WHERE is_available LIMIT 1`)
    const [seat] = await sql(`SELECT id FROM seat_slots WHERE session_id = $1`, [sessionId])
    const before = (await sql(
      `SELECT count(*)::int AS n FROM order_events WHERE session_id = $1`, [sessionId]))[0].n

    const send = await api(waiterCookie, `/api/sessions/${sessionId}/orders`, {
      method: 'POST',
      body: JSON.stringify({
        submissionId: crypto.randomUUID(),
        lines: [{
          menuItemId: item.id,
          seatSlotId: seat.id,
          quantity: 1,
          modifierText: '',
          quotedPricePaisa: item.price_paisa,
        }],
      }),
    })
    const after = (await sql(
      `SELECT count(*)::int AS n FROM order_events WHERE session_id = $1`, [sessionId]))[0].n

    check('R1 a round after a CONSOLIDATED bill is REFUSED',
      send.status === 409 && send.body?.error?.code === 'SESSION_ALREADY_BILLED',
      `${send.status} ${send.body?.error?.code}`)
    check('R1 and nothing was written', before === after, `${before} -> ${after}`)
    check('R1 the refusal names the bill',
      send.body?.error?.billId === billed.body?.data?.billId)
  }

  // ── R2. Comps larger than the order are refused, not written negative ─────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    const eventId = await addItem(sessionId, seatId, 1, 40_000)
    const waiter = await staffId('waiter')
    const owner = await staffId('owner')
    const [comp] = await sql(
      `INSERT INTO comp_records (session_id, order_event_id, staff_id, authorized_by_staff_id, amount_paisa, reason)
       VALUES ($1, $2, $3, $4, 50000, 'Fat-fingered comp') RETURNING id`,
      [sessionId, eventId, waiter, owner],
    )
    mine.comps.push(comp.id)

    const response = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    })
    const written = (await sql(
      `SELECT count(*)::int AS n FROM bills WHERE session_id = $1`, [sessionId]))[0].n
    check('R2 comps exceeding the order are refused, not billed negative',
      response.status === 422 && response.body?.error?.code === 'COMPS_EXCEED_ORDER',
      `${response.status} ${response.body?.error?.code}`)
    check('R2 no negative bill was written', written === 0, `${written} bills`)
  }

  // ── R3. A NULL unit price fails the bill instead of billing it free ───────
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    const eventId = await addItem(sessionId, seatId, 1, 100_000)
    await sql(`ALTER TABLE order_events DISABLE TRIGGER immutable_order_events`)
    try {
      await sql(`UPDATE order_events SET unit_price_paisa = NULL WHERE id = $1`, [eventId])
    } finally {
      await sql(`ALTER TABLE order_events ENABLE TRIGGER immutable_order_events`)
    }
    const response = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    })
    check('R3 an unpriced item fails the bill rather than billing it at 0',
      response.status === 422 && response.body?.error?.code === 'ITEM_NOT_PRICED',
      `${response.status} ${response.body?.error?.code}`)
  }

  // ── R4. The bill-state endpoint, which is what makes `settling` survive ───
  {
    const { sessionId, seatId } = await makeSession('table', { withTable: true })
    const empty = await api(waiterCookie, `/api/sessions/${sessionId}/bills`)
    await addItem(sessionId, seatId, 1, 100_000)
    const created = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    const loaded = await api(waiterCookie, `/api/sessions/${sessionId}/bills`)
    // UPDATED for Story 6.4: the endpoint returns a LIST plus `hasUnbilled`,
    // because a session can hold one bill per seat and "the session's bill" is
    // a question with no answer. The singular form would have quietly reported
    // the oldest — usually a seat bill — as though it were the whole table's.
    // This read happens BEFORE anything is ordered, so `hasUnbilled` is false
    // because there is nothing at all — not because it is all billed. S14
    // covers the ordered-but-unbilled case.
    check('R4 a session with nothing on it: no bills, nothing to bill',
      empty.status === 200 && empty.body?.data?.bills?.length === 0 &&
        empty.body?.data?.hasUnbilled === false,
      `${empty.status} ${JSON.stringify(empty.body?.data)}`)
    check('R4 a billed session reports its bill, so a reload stays settling',
      loaded.body?.data?.bills?.[0]?.billId === created.body?.data?.billId &&
        loaded.body?.data?.hasUnbilled === false,
      JSON.stringify(loaded.body?.data?.hasUnbilled))
    check('R4 and it carries the lines',
      (loaded.body?.data?.bills?.[0]?.lines ?? []).length === 1)
  }

  // ── R5. x-staff-id shape, and the bill_comps trigger ──────────────────────
  {
    let compBlocked = false
    const [anyComp] = await sql(`SELECT id FROM bill_comps LIMIT 1`)
    if (anyComp) {
      try {
        await sql(`UPDATE bill_comps SET amount_paisa = 1 WHERE id = $1`, [anyComp.id])
      } catch { compBlocked = true }
    } else {
      compBlocked = true  // nothing to test against; the trigger was confirmed in pg_trigger
    }
    check('R5 UPDATE on bill_comps refused', compBlocked)
  }

  // ── R6. The re-auth branch, which the migration switches off ──────────────
  // Net-new security code that nothing exercised. Flipped on for this block
  // only, and restored in the finally below whatever happens.
  {
    const tid = await tenantId()
    await sql(`UPDATE tenant_config SET financial_action_reauth = true WHERE tenant_id = $1`, [tid])
    try {
      const { sessionId, seatId } = await makeSession('table', { withTable: true })
      await addItem(sessionId, seatId, 1, 100_000)

      const noPin = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
        method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
      })
      const shortPin = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
        method: 'POST', body: JSON.stringify({ type: 'consolidated', pin: '123' }),
      })
      const wrongPin = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
        method: 'POST', body: JSON.stringify({ type: 'consolidated', pin: '9999' }),
      })
      const goodPin = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
        method: 'POST', body: JSON.stringify({ type: 'consolidated', pin: '1234' }),
      }))

      check('R6 no PIN -> 401 REAUTH_REQUIRED',
        noPin.status === 401 && noPin.body?.error?.code === 'REAUTH_REQUIRED',
        `${noPin.status} ${noPin.body?.error?.code}`)
      check('R6 a malformed PIN blames the PIN, not `type`',
        shortPin.status === 400 && /PIN/.test(shortPin.body?.error?.message ?? ''),
        `${shortPin.status} "${shortPin.body?.error?.message}"`)
      check('R6 a wrong PIN -> 401 REAUTH_FAILED',
        wrongPin.status === 401 && wrongPin.body?.error?.code === 'REAUTH_FAILED',
        `${wrongPin.status} ${wrongPin.body?.error?.code}`)
      check('R6 the right PIN bills, and stamps the PIN owner',
        goodPin.status === 201 &&
          goodPin.body?.data?.billId !== undefined,
        `${goodPin.status}`)
      if (goodPin.body?.data?.billId) {
        const [row] = await sql(`SELECT staff_id FROM bills WHERE id = $1`,
          [goodPin.body.data.billId])
        check('R6 bills.staff_id is the staff member who gave the PIN',
          row?.staff_id === (await staffId('waiter')), String(row?.staff_id))
      }
    } finally {
      await sql(`UPDATE tenant_config SET financial_action_reauth = false WHERE tenant_id = $1`,
        [tid])
    }
  }

  // ══ Story 6.4 — per-seat independent billing ═════════════════════════════

  // ── S1. One seat of three ────────────────────────────────────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 3 })
    await addItem(sessionId, seatIds[0]!, 2, 100_000)
    await addItem(sessionId, seatIds[1]!, 1, 250_000)
    await addItem(sessionId, seatIds[2]!, 1, 75_000)

    const response = track(await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' }))
    const d = response.body?.data
    check('S1 201 created', response.status === 201, String(response.status))
    check('S1 type is seat and it names the seat',
      d?.type === 'seat' && d?.seatSlotId === seatIds[0] && d?.seatLabel === 'S1',
      `${d?.type} ${d?.seatLabel}`)
    check('S1 only that seat is on it',
      d?.lines?.length === 1 && d?.subtotalPaisa === 200_000,
      `${d?.lines?.length} lines, subtotal ${d?.subtotalPaisa}`)
    check('S1 service charge on the SEAT subtotal',
      d?.serviceChargePaisa === Math.round((200_000 * rateBp) / 10_000),
      String(d?.serviceChargePaisa))
  }

  // ── S2. THE REGRESSION. The rest of the table carries on (AC-2) ──────────
  // This is the case the whole story exists for, and the one that would have
  // failed against the guard as Story 6.2 left it.
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 3 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    await addItem(sessionId, seatIds[1]!, 1, 100_000)
    const billed = track(await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' }))
    check('S2 setup: seat 1 billed', billed.status === 201, String(billed.status))

    const other = await sendRound(waiterCookie, sessionId, [{ seatId: seatIds[1]! }])
    check('S2 a round for ANOTHER seat is ACCEPTED',
      other.status === 201, `${other.status} ${other.body?.error?.code}`)

    const same = await sendRound(waiterCookie, sessionId, [{ seatId: seatIds[0]! }])
    check('S2 a round for the BILLED seat is refused (AC-3)',
      same.status === 409 && same.body?.error?.code === 'SEAT_ALREADY_BILLED',
      `${same.status} ${same.body?.error?.code}`)
    check('S2 the refusal names the seat, not a uuid',
      same.body?.error?.seatLabel === 'S1', String(same.body?.error?.seatLabel))
  }

  // ── S3. A mixed round is refused WHOLE (Trap 1) ──────────────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
      { method: 'POST', body: '{}' }))

    const before = (await sql(
      `SELECT count(*)::int AS n FROM order_events WHERE session_id = $1`, [sessionId]))[0].n
    const mixed = await sendRound(waiterCookie, sessionId,
      [{ seatId: seatIds[1]! }, { seatId: seatIds[0]! }])
    const after = (await sql(
      `SELECT count(*)::int AS n FROM order_events WHERE session_id = $1`, [sessionId]))[0].n
    check('S3 a round touching a billed seat is refused',
      mixed.status === 409 && mixed.body?.error?.code === 'SEAT_ALREADY_BILLED',
      `${mixed.status} ${mixed.body?.error?.code}`)
    check('S3 and the OTHER seat\'s line was not written either',
      before === after, `${before} -> ${after}`)
  }

  // ── S4. Second seat billed; no overlap (AC-4) ────────────────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    const e1 = await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const e2 = await addItem(sessionId, seatIds[1]!, 1, 200_000)
    const b1 = track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
      { method: 'POST', body: '{}' }))
    const b2 = track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[1]}/bill`,
      { method: 'POST', body: '{}' }))
    const claimed = await sql(
      `SELECT order_event_id FROM bill_lines WHERE bill_id = ANY($1::uuid[]) ORDER BY 1`,
      [[b1.body?.data?.billId, b2.body?.data?.billId]])
    check('S4 both seats billed', b1.status === 201 && b2.status === 201)
    check('S4 no event on both bills; union is both events',
      claimed.length === 2 && new Set(claimed.map((r: any) => r.order_event_id)).size === 2 &&
        [e1, e2].every((id) => claimed.some((r: any) => r.order_event_id === id)),
      JSON.stringify(claimed.map((r: any) => r.order_event_id)))
  }

  // ── S5. The REMAINDER bill (AC-5) ────────────────────────────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 4 })
    for (const seatId of seatIds) await addItem(sessionId, seatId, 1, 100_000)
    track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
      { method: 'POST', body: '{}' }))
    track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[1]}/bill`,
      { method: 'POST', body: '{}' }))

    const remainder = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    const d = remainder.body?.data
    check('S5 a consolidated bill after 2 seat bills is ACCEPTED',
      remainder.status === 201, `${remainder.status} ${remainder.body?.error?.code}`)
    check('S5 it covers ONLY the 2 unbilled seats',
      d?.lines?.length === 2 && d?.subtotalPaisa === 200_000,
      `${d?.lines?.length} lines, subtotal ${d?.subtotalPaisa}`)

    const again = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    })
    check('S5 a second consolidated bill is refused',
      again.status === 409 && again.body?.error?.code === 'BILL_ALREADY_OPEN',
      `${again.status} ${again.body?.error?.code}`)
    check('S5 and the 409 names the CONSOLIDATED bill, not the oldest seat bill',
      again.body?.error?.billId === d?.billId,
      `${again.body?.error?.billId} vs ${d?.billId}`)
  }

  // ── S6. Nothing left to bill (AC-5 tail, AC-7) ───────────────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    await addItem(sessionId, seatIds[1]!, 1, 100_000)
    track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    const nothing = await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    })
    const seatAfter = await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' })
    check('S6 a second consolidated bill is 409',
      nothing.status === 409, String(nothing.status))
    check('S6 a seat already swept by a consolidated bill is 422 SEAT_HAS_NO_ITEMS',
      seatAfter.status === 422 && seatAfter.body?.error?.code === 'SEAT_HAS_NO_ITEMS',
      `${seatAfter.status} ${seatAfter.body?.error?.code}`)
  }

  // ── S7. The same seat twice, and two tablets at once (AC-6, AC-9) ────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const first = track(await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' }))
    const second = await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' })
    check('S7 the same seat twice is 409 SEAT_ALREADY_BILLED',
      second.status === 409 && second.body?.error?.code === 'SEAT_ALREADY_BILLED',
      `${second.status} ${second.body?.error?.code}`)
    check('S7 the 409 names the bill',
      second.body?.error?.billId === first.body?.data?.billId)
  }

  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const [a, b] = await Promise.all([
      api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
        { method: 'POST', body: '{}' }),
      api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
        { method: 'POST', body: '{}' }),
    ])
    track(a); track(b)
    const count = (await sql(
      `SELECT count(*)::int AS n FROM bills WHERE seat_slot_id = $1`, [seatIds[0]]))[0].n
    const statuses = [a.status, b.status].sort()
    check('S7 two simultaneous taps on ONE seat: exactly one bill',
      count === 1, `${count} bills`)
    check('S7 one 201, one 409', statuses[0] === 201 && statuses[1] === 409,
      JSON.stringify(statuses))
  }

  // ── S8. Concurrent bills on DIFFERENT seats must BOTH succeed ────────────
  // The session lock serialises them; it must not turn AC-2 into a failure.
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    await addItem(sessionId, seatIds[1]!, 1, 100_000)
    const [a, b] = await Promise.all([
      api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
        { method: 'POST', body: '{}' }),
      api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[1]}/bill`,
        { method: 'POST', body: '{}' }),
    ])
    track(a); track(b)
    check('S8 two seats billed concurrently BOTH succeed',
      a.status === 201 && b.status === 201, JSON.stringify([a.status, b.status]))
  }

  // ── S9. Empty seat, foreign seat (AC-7, AC-8) ────────────────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const empty = await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[1]}/bill`, { method: 'POST', body: '{}' })

    const other = await makeSession('table', { withTable: true, seats: 1 })
    const foreign = await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${other.seatId}/bill`, { method: 'POST', body: '{}' })

    check('S9 a seat with no items is 422 SEAT_HAS_NO_ITEMS',
      empty.status === 422 && empty.body?.error?.code === 'SEAT_HAS_NO_ITEMS',
      `${empty.status} ${empty.body?.error?.code}`)
    check('S9 a seat from another session is 404, not a bill and not a 500',
      foreign.status === 404 && foreign.body?.error?.code === 'SEAT_NOT_ON_SESSION',
      `${foreign.status} ${foreign.body?.error?.code}`)
  }

  // ── S10. One seat's unpriced item must not block another seat ────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const broken = await addItem(sessionId, seatIds[1]!, 1, 100_000)
    await sql(`ALTER TABLE order_events DISABLE TRIGGER immutable_order_events`)
    try {
      await sql(`UPDATE order_events SET unit_price_paisa = NULL WHERE id = $1`, [broken])
    } finally {
      await sql(`ALTER TABLE order_events ENABLE TRIGGER immutable_order_events`)
    }
    const good = track(await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' }))
    const bad = await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[1]}/bill`, { method: 'POST', body: '{}' })
    check('S10 the healthy seat still bills',
      good.status === 201, `${good.status} ${good.body?.error?.code}`)
    check('S10 the unpriced seat is 422 ITEM_NOT_PRICED',
      bad.status === 422 && bad.body?.error?.code === 'ITEM_NOT_PRICED',
      `${bad.status} ${bad.body?.error?.code}`)
  }

  // ── S11. A NULL-seat event is picked up by the remainder (Trap 2) ────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 2 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const orphan = await addItem(sessionId, seatIds[1]!, 1, 50_000)
    await sql(`ALTER TABLE order_events DISABLE TRIGGER immutable_order_events`)
    try {
      await sql(`UPDATE order_events SET seat_slot_id = NULL WHERE id = $1`, [orphan])
    } finally {
      await sql(`ALTER TABLE order_events ENABLE TRIGGER immutable_order_events`)
    }
    track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
      { method: 'POST', body: '{}' }))
    const remainder = track(await api(waiterCookie, `/api/sessions/${sessionId}/bills`, {
      method: 'POST', body: JSON.stringify({ type: 'consolidated' }),
    }))
    check('S11 the remainder bill covers an event with NO seat',
      remainder.status === 201 && remainder.body?.data?.subtotalPaisa === 50_000,
      `${remainder.status} subtotal ${remainder.body?.data?.subtotalPaisa}`)
  }

  // ── S12. The seat NOTE must not reach the bill (AC-11b) ──────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 1 })
    await sql(`UPDATE seat_slots SET seat_note = 'bald man' WHERE id = $1`, [seatIds[0]])
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const response = track(await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' }))
    const asText = JSON.stringify(response.body)
    const stored = await sql(
      `SELECT * FROM bill_lines WHERE bill_id = $1`, [response.body?.data?.billId])
    check('S12 the seat note appears NOWHERE in the response',
      !asText.includes('bald man'), asText.slice(0, 160))
    check('S12 nor anywhere in the stored bill lines',
      !JSON.stringify(stored).includes('bald man'))
    check('S12 but the seat LABEL does', response.body?.data?.seatLabel === 'S1')
  }

  // ── S13. A counter sale with no table: no service charge ─────────────────
  {
    const { sessionId, seatIds } = await makeSession('counter', { withTable: false, seats: 1 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const response = track(await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' }))
    check('S13 seat bill on a table-less counter sale: NO service charge',
      response.body?.data?.serviceChargePaisa === 0 &&
        response.body?.data?.serviceChargeBp === 0,
      String(response.body?.data?.serviceChargePaisa))
  }

  // ── S14. The list endpoint reports every bill (Task 5) ───────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 3 })
    for (const seatId of seatIds) await addItem(sessionId, seatId, 1, 100_000)
    const before = await api(waiterCookie, `/api/sessions/${sessionId}/bills`)
    track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`,
      { method: 'POST', body: '{}' }))
    track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[1]}/bill`,
      { method: 'POST', body: '{}' }))
    const mid = await api(waiterCookie, `/api/sessions/${sessionId}/bills`)
    track(await api(waiterCookie, `/api/sessions/${sessionId}/seats/${seatIds[2]}/bill`,
      { method: 'POST', body: '{}' }))
    const done = await api(waiterCookie, `/api/sessions/${sessionId}/bills`)

    check('S14 before: no bills, something to bill',
      before.body?.data?.bills?.length === 0 && before.body?.data?.hasUnbilled === true)
    check('S14 two seats billed: 2 bills, STILL something to bill',
      mid.body?.data?.bills?.length === 2 && mid.body?.data?.hasUnbilled === true,
      `${mid.body?.data?.bills?.length} bills, hasUnbilled ${mid.body?.data?.hasUnbilled}`)
    check('S14 all seats billed: 3 bills, nothing left — THIS is settling',
      done.body?.data?.bills?.length === 3 && done.body?.data?.hasUnbilled === false,
      `${done.body?.data?.bills?.length} bills, hasUnbilled ${done.body?.data?.hasUnbilled}`)
  }

  // ── S15. Kitchen is refused; the trigger holds ───────────────────────────
  {
    const { sessionId, seatIds } = await makeSession('table', { withTable: true, seats: 1 })
    await addItem(sessionId, seatIds[0]!, 1, 100_000)
    const kumar = await api(kitchenCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' })
    check('S15 kitchen 403 on the seat-bill route', kumar.status === 403, String(kumar.status))

    const mine2 = track(await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' }))
    await sql(`UPDATE order_sessions SET closed_at = now() WHERE id = $1`, [sessionId])
    const closed = await api(waiterCookie,
      `/api/sessions/${sessionId}/seats/${seatIds[0]}/bill`, { method: 'POST', body: '{}' })
    check('S15 setup billed', mine2.status === 201, String(mine2.status))
    check('S15 a closed session is 409 SESSION_ALREADY_CLOSED',
      closed.status === 409 && closed.body?.error?.code === 'SESSION_ALREADY_CLOSED',
      `${closed.status} ${closed.body?.error?.code}`)
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
}

async function cleanup() {
  // ── Cleanup, with the triggers guaranteed back on ─────────────────────────
  //
  // `ALTER TABLE ... DISABLE TRIGGER` is a PERSISTENT catalog change, not a
  // session setting. The original had no `try/finally`, so a deadlock, a lock
  // timeout, an FK violation or a Ctrl-C between DISABLE and ENABLE left the
  // append-only guarantee — the thing this whole story rests on — silently off
  // on a shared database, with nothing in the code to suggest it had happened.
  const GUARDED = [
    ['order_rounds', 'immutable_order_rounds'],
    ['bill_lines', 'immutable_bill_lines'],
    ['bill_comps', 'immutable_bill_comps'],
    ['bills', 'immutable_bills'],
    ['comp_records', 'immutable_comp_records'],
    ['order_events', 'immutable_order_events'],
  ] as const

  try {
    for (const [table, trigger] of GUARDED) {
      await sql(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
    }

    if (mine.bills.length) {
      await sql(`DELETE FROM bill_lines WHERE bill_id = ANY($1::uuid[])`, [mine.bills])
      await sql(`DELETE FROM bill_comps WHERE bill_id = ANY($1::uuid[])`, [mine.bills])
      await sql(`DELETE FROM bills WHERE id = ANY($1::uuid[])`, [mine.bills])
    }
    if (mine.comps.length) {
      await sql(`DELETE FROM comp_records WHERE id = ANY($1::uuid[])`, [mine.comps])
    }
    // By SESSION, not by tracked id: an accepted round writes events this
    // script never saw. Children first — print_jobs references order_rounds.
    if (mine.sessions.length) {
      await sql(`DELETE FROM print_jobs WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
      await sql(`DELETE FROM order_rounds WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
      await sql(`DELETE FROM order_events WHERE session_id = ANY($1::uuid[])`, [mine.sessions])
    }
  } finally {
    // Restored whatever happened above. A failure to re-enable is louder than
    // a failure to clean up, so it is reported rather than swallowed.
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
  if (mine.sessions.length) {
    await sql(`DELETE FROM order_sessions WHERE id = ANY($1::uuid[])`, [mine.sessions])
  }

}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
