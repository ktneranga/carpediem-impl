/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Story 9.3 — the dashboard cards, through the service, on throwaway tenants.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-dashboard.ts
 *
 * Cash check (expected, count, recount, gap, append-only), sold-out kinds,
 * long-open threshold, comps, the End of day count line, another tenant never
 * counted. Local cleanup only, guards off just around the deletes.
 */
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { loadSummary, recordCashCount } from '@/server/services/dashboard.service'
import { loadTakings } from '@/server/services/takings.service'

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
  await db.execute(q`INSERT INTO tenant_config (tenant_id, restaurant_name, long_open_minutes) VALUES (${id}, ${name}, 90)`)
  const staffId = (await one(q`INSERT INTO staff (tenant_id, name, role, pin_hash) VALUES (${id}, 'ZZ Owner', 'owner', 'x') RETURNING id`)).id as string
  const zone = (await one(q`INSERT INTO zones (tenant_id, name) VALUES (${id}, 'ZZ Garden') RETURNING id`)).id
  const table = (await one(q`INSERT INTO tables (tenant_id, zone_id, label) VALUES (${id}, ${zone}, 'ZZ G1') RETURNING id`)).id as string
  const category = (await one(q`INSERT INTO menu_categories (tenant_id, name) VALUES (${id}, 'ZZ Cat') RETURNING id`)).id
  return { id, staffId, table, category }
}
type T = Awaited<ReturnType<typeof tenant>>

/** An order opened `minutesAgo` ago; paid in cash if `cash` is given, else left open. */
async function order(t: T, { minutesAgo, cash, table }: { minutesAgo: number; cash?: number; table?: string }) {
  const s = await one(q`INSERT INTO order_sessions (tenant_id, table_id, kind, opened_by_staff_id, opened_at, closed_at)
    VALUES (${t.id}, ${table ?? null}, ${table ? 'table' : 'counter'}, ${t.staffId}, now() - make_interval(mins => ${minutesAgo}),
            ${cash === undefined ? null : q`now()`}) RETURNING id`)
  if (table) await db.execute(q`INSERT INTO order_session_tables (session_id, table_id, released_at) VALUES (${s.id}, ${table}, ${cash === undefined ? null : q`now()`})`)
  const event = (await one(q`INSERT INTO order_events (session_id, staff_id, event_type, quantity, unit_price_paisa, custom_name)
    VALUES (${s.id}, ${t.staffId}, 'ITEM_ADDED', 1, ${cash ?? 500}, 'ZZ Kottu') RETURNING id`)).id
  if (cash !== undefined) {
    const b = await one(q`INSERT INTO bills (tenant_id, session_id, staff_id, type, subtotal_paisa, service_charge_paisa,
        tax_paisa, total_paisa, service_charge_bp, tax_bp)
      VALUES (${t.id}, ${s.id}, ${t.staffId}, 'consolidated', ${cash}, 0, 0, ${cash}, 0, 0) RETURNING id`)
    await db.execute(q`INSERT INTO payment_records (session_id, bill_id, staff_id, amount_paisa, method)
      VALUES (${s.id}, ${b.id}, ${t.staffId}, ${cash}, 'cash')`)
  }
  return { id: s.id as string, event: event as string }
}

async function run() {
  const a = await tenant('ZZ Dash verify')
  const other = await tenant('ZZ Dash other')

  await order(a, { minutesAgo: 30, cash: 120000 })
  await order(a, { minutesAgo: 20, cash: 30000 })
  const open = await order(a, { minutesAgo: 95, table: a.table })
  await order(a, { minutesAgo: 85 })
  await order(other, { minutesAgo: 30, cash: 999900 })
  await order(other, { minutesAgo: 300 })

  let s = await loadSummary(db, a.id)
  check('expected cash = today\'s cash payments (150,000)', s.cash.expectedPaisa === 150000, String(s.cash.expectedPaisa))
  check('not counted yet: no count, no gap', s.cash.count === null && s.cash.gapPaisa === null)

  await recordCashCount(db, { tenantId: a.id, staffId: a.staffId, countedPaisa: 140000 })
  s = await loadSummary(db, a.id)
  check('short by 10,000 → gap -10,000', s.cash.gapPaisa === -10000 && s.cash.count?.countedBy === 'ZZ Owner')
  await recordCashCount(db, { tenantId: a.id, staffId: a.staffId, countedPaisa: 150000 })
  s = await loadSummary(db, a.id)
  check('a recount wins → balanced (gap 0)', s.cash.gapPaisa === 0 && s.cash.count?.countedPaisa === 150000)
  const kept = await one(q`SELECT count(*)::int AS n FROM cash_counts WHERE tenant_id = ${a.id}`)
  check('both counts kept on record', kept.n === 2)
  let refused = false
  try {
    await db.execute(q`UPDATE cash_counts SET counted_paisa = 0 WHERE tenant_id = ${a.id}`)
  } catch {
    refused = true
  }
  check('a count cannot be edited (append-only)', refused)
  for (const bad of [-100, 150, 1.5, 2_000_000_000]) {
    let ok = false
    try {
      await recordCashCount(db, { tenantId: a.id, staffId: a.staffId, countedPaisa: bad })
    } catch (error) {
      ok = error instanceof MenuRuleError
    }
    check(`count ${bad} paisa is refused`, ok)
  }

  const takings = await loadTakings(db, { tenantId: a.id, businessDate: s.businessDate })
  check('End of day shows the count and the gap', takings.cashCount?.countedPaisa === 150000 && takings.cashCount.gapPaisa === 0)

  check('long-open: only the 95-minute order (threshold 90), with table and zone',
    s.longOpen.length === 1 && s.longOpen[0]!.tables[0] === 'ZZ G1' && s.longOpen[0]!.zone === 'ZZ Garden' && s.longOpen[0]!.minutesOpen >= 95,
    JSON.stringify(s.longOpen))
  check('long-open threshold comes back', s.longOpenMinutes === 90)

  await db.execute(q`INSERT INTO menu_items (tenant_id, category_id, name, price_paisa, is_available, portion_count)
    VALUES (${a.id}, ${a.category}, 'ZZ Crab', 100, false, 0), (${a.id}, ${a.category}, 'ZZ Prawns', 100, false, null),
           (${a.id}, ${a.category}, 'ZZ Rice', 100, true, null), (${a.id}, ${a.category}, 'ZZ Gone', 100, false, null)`)
  await db.execute(q`UPDATE menu_items SET is_active = false WHERE tenant_id = ${a.id} AND name = 'ZZ Gone'`)
  s = await loadSummary(db, a.id)
  check('sold out: crab out of stock, prawns marked; available and removed dishes left out',
    JSON.stringify(s.soldOut.map((i) => [i.name, i.kind])) === JSON.stringify([['ZZ Crab', 'depleted'], ['ZZ Prawns', 'manual']]),
    JSON.stringify(s.soldOut))

  check('no comps yet', s.comps.entries.length === 0 && s.comps.totalPaisa === 0)
  await db.execute(q`INSERT INTO comp_records (session_id, order_event_id, staff_id, authorized_by_staff_id, amount_paisa, reason)
    VALUES (${open.id}, ${open.event}, ${a.staffId}, ${a.staffId}, 500, 'ZZ cold')`)
  s = await loadSummary(db, a.id)
  check('a comp is listed with item, reason, staff, and totalled',
    s.comps.entries.length === 1 && s.comps.entries[0]!.itemName === 'ZZ Kottu' && s.comps.entries[0]!.reason === 'ZZ cold' &&
      s.comps.totalPaisa === 500)

  const theirs = await loadSummary(db, other.id)
  check('the other tenant sees only its own', theirs.cash.expectedPaisa === 999900 && theirs.longOpen.length === 1 && theirs.soldOut.length === 0)
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = ((await db.execute(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Dash %'`)).rows as any[]).map((r) => r.id)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  const sessions = q`(select id from order_sessions where tenant_id = any(${all}::uuid[]))`
  const guarded = [
    ['comp_records', 'immutable_comp_records'],
    ['payment_records', 'immutable_payment_records'],
    ['bills', 'immutable_bills'],
    ['order_events', 'immutable_order_events'],
    ['cash_counts', 'immutable_cash_counts'],
  ] as const
  try {
    for (const [table, trigger] of guarded) await db.execute(q.raw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`))
    await db.execute(q`DELETE FROM comp_records WHERE session_id IN ${sessions}`)
    await db.execute(q`DELETE FROM payment_records WHERE session_id IN ${sessions}`)
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
