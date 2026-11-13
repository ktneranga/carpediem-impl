/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Story 9.5 — end-of-day takings, through the service, on throwaway tenants.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-takings.ts
 *
 * No dev server needed. Builds one past business day in a `ZZ Takings verify`
 * tenant with known amounts — a split tender, two bills on one order, a partly
 * paid open order, a walkout, an order opened after midnight (before the 4 AM
 * turnover), a custom charge, a comp, a bar tab, an empty abandoned table and
 * a no-sale — plus a second tenant whose order must never be counted. Then
 * checks every figure, the printed slip, and the date rule.
 *
 * Cleanup on a local database only, with the append-only guards off just
 * around the deletes; anywhere else the rows are left (they belong to tenants
 * nobody uses).
 */
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { buildTakings } from '@/server/print/escpos'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { checkTakingsDate, loadTakings, printTakings } from '@/server/services/takings.service'
import type { TakingsPayload } from '@/types/tickets'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const rows = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows as any[]
const one = async (text: ReturnType<typeof q>) => (await rows(text))[0]

const DAY = '2026-01-15'
const EMPTY_DAY = '2026-01-10'
const tenantIds: string[] = []

/** A tenant with a zone, two tables and a waiter; Colombo, turnover 4 AM. */
async function makeTenant(name: string) {
  const tenantId = (await one(q`INSERT INTO tenants (name) VALUES (${name}) RETURNING id`)).id as string
  tenantIds.push(tenantId)
  const waiter = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash)
    VALUES (${tenantId}, 'ZZ Wendy', 'waiter', 'x') RETURNING id`)).id as string
  const zone = (await one(q`INSERT INTO zones (tenant_id, name) VALUES (${tenantId}, 'ZZ Zone') RETURNING id`)).id as string
  const t1 = (await one(q`INSERT INTO tables (tenant_id, zone_id, label) VALUES (${tenantId}, ${zone}, 'ZZ T1') RETURNING id`)).id as string
  const t2 = (await one(q`INSERT INTO tables (tenant_id, zone_id, label) VALUES (${tenantId}, ${zone}, 'ZZ T2') RETURNING id`)).id as string
  return { tenantId, waiter, t1, t2 }
}

type T = Awaited<ReturnType<typeof makeTenant>>

/** An order opened at `openedAt` (Colombo), with items; closed with `close` unless null. */
async function order(
  t: T,
  { openedAt, table, kind = 'table', tabLabel = null, items, close }: {
    openedAt: string
    table: string | null
    kind?: 'table' | 'counter'
    tabLabel?: string | null
    items: number[]
    close: 'settled' | 'walkout' | 'abandoned' | null
  },
) {
  const session = await one(q`INSERT INTO order_sessions (tenant_id, table_id, kind, opened_by_staff_id, opened_at, tab_label, closed_at)
    VALUES (${t.tenantId}, ${table}, ${kind}, ${t.waiter}, ${openedAt}::timestamptz, ${tabLabel},
            ${close ? q`${openedAt}::timestamptz + interval '1 hour'` : null})
    RETURNING id, business_date::text AS business_date, daily_number`)
  if (table) {
    await rows(q`INSERT INTO order_session_tables (session_id, table_id, released_at)
      VALUES (${session.id}, ${table}, ${close ? q`now()` : null})`)
  }
  const events: string[] = []
  for (const price of items) {
    events.push((await one(q`INSERT INTO order_events (session_id, staff_id, event_type, quantity, unit_price_paisa, custom_name)
      VALUES (${session.id}, ${t.waiter}, 'ITEM_ADDED', 1, ${price}, 'ZZ item') RETURNING id`)).id)
  }
  if (close) {
    await rows(q`INSERT INTO order_events (session_id, staff_id, event_type, notes)
      VALUES (${session.id}, ${t.waiter}, 'SESSION_CLOSED', ${close})`)
  }
  return { id: session.id as string, businessDate: session.business_date as string, dailyNumber: session.daily_number as number, events }
}

/** A bill over some of the order's events, with service and tax as given. */
async function bill(t: T, sessionId: string, events: string[], amounts: number[], service: number, tax: number) {
  const subtotal = amounts.reduce((a, b) => a + b, 0)
  const b = await one(q`INSERT INTO bills (tenant_id, session_id, staff_id, type, subtotal_paisa, service_charge_paisa,
      tax_paisa, total_paisa, service_charge_bp, tax_bp, person_label)
    VALUES (${t.tenantId}, ${sessionId}, ${t.waiter}, 'split', ${subtotal}, ${service}, ${tax},
            ${subtotal + service + tax}, 1000, 0, 'ZZ') RETURNING id`)
  for (const [i, eventId] of events.entries()) {
    await rows(q`INSERT INTO bill_lines (bill_id, order_event_id, quantity, amount_paisa, name)
      VALUES (${b.id}, ${eventId}, 1, ${amounts[i]}, 'ZZ dish')`)
  }
  return b.id as string
}

async function pay(t: T, sessionId: string, billId: string, method: 'cash' | 'card' | 'transfer', amount: number) {
  await rows(q`INSERT INTO payment_records (session_id, bill_id, staff_id, amount_paisa, method)
    VALUES (${sessionId}, ${billId}, ${t.waiter}, ${amount}, ${method})`)
}

async function run() {
  const a = await makeTenant('ZZ Takings verify')
  const other = await makeTenant('ZZ Takings other')

  // S1: one bill, service + tax, paid cash + card (a split tender), and a comp of -100.
  const s1 = await order(a, { openedAt: `${DAY} 20:00+05:30`, table: a.t1, items: [2000], close: 'settled' })
  const b1 = await bill(a, s1.id, s1.events, [2000], 200, 100)
  await pay(a, s1.id, b1, 'cash', 1300)
  await pay(a, s1.id, b1, 'card', 1000)
  const comp = await one(q`INSERT INTO comp_records (session_id, order_event_id, staff_id, authorized_by_staff_id, amount_paisa, reason)
    VALUES (${s1.id}, ${s1.events[0]}, ${a.waiter}, ${a.waiter}, 100, 'ZZ') RETURNING id`)
  await rows(q`INSERT INTO bill_comps (bill_id, comp_record_id, amount_paisa) VALUES (${b1}, ${comp.id}, -100)`)
  // S2: two bills on one order, cash and transfer.
  const s2 = await order(a, { openedAt: `${DAY} 20:30+05:30`, table: a.t1, items: [1500, 500], close: 'settled' })
  await pay(a, s2.id, await bill(a, s2.id, [s2.events[0]!], [1500], 150, 0), 'cash', 1650)
  await pay(a, s2.id, await bill(a, s2.id, [s2.events[1]!], [500], 50, 0), 'transfer', 550)
  // S3: still open on T2, billed, partly paid by card.
  const s3 = await order(a, { openedAt: `${DAY} 21:00+05:30`, table: a.t2, items: [3000], close: null })
  await pay(a, s3.id, await bill(a, s3.id, s3.events, [3000], 300, 0), 'card', 1000)
  // S4: a walkout with a bill, nothing paid.
  const s4 = await order(a, { openedAt: `${DAY} 21:30+05:30`, table: a.t1, items: [800], close: 'walkout' })
  await bill(a, s4.id, s4.events, [800], 0, 0)
  // S5: opened at 02:00 the next calendar day — before the 4 AM turnover — a custom charge, paid cash.
  const s5 = await order(a, { openedAt: '2026-01-16 02:00+05:30', table: null, kind: 'counter', items: [400], close: 'settled' })
  await pay(a, s5.id, await bill(a, s5.id, s5.events, [400], 0, 0), 'cash', 400)
  // S6: opened by mistake, closed empty — not an order, not "closed unpaid".
  await order(a, { openedAt: `${DAY} 22:00+05:30`, table: a.t1, items: [], close: 'abandoned' })
  // S7: a bar tab still open, unbilled.
  const s7 = await order(a, { openedAt: `${DAY} 22:30+05:30`, table: null, kind: 'counter', tabLabel: 'white shirt', items: [600], close: null })
  // A no-sale opening that night.
  const job = await one(q`INSERT INTO print_jobs (tenant_id, destination, ticket)
    VALUES (${a.tenantId}, 'cashier', '{"kind":"drawer","destination":"cashier","tableLabels":["Cash drawer"],"opening":"no_sale"}'::jsonb) RETURNING id`)
  await rows(q`INSERT INTO cash_drawer_openings (tenant_id, kind, reason, print_job_id, staff_id, created_at)
    VALUES (${a.tenantId}, 'no_sale', 'float', ${job.id}, ${a.waiter}, ${`${DAY} 19:00+05:30`}::timestamptz)`)
  // The other tenant's order on the same day.
  const x = await order(other, { openedAt: `${DAY} 20:00+05:30`, table: other.t1, items: [99900], close: 'settled' })
  await pay(other, x.id, await bill(other, x.id, x.events, [99900], 0, 0), 'cash', 99900)

  check('the after-midnight order belongs to the earlier business day', s5.businessDate === DAY, s5.businessDate)

  const t = await loadTakings(db, { tenantId: a.tenantId, businessDate: DAY })
  const want = {
    orders: 6, itemsPaisa: 8200, compsPaisa: -100, subtotalPaisa: 8200, serviceChargePaisa: 700, taxPaisa: 100,
    billedPaisa: 9000, paid: { cashPaisa: 3350, cardPaisa: 2000, transferPaisa: 550, totalPaisa: 5900 },
    closedUnpaid: { count: 1, owedPaisa: 800 },
  }
  for (const [key, value] of Object.entries(want)) {
    check(`${key}`, JSON.stringify((t as any)[key]) === JSON.stringify(value), `got ${JSON.stringify((t as any)[key])}`)
  }
  check('open orders: T2 and the bar tab, by number',
    JSON.stringify(t.openOrders.map((o) => [o.dailyNumber, o.tables])) ===
      JSON.stringify([[s3.dailyNumber, ['ZZ T2']], [s7.dailyNumber, ['Bar tab (white shirt)']]]),
    JSON.stringify(t.openOrders))
  check('open orders say who opened them', t.openOrders.every((o) => o.openedBy === 'ZZ Wendy'))
  check('the no-sale opening is listed', t.noSales.length === 1 && t.noSales[0]!.reason === 'float' && t.noSales[0]!.staffName === 'ZZ Wendy')

  const empty = await loadTakings(db, { tenantId: a.tenantId, businessDate: EMPTY_DAY })
  check('a day with nothing is all zeros', empty.orders === 0 && empty.billedPaisa === 0 && empty.paid.totalPaisa === 0 &&
    empty.openOrders.length === 0 && empty.noSales.length === 0)
  const theirs = await loadTakings(db, { tenantId: other.tenantId, businessDate: DAY })
  check('the other tenant sees only its own order', theirs.orders === 1 && theirs.paid.cashPaisa === 99900)

  for (const bad of ['2999-01-01', '2026-02-30', 'yesterday', '']) {
    let refused = false
    try {
      await checkTakingsDate(db, a.tenantId, bad)
    } catch (error) {
      refused = error instanceof MenuRuleError
    }
    check(`date "${bad}" is refused`, refused)
  }

  // Print: one cashier job with the whole day, and bytes a printer accepts.
  const { jobId } = await db.transaction((tx) => printTakings(tx, { tenantId: a.tenantId, staffId: a.waiter, businessDate: DAY }))
  const printed = await one(q`SELECT destination, session_id, ticket FROM print_jobs WHERE id = ${jobId}`)
  const payload = printed.ticket as TakingsPayload
  check('print: one cashier job, no order, kind takings, End of day label',
    printed.destination === 'cashier' && printed.session_id === null && payload.kind === 'takings' &&
      payload.tableLabels[0] === 'End of day' && payload.takings.billedPaisa === 9000)
  const text = buildTakings(payload).toString('latin1')
  check('the slip shows the totals, the open orders and the no-sale',
    text.includes('END OF DAY') && text.includes('LKR 90') && text.includes('LKR 59') &&
      text.includes(`#${String(s3.dailyNumber).padStart(3, '0')}`) && text.includes('Float'), '')
  check('an old or broken payload still prints', buildTakings({ kind: 'takings' } as any).length > 0)
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  // Ours, and any left by a run that died before its cleanup.
  const stray = (await rows(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Takings %'`)).map((r) => r.id as string)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  const guarded = [
    ['bill_comps', 'immutable_bill_comps'],
    ['comp_records', 'immutable_comp_records'],
    ['payment_records', 'immutable_payment_records'],
    ['bill_lines', 'immutable_bill_lines'],
    ['bills', 'immutable_bills'],
    ['cash_drawer_openings', 'immutable_cash_drawer_openings'],
    ['order_events', 'immutable_order_events'],
  ] as const
  const sessions = q`(select id from order_sessions where tenant_id = any(${all}::uuid[]))`
  try {
    for (const [table, trigger] of guarded) await db.execute(q.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))
    await db.execute(q`DELETE FROM bill_comps WHERE bill_id IN (select id from bills where tenant_id = any(${all}::uuid[]))`)
    await db.execute(q`DELETE FROM comp_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM payment_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM bill_lines WHERE bill_id IN (select id from bills where tenant_id = any(${all}::uuid[]))`)
    await db.execute(q`DELETE FROM bills WHERE tenant_id = any(${all}::uuid[])`)
    await db.execute(q`DELETE FROM cash_drawer_openings WHERE tenant_id = any(${all}::uuid[])`)
    await db.execute(q`DELETE FROM order_events WHERE session_id IN ${sessions}`)
  } finally {
    for (const [table, trigger] of guarded) {
      await db.execute(q.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)).catch((error) =>
        console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error),
      )
    }
  }
  await db.execute(q`DELETE FROM print_jobs WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM order_session_tables WHERE session_id IN ${sessions}`)
  await db.execute(q`DELETE FROM order_sessions WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM order_number_counters WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM tables WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM zones WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM staff WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM tenants WHERE id = any(${all}::uuid[])`)
}

run()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error('cleanup failed:', error))
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exit(results.every(Boolean) ? 0 : 1)
  })
