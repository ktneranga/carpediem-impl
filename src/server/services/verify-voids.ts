/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Story 7.5 — void a sent item, cancel an unpaid bill, through the services, on
 * a throwaway tenant.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-voids.ts
 *
 * No dev server needed. A `ZZ Voids verify` tenant with an owner (PIN 1111), a
 * waiter (2222), a kitchen dish and a custom charge on one table order. Checks
 * the void rules, the database guards, approval and lockout, the VOID ticket,
 * bill cancellation, and that the Dashboard and the slip leave both out.
 *
 * Cleanup on a local database only, with the append-only guards off just
 * around the deletes.
 */
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { dishCount } from '@/server/orders/item-count'
import { orderEvents } from '@/server/db/schema'
import { and, eq } from 'drizzle-orm'
import {
  generateConsolidatedBill,
  generateSeatBill,
  hasUnbilledItems,
} from '@/server/services/bill.service'
import { loadInsights } from '@/server/services/insights.service'
import { BillCancelledError, recordPayments } from '@/server/services/payment.service'
import { loadSales } from '@/server/services/takings.service'
import {
  BillAlreadyCancelledError,
  BillHasPaymentsError,
  cancelBill,
  resetWrongPinsForTests,
  resolveApproval,
  VoidNotEnoughUnitsError,
  voidItem,
} from '@/server/services/void.service'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const rows = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows as any[]
const one = async (text: ReturnType<typeof q>) => (await rows(text))[0]
const tenantIds: string[] = []

async function refuses(fn: () => Promise<unknown>, test: (error: unknown) => boolean): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (error) {
    return test(error)
  }
}
const pgConstraint = (name: string) => (error: unknown) => {
  for (let current: any = error, depth = 0; current && depth < 5; depth += 1, current = current.cause) {
    if (current?.constraint === name) return true
  }
  return false
}
const immutable = (error: unknown) => {
  for (let current: any = error, depth = 0; current && depth < 5; depth += 1, current = current.cause) {
    if (String(current?.message ?? '').includes('[immutable-table]')) return true
  }
  return false
}

async function setup() {
  const tenantId = (await one(q`INSERT INTO tenants (name) VALUES ('ZZ Voids verify') RETURNING id`)).id as string
  tenantIds.push(tenantId)
  await rows(q`INSERT INTO tenant_config (tenant_id, restaurant_name) VALUES (${tenantId}, 'ZZ Voids verify')`)
  const ownerHash = await bcrypt.hash('1111', 4)
  const waiterHash = await bcrypt.hash('2222', 4)
  const owner = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash) VALUES (${tenantId}, 'ZZ Olga', 'owner', ${ownerHash}) RETURNING id`)).id as string
  const waiter = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash) VALUES (${tenantId}, 'ZZ Wendy', 'waiter', ${waiterHash}) RETURNING id`)).id as string
  const zone = (await one(q`INSERT INTO zones (tenant_id, name) VALUES (${tenantId}, 'ZZ Zone') RETURNING id`)).id as string
  const table = (await one(q`INSERT INTO tables (tenant_id, zone_id, label) VALUES (${tenantId}, ${zone}, 'ZZ T1') RETURNING id`)).id as string
  const category = (await one(q`INSERT INTO menu_categories (tenant_id, name) VALUES (${tenantId}, 'ZZ Cat') RETURNING id`)).id as string
  const rice = (await one(q`INSERT INTO menu_items (tenant_id, category_id, name, price_paisa, production_destination)
    VALUES (${tenantId}, ${category}, 'ZZ Fried Rice', 1000, 'kitchen') RETURNING id`)).id as string
  return { tenantId, owner, waiter, table, rice }
}
type T = Awaited<ReturnType<typeof setup>>

let tableNumber = 1

/** An open table order: round 1 with `qty` × rice on seat 1 (and a custom charge), plus a second seat. */
async function openOrder(t: T, qty: number) {
  // Its own table: one open order per table.
  const zone = (await one(q`SELECT zone_id FROM tables WHERE id = ${t.table}`)).zone_id as string
  const table = (await one(q`INSERT INTO tables (tenant_id, zone_id, label) VALUES (${t.tenantId}, ${zone}, ${`ZZ T${++tableNumber}`}) RETURNING id`)).id as string
  const session = (await one(q`INSERT INTO order_sessions (tenant_id, table_id, kind, opened_by_staff_id)
    VALUES (${t.tenantId}, ${table}, 'table', ${t.waiter}) RETURNING id`)).id as string
  await rows(q`INSERT INTO order_session_tables (session_id, table_id) VALUES (${session}, ${table})`)
  const seat1 = (await one(q`INSERT INTO seat_slots (session_id, seat_label) VALUES (${session}, 'Seat 1') RETURNING id`)).id as string
  const seat2 = (await one(q`INSERT INTO seat_slots (session_id, seat_label) VALUES (${session}, 'Seat 2') RETURNING id`)).id as string
  await rows(q`INSERT INTO order_rounds (id, session_id, round_number, staff_id, item_count) VALUES (${randomUUID()}, ${session}, 1, ${t.waiter}, ${qty + 2})`)
  const rice = (await one(q`INSERT INTO order_events (session_id, staff_id, menu_item_id, event_type, quantity, unit_price_paisa, round_number, seat_slot_id)
    VALUES (${session}, ${t.waiter}, ${t.rice}, 'ITEM_ADDED', ${qty}, 1000, 1, ${seat1}) RETURNING id`)).id as string
  const corkage = (await one(q`INSERT INTO order_events (session_id, staff_id, event_type, quantity, unit_price_paisa, custom_name, round_number, seat_slot_id)
    VALUES (${session}, ${t.waiter}, 'ITEM_ADDED', 1, 500, 'ZZ Corkage', 1, ${seat1}) RETURNING id`)).id as string
  const seat2Dish = (await one(q`INSERT INTO order_events (session_id, staff_id, menu_item_id, event_type, quantity, unit_price_paisa, round_number, seat_slot_id)
    VALUES (${session}, ${t.waiter}, ${t.rice}, 'ITEM_ADDED', 1, 1000, 1, ${seat2}) RETURNING id`)).id as string
  return { session, seat1, seat2, rice, corkage, seat2Dish }
}

const dishes = async (sessionId: string) =>
  Number((await db.select({ n: dishCount }).from(orderEvents).where(and(eq(orderEvents.sessionId, sessionId), eq(orderEvents.eventType, 'ITEM_ADDED'))))[0]?.n ?? 0)

async function run() {
  const t = await setup()
  const o = await openOrder(t, 3)
  const base = { sessionId: o.session, staffId: t.waiter, approverId: t.owner, note: null }

  // ── Voids ────────────────────────────────────────────────────────────────
  const first = await db.transaction((tx) =>
    voidItem(tx, { ...base, orderEventId: o.rice, quantity: 1, reason: 'Entered by mistake', requestId: randomUUID() }))
  check('void 1 of 3 rice: written, ticket queued', first.quantity === 1 && first.ticketNeeded && first.ticketQueued, JSON.stringify(first))
  const row = await one(q`SELECT * FROM order_events WHERE id = ${first.voidId}`)
  check('the void row: ITEM_VOIDED, linked, requester and approver, reason',
    row.event_type === 'ITEM_VOIDED' && row.voids_event_id === o.rice && row.staff_id === t.waiter &&
    row.approved_by_staff_id === t.owner && row.notes === 'Entered by mistake' && row.quantity === 1 && row.menu_item_id === t.rice)
  const original = await one(q`SELECT quantity FROM order_events WHERE id = ${o.rice}`)
  check('the original line is untouched', original.quantity === 3)
  const job = await one(q`SELECT ticket FROM print_jobs WHERE session_id = ${o.session} ORDER BY created_at DESC LIMIT 1`)
  check('the VOID ticket: void, kitchen, 1 × the dish, round 1, the table',
    job?.ticket?.void === true && job.ticket.destination === 'kitchen' && job.ticket.lines?.[0]?.quantity === 1 &&
    job.ticket.lines[0].name === 'ZZ Fried Rice' && job.ticket.roundNumber === 1 && job.ticket.tableLabels?.[0] === 'ZZ T2',
    JSON.stringify(job?.ticket))
  check('dish count drops by the void (3 + 1 + 1 → 4)', (await dishes(o.session)) === 4, String(await dishes(o.session)))

  const replayId = randomUUID()
  const r1 = await db.transaction((tx) => voidItem(tx, { ...base, orderEventId: o.rice, quantity: 1, reason: 'Other', note: 'dropped', requestId: replayId }))
  const r2 = await db.transaction((tx) => voidItem(tx, { ...base, orderEventId: o.rice, quantity: 1, reason: 'Other', note: 'dropped', requestId: replayId }))
  const voidCount = (await one(q`SELECT count(*)::int AS n FROM order_events WHERE voids_event_id = ${o.rice}`)).n
  check('a replay with the same requestId writes once', r1.voidId === r2.voidId && voidCount === 2, String(voidCount))
  check('"Other" stores the note as the reason', (await one(q`SELECT notes FROM order_events WHERE id = ${r1.voidId}`)).notes === 'dropped')

  check('over-void refused by the service (1 left, 2 asked)',
    await refuses(() => db.transaction((tx) => voidItem(tx, { ...base, orderEventId: o.rice, quantity: 2, reason: 'Entered by mistake', requestId: randomUUID() })),
      (e) => e instanceof VoidNotEnoughUnitsError && e.unitsLeft === 1))
  check('over-void refused by the trigger (direct insert)',
    await refuses(() => rows(q`INSERT INTO order_events (session_id, staff_id, approved_by_staff_id, event_type, voids_event_id, quantity)
      VALUES (${o.session}, ${t.waiter}, ${t.owner}, 'ITEM_VOIDED', ${o.rice}, 2)`), pgConstraint('order_event_void_within_quantity')))
  check('a void without an approver is refused by the CHECK',
    await refuses(() => rows(q`INSERT INTO order_events (session_id, staff_id, event_type, voids_event_id, quantity)
      VALUES (${o.session}, ${t.waiter}, 'ITEM_VOIDED', ${o.rice}, 1)`), pgConstraint('order_events_void_shape')))

  const custom = await db.transaction((tx) => voidItem(tx, { ...base, orderEventId: o.corkage, quantity: 1, reason: 'Guest changed mind', requestId: randomUUID() }))
  check('a custom charge voids with no ticket', !custom.ticketNeeded && !custom.ticketQueued)

  // ── Approval ─────────────────────────────────────────────────────────────
  resetWrongPinsForTests()
  const self = await resolveApproval({ staffId: t.owner, role: 'owner', tenantId: t.tenantId, approverPin: undefined })
  check('an owner approves their own void', self.ok && self.approverId === t.owner)
  const none = await resolveApproval({ staffId: t.waiter, role: 'waiter', tenantId: t.tenantId, approverPin: undefined })
  check('a waiter without a PIN is asked for one', !none.ok && none.code === 'APPROVAL_REQUIRED')
  const waiterPin = await resolveApproval({ staffId: t.waiter, role: 'waiter', tenantId: t.tenantId, approverPin: '2222' })
  check("a waiter's own PIN approves nothing", !waiterPin.ok && waiterPin.code === 'INVALID_PIN')
  const ownerPin = await resolveApproval({ staffId: t.waiter, role: 'waiter', tenantId: t.tenantId, approverPin: '1111' })
  check("the owner's PIN approves", ownerPin.ok && ownerPin.approverId === t.owner && ownerPin.staffId === t.waiter)
  for (let i = 0; i < 5; i += 1) await resolveApproval({ staffId: t.waiter, role: 'waiter', tenantId: t.tenantId, approverPin: '9999' })
  const locked = await resolveApproval({ staffId: t.waiter, role: 'waiter', tenantId: t.tenantId, approverPin: '1111' })
  check('5 wrong PINs lock the requester, even with the right PIN next', !locked.ok && locked.code === 'PIN_LOCKED' && locked.status === 429)
  resetWrongPinsForTests()

  // ── Bills and cancellation ───────────────────────────────────────────────
  const bill = await db.transaction((tx) => generateConsolidatedBill(tx, { sessionId: o.session, staffId: t.waiter }))
  const riceLine = bill.lines.find((line) => line.orderEventId === o.rice)
  check('the bill takes only the unvoided rice (1 of 3) and no corkage',
    riceLine?.quantity === 1 && !bill.lines.some((line) => line.orderEventId === o.corkage), JSON.stringify(bill.lines.map((l) => [l.name, l.quantity])))
  check('nothing left to bill', !(await hasUnbilledItems(db, o.session)))
  check('a billed unit cannot be voided',
    await refuses(() => db.transaction((tx) => voidItem(tx, { ...base, orderEventId: o.rice, quantity: 1, reason: 'Entered by mistake', requestId: randomUUID() })),
      (e) => e instanceof VoidNotEnoughUnitsError && e.unitsLeft === 0))

  const salesBefore = await loadSales(db, { tenantId: t.tenantId, from: '2000-01-01', to: '2100-01-01' })
  check('sales count the live bill', salesBefore.billedPaisa === bill.totalPaisa, `${salesBefore.billedPaisa} vs ${bill.totalPaisa}`)

  const cancelled = await db.transaction((tx) => cancelBill(tx, { billId: bill.billId, reason: 'Wrong item on it', note: null, staffId: t.waiter, approverId: t.owner }))
  const stamped = await one(q`SELECT cancelled_at, cancelled_by_staff_id, cancel_approved_by_staff_id, cancel_reason, total_paisa FROM bills WHERE id = ${bill.billId}`)
  check('cancel stamps the bill: who, approver, reason', cancelled.sessionId === o.session && stamped.cancelled_at !== null &&
    stamped.cancelled_by_staff_id === t.waiter && stamped.cancel_approved_by_staff_id === t.owner && stamped.cancel_reason === 'Wrong item on it')
  check('its items are billable again', await hasUnbilledItems(db, o.session))
  check('a second cancel is refused',
    await refuses(() => db.transaction((tx) => cancelBill(tx, { billId: bill.billId, reason: 'Other', note: 'x', staffId: t.waiter, approverId: t.owner })),
      (e) => e instanceof BillAlreadyCancelledError))
  check('a payment on the cancelled bill is refused',
    await refuses(() => db.transaction((tx) => recordPayments(tx, { billId: bill.billId, staffId: t.waiter, tenders: [{ method: 'cash', amountPaisa: 100 }] })),
      (e) => e instanceof BillCancelledError))
  check('any other UPDATE on bills still raises',
    await refuses(() => rows(q`UPDATE bills SET total_paisa = 1 WHERE id = ${bill.billId}`), immutable))
  check('DELETE on bills still raises', await refuses(() => rows(q`DELETE FROM bills WHERE id = ${bill.billId}`), immutable))
  check('the cancel stamp cannot be changed', await refuses(() => rows(q`UPDATE bills SET cancel_reason = 'edited' WHERE id = ${bill.billId}`), immutable))

  // Void the last rice now that the bill is gone, then bill again.
  await db.transaction((tx) => voidItem(tx, { ...base, orderEventId: o.rice, quantity: 1, reason: 'Entered by mistake', requestId: randomUUID() }))
  const second = await db.transaction((tx) => generateConsolidatedBill(tx, { sessionId: o.session, staffId: t.waiter }))
  check('a new bill after the cancel: rice gone, seat 2 dish only',
    second.lines.length === 1 && second.lines[0]!.orderEventId === o.seat2Dish, JSON.stringify(second.lines.map((l) => [l.name, l.quantity])))
  const salesAfter = await loadSales(db, { tenantId: t.tenantId, from: '2000-01-01', to: '2100-01-01' })
  check('sales ignore the cancelled bill', salesAfter.billedPaisa === second.totalPaisa, `${salesAfter.billedPaisa} vs ${second.totalPaisa}`)

  await db.transaction((tx) => recordPayments(tx, { billId: second.billId, staffId: t.waiter, tenders: [{ method: 'cash', amountPaisa: second.totalPaisa }] }))
  let paidError: unknown = null
  try {
    await db.transaction((tx) => cancelBill(tx, { billId: second.billId, reason: 'Other', note: 'x', staffId: t.waiter, approverId: t.owner }))
  } catch (error) {
    paidError = error
  }
  check('a bill with payments cannot be cancelled', paidError instanceof BillHasPaymentsError, String(paidError))

  // ── A cancelled SEAT bill frees the seat ─────────────────────────────────
  const o2 = await openOrder(t, 1)
  const seatBill = await db.transaction((tx) => generateSeatBill(tx, { sessionId: o2.session, seatId: o2.seat2, staffId: t.waiter }))
  await db.transaction((tx) => cancelBill(tx, { billId: seatBill.billId, reason: 'Guest wants it split differently', note: null, staffId: t.owner, approverId: t.owner }))
  const again = await db.transaction((tx) => generateSeatBill(tx, { sessionId: o2.session, seatId: o2.seat2, staffId: t.waiter }))
  check('the same seat is billed again after its bill is cancelled', again.billId !== seatBill.billId && again.totalPaisa === seatBill.totalPaisa)

  // ── Dashboard ────────────────────────────────────────────────────────────
  const today = await loadInsights(db, t.tenantId, 'today')
  const voids = today.audit.filter((entry) => entry.kind === 'correction' && entry.detail.startsWith('Voided'))
  const cancels = today.audit.filter((entry) => entry.kind === 'cancelled')
  check('the dashboard lists every void, with requester and approver',
    voids.length === 4 && voids.some((entry) => entry.detail.includes('1 × ZZ Fried Rice (Entered by mistake) · ZZ Wendy, approved by ZZ Olga')),
    JSON.stringify(voids.map((v) => v.detail)))
  check('the dashboard lists both cancelled bills; an owner self-approval shows once',
    cancels.length === 2 && cancels.some((entry) => entry.detail === 'Bill cancelled (Guest wants it split differently) · ZZ Olga'),
    JSON.stringify(cancels.map((c) => c.detail)))
  check("the dashboard's revenue ignores cancelled bills",
    today.recorded.paisa === second.totalPaisa + again.totalPaisa, `${today.recorded.paisa}`)
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = (await rows(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Voids %'`)).map((r) => r.id as string)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  const guarded = [
    ['bill_comps', 'immutable_bill_comps'],
    ['payment_records', 'immutable_payment_records'],
    ['bill_lines', 'immutable_bill_lines'],
    ['bills', 'immutable_bills'],
    ['order_events', 'immutable_order_events'],
    ['order_rounds', 'immutable_order_rounds'],
    ['cash_drawer_openings', 'immutable_cash_drawer_openings'],
  ] as const
  const sessions = q`(select id from order_sessions where tenant_id = any(${all}::uuid[]))`
  try {
    for (const [table, trigger] of guarded) await db.execute(q.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))
    await db.execute(q`DELETE FROM payment_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM cash_drawer_openings WHERE tenant_id = any(${all}::uuid[])`)
    await db.execute(q`DELETE FROM bill_lines WHERE bill_id IN (select id from bills where tenant_id = any(${all}::uuid[]))`)
    await db.execute(q`DELETE FROM bills WHERE tenant_id = any(${all}::uuid[])`)
    await db.execute(q`DELETE FROM print_jobs WHERE tenant_id = any(${all}::uuid[])`)
    // Voids first: they reference the lines they void.
    await db.execute(q`DELETE FROM order_events WHERE session_id IN ${sessions} AND voids_event_id IS NOT NULL`)
    await db.execute(q`DELETE FROM order_events WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM order_rounds WHERE session_id IN ${sessions}`)
  } finally {
    for (const [table, trigger] of guarded) {
      await db.execute(q.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)).catch((error) =>
        console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error),
      )
    }
  }
  await db.execute(q`DELETE FROM seat_slots WHERE session_id IN ${sessions}`)
  await db.execute(q`DELETE FROM order_session_tables WHERE session_id IN ${sessions}`)
  await db.execute(q`DELETE FROM order_sessions WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM order_number_counters WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM menu_items WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM menu_categories WHERE tenant_id = any(${all}::uuid[])`)
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
