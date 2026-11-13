/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Story 9.2 — takings by hour, through the service, on throwaway tenants.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-revenue.ts
 *
 * Colombo, turnover 4 AM. Payments at 8 PM and 1 AM of today's business day,
 * 9 PM yesterday, one two days ago and one in another tenant. Checks the
 * slots, the totals, and what is excluded. Local cleanup only.
 */
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { revenueByHour } from '@/server/services/dashboard.service'

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
  const staffId = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash) VALUES (${id}, 'ZZ', 'owner', 'x') RETURNING id`)).id
  return { id, staffId: staffId as string }
}

/** A counter order opened at `openedAt` (Colombo) with one payment at `paidAt`. */
async function paidOrder(t: { id: string; staffId: string }, openedAt: string, paidAt: string, paisa: number) {
  const s = await one(q`INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, opened_at)
    VALUES (${t.id}, 'counter', ${t.staffId}, ${openedAt}::timestamptz) RETURNING id, business_date::text AS d`)
  const b = await one(q`INSERT INTO bills (tenant_id, session_id, staff_id, type, subtotal_paisa, service_charge_paisa,
      tax_paisa, total_paisa, service_charge_bp, tax_bp)
    VALUES (${t.id}, ${s.id}, ${t.staffId}, 'consolidated', ${paisa}, 0, 0, ${paisa}, 0, 0) RETURNING id`)
  await db.execute(q`INSERT INTO payment_records (session_id, bill_id, staff_id, amount_paisa, method, created_at)
    VALUES (${s.id}, ${b.id}, ${t.staffId}, ${paisa}, 'cash', ${paidAt}::timestamptz)`)
  return s.d as string
}

const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function run() {
  const a = await tenant('ZZ Revenue verify')
  const other = await tenant('ZZ Revenue other')
  const today = (await one(q`SELECT business_date_at(${a.id}, now())::text AS d`)).d as string

  const d1 = await paidOrder(a, `${today} 19:30+05:30`, `${today} 20:10+05:30`, 1000)
  await paidOrder(a, `${today} 23:30+05:30`, `${shift(today, 1)} 01:20+05:30`, 500)
  await paidOrder(a, `${shift(today, -1)} 21:00+05:30`, `${shift(today, -1)} 21:40+05:30`, 700)
  await paidOrder(a, `${shift(today, -2)} 21:00+05:30`, `${shift(today, -2)} 21:40+05:30`, 9999)
  await paidOrder(other, `${today} 20:00+05:30`, `${today} 20:30+05:30`, 8888)
  check('the test orders land on today', d1 === today, `${d1} vs ${today}`)

  const r = await revenueByHour(db, a.id)
  check('starts at the 4 AM turnover', r.startHour === 4)
  check('8 PM is slot 16', r.today.hours[16] === 1000, JSON.stringify(r.today.hours))
  check('1 AM is slot 21 — after 11 PM, same business day', r.today.hours[21] === 500)
  check('today total 1500 (other tenant and other days excluded)', r.today.totalPaisa === 1500)
  check('yesterday 9 PM is slot 17, total 700', r.yesterday.hours[17] === 700 && r.yesterday.totalPaisa === 700)
  check('24 integer slots each', r.today.hours.length === 24 && r.today.hours.every(Number.isInteger))
  check('now slot is a real slot', Number.isInteger(r.nowSlot) && r.nowSlot >= 0 && r.nowSlot < 24)
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = ((await db.execute(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Revenue %'`)).rows as any[]).map((r) => r.id)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  const sessions = q`(select id from order_sessions where tenant_id = any(${all}::uuid[]))`
  const guarded = [['payment_records', 'immutable_payment_records'], ['bills', 'immutable_bills']] as const
  try {
    for (const [table, trigger] of guarded) await db.execute(q.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))
    await db.execute(q`DELETE FROM payment_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM bills WHERE tenant_id = any(${all}::uuid[])`)
  } finally {
    for (const [table, trigger] of guarded) {
      await db.execute(q.raw(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)).catch((error) =>
        console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error))
    }
  }
  await db.execute(q`DELETE FROM order_sessions WHERE tenant_id = any(${all}::uuid[])`)
  await db.execute(q`DELETE FROM order_number_counters WHERE tenant_id = any(${all}::uuid[])`)
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
