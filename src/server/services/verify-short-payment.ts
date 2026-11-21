/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Short payment (Teran, 2026-11-21) — through the service, on a throwaway tenant.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-short-payment.ts
 *
 * No dev server needed. A guest pays LKR 800 of a LKR 1,000 bill and the
 * cashier writes the rest off with a note: the bill is settled, the table can
 * close, takings count only the 800, and Orders and Audit show the 200. Then
 * the guards: no note is a part payment, the database refuses an empty note and
 * a second short.
 */
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { assertCloseMatchesPayment, isFullyPaid, recordPayments } from '@/server/services/payment.service'
import { loadTakings } from '@/server/services/takings.service'
import { listOrders } from '@/server/services/orders-list.service'
import { loadOrderStory } from '@/server/services/audit.service'
import { getBill } from '@/server/services/bill.service'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const rows = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows as any[]
const one = async (text: ReturnType<typeof q>) => (await rows(text))[0]

const DAY = '2026-01-15'
const tenantIds: string[] = []

async function setup() {
  const tenantId = (await one(q`INSERT INTO tenants (name) VALUES ('ZZ Short verify') RETURNING id`)).id as string
  tenantIds.push(tenantId)
  const waiter = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash)
    VALUES (${tenantId}, 'ZZ Wendy', 'waiter', 'x') RETURNING id`)).id as string
  const zone = (await one(q`INSERT INTO zones (tenant_id, name) VALUES (${tenantId}, 'ZZ Zone') RETURNING id`)).id as string
  return { tenantId, waiter, zone }
}

/** An open order on its own table, with one item of `price`, billed whole. */
async function billedOrder(t: Awaited<ReturnType<typeof setup>>, price: number) {
  const table = (await one(q`INSERT INTO tables (tenant_id, zone_id, label)
    VALUES (${t.tenantId}, ${t.zone}, ${`ZZ T${Math.random().toString(36).slice(2, 6)}`}) RETURNING id`)).id as string
  const session = await one(q`INSERT INTO order_sessions (tenant_id, table_id, kind, opened_by_staff_id, opened_at)
    VALUES (${t.tenantId}, ${table}, 'table', ${t.waiter}, ${`${DAY} 20:00+05:30`}::timestamptz)
    RETURNING id, business_date::text AS business_date`)
  await rows(q`INSERT INTO order_session_tables (session_id, table_id) VALUES (${session.id}, ${table})`)
  const event = await one(q`INSERT INTO order_events (session_id, staff_id, event_type, quantity, unit_price_paisa, custom_name)
    VALUES (${session.id}, ${t.waiter}, 'ITEM_ADDED', 1, ${price}, 'ZZ item') RETURNING id`)
  const bill = await one(q`INSERT INTO bills (tenant_id, session_id, staff_id, type, subtotal_paisa, service_charge_paisa,
      tax_paisa, total_paisa, service_charge_bp, tax_bp)
    VALUES (${t.tenantId}, ${session.id}, ${t.waiter}, 'consolidated', ${price}, 0, 0, ${price}, 0, 0) RETURNING id`)
  await rows(q`INSERT INTO bill_lines (bill_id, order_event_id, quantity, amount_paisa, name)
    VALUES (${bill.id}, ${event.id}, 1, ${price}, 'ZZ dish')`)
  return { sessionId: session.id as string, billId: bill.id as string, businessDate: session.business_date as string }
}

async function refused(run: () => Promise<unknown>) {
  try {
    await run()
    return false
  } catch {
    return true
  }
}

async function run() {
  const t = await setup()

  // ── A short cash payment closes the bill ─────────────────────────────────
  const a = await billedOrder(t, 100_000)
  const paid = await db.transaction((tx) =>
    recordPayments(tx, {
      billId: a.billId,
      staffId: t.waiter,
      tenders: [{ method: 'cash', amountPaisa: 80_000 }],
      cashReceivedPaisa: 80_000,
      shortNote: 'guest had no more cash',
    }),
  )
  check('short: settled, all paid, nothing outstanding', paid.settled && paid.allPaid && paid.outstandingPaisa === 0,
    JSON.stringify(paid))
  const bill = await getBill(db, a.billId)
  check('short: 200 and the note on the bill', bill?.shortPaisa === 20_000 && bill?.shortNote === 'guest had no more cash')
  check('short: isFullyPaid', await isFullyPaid(db, a.sessionId))
  check('short: closing as settled is accepted',
    !(await refused(() => db.transaction((tx) => assertCloseMatchesPayment(tx, { sessionId: a.sessionId, reason: 'settled' })))))
  check('short: a second payment is refused as already settled',
    await refused(() => db.transaction((tx) =>
      recordPayments(tx, { billId: a.billId, staffId: t.waiter, tenders: [{ method: 'card', amountPaisa: 100 }] }))))

  // ── Takings count only what was received ─────────────────────────────────
  const takings = await loadTakings(db, { tenantId: t.tenantId, businessDate: DAY })
  check('takings: only the 800 cash', takings.paid.cashPaisa === 80_000 && takings.paid.totalPaisa === 80_000,
    JSON.stringify(takings.paid))

  // ── Orders and Audit show it ─────────────────────────────────────────────
  const list = await listOrders({ tenantId: t.tenantId, from: a.businessDate, to: a.businessDate })
  const row = list.orders.find((order) => order.sessionId === a.sessionId)
  check('orders: shortPaisa 200', row?.shortPaisa === 20_000, JSON.stringify(row))
  const story = await loadOrderStory(t.tenantId, a.sessionId)
  const entry = story?.entries.find((e) => e.text.startsWith('Short payment'))
  check('audit: a red (negative) short entry with the note',
    entry?.amountPaisa === -20_000 && entry?.detail === 'guest had no more cash' && entry?.staffName === 'ZZ Wendy',
    JSON.stringify(entry))

  // ── Card short ───────────────────────────────────────────────────────────
  const c = await billedOrder(t, 50_000)
  const card = await db.transaction((tx) =>
    recordPayments(tx, { billId: c.billId, staffId: t.waiter, tenders: [{ method: 'card', amountPaisa: 45_000 }], shortNote: 'card limit' }))
  check('card short: settled with 50 short', card.settled && (await getBill(db, c.billId))?.shortPaisa === 5_000)

  // ── Without a note it is a part payment, as before ───────────────────────
  const b = await billedOrder(t, 100_000)
  const part = await db.transaction((tx) =>
    recordPayments(tx, { billId: b.billId, staffId: t.waiter, tenders: [{ method: 'cash', amountPaisa: 80_000 }] }))
  check('no note: part payment, 200 still owed, no short',
    !part.settled && part.outstandingPaisa === 20_000 && (await getBill(db, b.billId))?.shortPaisa === 0)

  // ── The database guards ──────────────────────────────────────────────────
  check('db: an empty note is refused',
    await refused(() => db.execute(q`UPDATE bills SET short_paisa = 100, short_note = '  ', short_by_staff_id = ${t.waiter}, short_at = now()
      WHERE id = ${b.billId}`)))
  check('db: a second short on the same bill is refused',
    await refused(() => db.execute(q`UPDATE bills SET short_paisa = 1, short_note = 'again', short_by_staff_id = ${t.waiter}, short_at = now()
      WHERE id = ${a.billId}`)))
  check('db: other columns still cannot change',
    await refused(() => db.execute(q`UPDATE bills SET total_paisa = 1 WHERE id = ${b.billId}`)))
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = (await rows(q`SELECT id FROM tenants WHERE name = 'ZZ Short verify'`)).map((r) => r.id as string)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  const guarded = [
    ['payment_records', 'immutable_payment_records'],
    ['bill_lines', 'immutable_bill_lines'],
    ['bills', 'immutable_bills'],
    ['order_events', 'immutable_order_events'],
  ] as const
  const sessions = q`(select id from order_sessions where tenant_id = any(${all}::uuid[]))`
  try {
    for (const [table, trigger] of guarded) await db.execute(q.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))
    await db.execute(q`DELETE FROM payment_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM bill_lines WHERE bill_id IN (select id from bills where tenant_id = any(${all}::uuid[]))`)
    await db.execute(q`DELETE FROM bills WHERE tenant_id = any(${all}::uuid[])`)
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
