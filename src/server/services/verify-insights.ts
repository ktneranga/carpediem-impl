/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * The period dashboard (Teran's Carpe Diem mock-up, 2026-11-13), through the
 * service, on throwaway tenants.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-insights.ts
 *
 * Today: a split-paid order, an open order with a printed bill, a walkout, a
 * comp, a cash count. Yesterday: one transfer. A week ago, a minute before
 * "now − 7 days": the comparison. Another tenant must never count.
 * Local cleanup only, guards off just around the deletes.
 */
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { checkPeriod, loadInsights } from '@/server/services/insights.service'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const one = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows[0] as any
const tenantIds: string[] = []

async function tenant(name: string) {
  const id = (await one(q`INSERT INTO tenants (name) VALUES (${name}) RETURNING id`)).id as string
  tenantIds.push(id)
  await db.execute(q`INSERT INTO tenant_config (tenant_id, restaurant_name) VALUES (${id}, ${name})`)
  const owner = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash) VALUES (${id}, 'ZZ Owner', 'owner', 'x') RETURNING id`)).id as string
  const zone = (await one(q`INSERT INTO zones (tenant_id, name) VALUES (${id}, 'ZZ Roof') RETURNING id`)).id
  const table = (await one(q`INSERT INTO tables (tenant_id, zone_id, label) VALUES (${id}, ${zone}, 'ZZ R03') RETURNING id`)).id as string
  return { id, owner, table }
}
type T = Awaited<ReturnType<typeof tenant>>

/** An order with one billed line; `opened` and `billed` are SQL timestamps. */
async function order(
  t: T,
  o: { opened: ReturnType<typeof q>; billed: ReturnType<typeof q>; item: string; qty: number; paisa: number; covers?: number; table?: boolean; close?: 'settled' | 'walkout' | null },
) {
  const close = o.close === undefined ? 'settled' : o.close
  const s = await one(q`INSERT INTO order_sessions (tenant_id, table_id, kind, opened_by_staff_id, opened_at, cover_count, closed_at)
    VALUES (${t.id}, ${o.table ? t.table : null}, ${o.table ? 'table' : 'counter'}, ${t.owner}, ${o.opened}, ${o.covers ?? 1},
            ${close ? q`now()` : null}) RETURNING id, business_date::text AS d, daily_number`)
  if (o.table) await db.execute(q`INSERT INTO order_session_tables (session_id, table_id, released_at) VALUES (${s.id}, ${t.table}, ${close ? q`now()` : null})`)
  const event = (await one(q`INSERT INTO order_events (session_id, staff_id, event_type, quantity, unit_price_paisa, custom_name)
    VALUES (${s.id}, ${t.owner}, 'ITEM_ADDED', ${o.qty}, ${o.paisa / o.qty}, ${o.item}) RETURNING id`)).id
  const bill = (await one(q`INSERT INTO bills (tenant_id, session_id, staff_id, type, subtotal_paisa, service_charge_paisa, tax_paisa,
      total_paisa, service_charge_bp, tax_bp, created_at)
    VALUES (${t.id}, ${s.id}, ${t.owner}, 'consolidated', ${o.paisa}, 0, 0, ${o.paisa}, 0, 0, ${o.billed}) RETURNING id`)).id
  await db.execute(q`INSERT INTO bill_lines (bill_id, order_event_id, quantity, amount_paisa, name) VALUES (${bill}, ${event}, ${o.qty}, ${o.paisa}, ${o.item})`)
  if (close === 'walkout') {
    await db.execute(q`INSERT INTO order_events (session_id, staff_id, event_type, notes) VALUES (${s.id}, ${t.owner}, 'SESSION_CLOSED', 'walkout')`)
  }
  return { id: s.id as string, date: s.d as string, number: s.daily_number as number, event: event as string, bill: bill as string }
}

async function pay(sessionId: string, billId: string, staffId: string, method: string, paisa: number) {
  await db.execute(q`INSERT INTO payment_records (session_id, bill_id, staff_id, amount_paisa, method)
    VALUES (${sessionId}, ${billId}, ${staffId}, ${paisa}, ${method})`)
}

async function run() {
  const a = await tenant('ZZ Insights verify')
  const other = await tenant('ZZ Insights other')
  const today = (await one(q`SELECT business_date_at(${a.id}, now())::text AS d`)).d as string
  const at = (date: string, hhmm: string) => q`${`${date} ${hhmm}+05:30`}::timestamptz`
  const shift = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }

  // Today.
  const A = await order(a, { opened: at(today, '19:00'), billed: at(today, '19:10'), item: 'ZZ Kottu', qty: 2, paisa: 10000, covers: 2 })
  await pay(A.id, A.bill, a.owner, 'cash', 6000)
  await pay(A.id, A.bill, a.owner, 'card', 4000)
  const B = await order(a, { opened: at(today, '20:00'), billed: at(today, '20:30'), item: 'ZZ Prawns', qty: 1, paisa: 5000, covers: 3, table: true, close: null })
  await db.execute(q`INSERT INTO print_jobs (tenant_id, session_id, destination, bill_id, ticket)
    VALUES (${a.id}, ${B.id}, 'cashier', ${B.bill}, '{"kind":"receipt","title":"BILL","destination":"cashier","tableLabels":["ZZ R03"]}'::jsonb)`)
  const C = await order(a, { opened: at(today, '20:45'), billed: at(today, '21:00'), item: 'ZZ Kottu', qty: 1, paisa: 3000, close: 'walkout' })
  // Comps count once on a bill (the slip's definition); one on no bill does not.
  const comp = (await one(q`INSERT INTO comp_records (session_id, order_event_id, staff_id, authorized_by_staff_id, amount_paisa, reason)
    VALUES (${A.id}, ${A.event}, ${a.owner}, ${a.owner}, 1000, 'ZZ Kitchen error') RETURNING id`)).id
  await db.execute(q`INSERT INTO bill_comps (bill_id, comp_record_id, amount_paisa) VALUES (${A.bill}, ${comp}, 1000)`)
  await db.execute(q`INSERT INTO comp_records (session_id, order_event_id, staff_id, authorized_by_staff_id, amount_paisa, reason)
    VALUES (${C.id}, ${C.event}, ${a.owner}, ${a.owner}, 500, 'ZZ Not billed')`)
  await db.execute(q`INSERT INTO cash_counts (tenant_id, business_date, counted_paisa, staff_id) VALUES (${a.id}, ${today}, 5000, ${a.owner})`)
  // Yesterday.
  const Y = await order(a, { opened: at(shift(-1), '19:00'), billed: at(shift(-1), '19:30'), item: 'ZZ Beer', qty: 1, paisa: 7000 })
  await pay(Y.id, Y.bill, a.owner, 'transfer', 7000)
  // A week ago, just before "now − 7 days": inside the live comparison.
  await order(a, { opened: q`now() - interval '7 days' - interval '2 minutes'`, billed: q`now() - interval '7 days' - interval '1 minute'`, item: 'ZZ Old', qty: 1, paisa: 9000 })
  // Another tenant, today.
  await order(other, { opened: at(today, '19:00'), billed: at(today, '19:05'), item: 'ZZ Theirs', qty: 1, paisa: 99900 })

  check('the test orders are on today', A.date === today && B.date === today && C.date === today, `${A.date} ${today}`)

  const t = await loadInsights(db, a.id, 'today')
  check('recorded today 18,000 (three bills)', t.recorded.paisa === 18000, String(t.recorded.paisa))
  check('vs last week at this time: 9,000 → +100%', t.recorded.comparePaisa === 9000 && t.recorded.changePercent === 100,
    JSON.stringify(t.recorded))
  check('compare label names the weekday', /^vs last (Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(t.compareLabel), t.compareLabel)
  const slot = (h: number) => t.buckets.items.find((i) => i.key === String((h - 4 + 24) % 24))?.paisa
  check('hour buckets: 19h 10,000 · 20h 5,000 · 21h 3,000; peak 19', slot(19) === 10000 && slot(20) === 5000 && slot(21) === 3000 &&
    t.buckets.peakKey === String(19 - 4) && t.buckets.kind === 'hour', JSON.stringify(t.buckets))
  check('payments: cash 6,000 card 4,000, settled 10,000', t.payments.cashPaisa === 6000 && t.payments.cardPaisa === 4000 &&
    t.payments.transferPaisa === 0 && t.payments.settledPaisa === 10000)
  check('covers 6, avg 3,000', t.covers.count === 6 && t.covers.averagePaisa === 3000, JSON.stringify(t.covers))
  check('comps 1,000 · 5.6% · 1 line · by reason with approver', t.comps.totalPaisa === 1000 && t.comps.percentOfRevenue === 5.6 &&
    t.comps.lines === 1 && t.comps.byReason[0]?.reason === 'ZZ Kitchen error' && t.comps.byReason[0]?.approver === 'ZZ Owner',
    JSON.stringify(t.comps))
  check('top items: Kottu ×3 13,000, then Prawns 5,000', JSON.stringify(t.topItems.map((i) => [i.name, i.quantity, i.paisa])) ===
    JSON.stringify([['ZZ Kottu', 3, 13000], ['ZZ Prawns', 1, 5000]]))
  check('cash: expected 6,000, counted 5,000 → gap -1,000, by ZZ Owner', t.cash.expectedPaisa === 6000 && t.cash.gapPaisa === -1000 &&
    t.cash.count?.countedBy === 'ZZ Owner' && t.cash.daysCounted === 1 && t.cash.days === 1, JSON.stringify(t.cash))
  const unclosed = t.audit.find((r) => r.kind === 'unclosed')
  const walkout = t.audit.find((r) => r.kind === 'walkout')
  check('audit: open order with a printed bill is unclosed', !!unclosed && unclosed.detail === 'Bill printed, not settled' &&
    unclosed.title === `#${String(B.number).padStart(3, '0')} · ZZ R03`, JSON.stringify(unclosed))
  check('audit: the walkout, with what it owed', !!walkout && walkout.amountPaisa === 3000, JSON.stringify(walkout))
  check('restaurant name from the config', t.restaurantName === 'ZZ Insights verify')

  check('sales: 3 orders, billed 18,000, paid 10,000, matches recorded', t.sales.orders === 3 && t.sales.billedPaisa === 18000 &&
    t.sales.paid.totalPaisa === 10000 && t.sales.compsPaisa === 1000, JSON.stringify(t.sales))
  check('single day carries its no-sale openings', Array.isArray(t.noSales))

  const y = await loadInsights(db, a.id, 'yesterday')
  check('yesterday: 7,000 by transfer, nothing to compare', y.recorded.paisa === 7000 && y.payments.transferPaisa === 7000 &&
    y.recorded.changePercent === null && y.cash.gapPaisa === null && y.audit.length === 0)

  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
  const w = await loadInsights(db, a.id, 'week')
  check('week: Monday → today, by day', w.buckets.kind === 'day' && w.buckets.items.length === dow + 1 &&
    w.recorded.paisa === 18000 + (dow >= 1 ? 7000 : 0), JSON.stringify({ n: w.buckets.items.length, r: w.recorded.paisa }))
  const m = await loadInsights(db, a.id, 'month')
  check('month: 1st → today', m.from === `${today.slice(0, 8)}01` && m.to === today && m.buckets.items.length === Number(today.slice(8)))

  check('week has no no-sale list', w.noSales === null)
  const picked = await loadInsights(db, a.id, 'day', shift(-1))
  check('a picked day that is yesterday becomes the Yesterday tab', picked.period === 'yesterday' && picked.recorded.paisa === 7000)
  const past = await loadInsights(db, a.id, 'day', shift(-3))
  check('a past day: one day, compared with the same weekday before', past.period === 'day' && past.from === shift(-3) &&
    past.to === shift(-3) && past.buckets.kind === 'hour' && /^vs the \w{3} before$/.test(past.compareLabel), past.compareLabel)
  let future = false
  try {
    await loadInsights(db, a.id, 'day', shift(1))
  } catch (error) {
    future = error instanceof MenuRuleError
  }
  check('a day after today is refused', future)

  const theirs = await loadInsights(db, other.id, 'today')
  check('the other tenant sees only its own', theirs.recorded.paisa === 99900 && theirs.topItems[0]?.name === 'ZZ Theirs')

  let refused = false
  try {
    checkPeriod('fortnight')
  } catch (error) {
    refused = error instanceof MenuRuleError
  }
  check('an unknown period is refused', refused && checkPeriod(null) === 'today')
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = ((await db.execute(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Insights %'`)).rows as any[]).map((r) => r.id)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  const sessions = q`(select id from order_sessions where tenant_id = any(${all}::uuid[]))`
  const guarded = [
    ['bill_comps', 'immutable_bill_comps'],
    ['comp_records', 'immutable_comp_records'],
    ['payment_records', 'immutable_payment_records'],
    ['bill_lines', 'immutable_bill_lines'],
    ['bills', 'immutable_bills'],
    ['order_events', 'immutable_order_events'],
    ['cash_counts', 'immutable_cash_counts'],
  ] as const
  try {
    for (const [table, trigger] of guarded) await db.execute(q.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))
    await db.execute(q`DELETE FROM bill_comps WHERE bill_id IN (select id from bills where tenant_id = any(${all}::uuid[]))`)
    await db.execute(q`DELETE FROM comp_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM payment_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM print_jobs WHERE tenant_id = any(${all}::uuid[])`)
    await db.execute(q`DELETE FROM bill_lines WHERE bill_id IN (select id from bills where tenant_id = any(${all}::uuid[]))`)
    await db.execute(q`DELETE FROM bills WHERE tenant_id = any(${all}::uuid[])`)
    await db.execute(q`DELETE FROM order_events WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM cash_counts WHERE tenant_id = any(${all}::uuid[])`)
  } finally {
    for (const [table, trigger] of guarded) {
      await db.execute(q.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)).catch((error) =>
        console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error))
    }
  }
  await db.execute(q`DELETE FROM order_session_tables WHERE session_id IN ${sessions}`)
  await db.execute(q`DELETE FROM order_sessions WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM order_number_counters WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM tables WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM zones WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM staff WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM tenant_config WHERE tenant_id = any(${all}::uuid[])`)
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
