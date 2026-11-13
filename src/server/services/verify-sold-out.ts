/* eslint-disable @typescript-eslint/no-explicit-any -- reads arbitrary API JSON; nothing here is imported by the app. */
/**
 * Story 8.3 — Sold out: the toggles, the reset, the gates, and the send refusal.
 *
 *   pnpm exec tsx --env-file=.env src/server/services/verify-sold-out.ts
 *
 * THE DEV SERVER MUST BE RUNNING. It needs no Manage password: Sold out opens
 * without one. Its own menu rows are made directly in the database, named
 * `ZZ Verify SO …`, and soft-removed at the end. Only a REFUSED send goes
 * through the order route — an accepted one would print on the real printer.
 * Its `config_changes`, sessions and staff sessions are deleted at the end with
 * the guards off only around its own cleanup, on a local database. Any real
 * dish or option that was already sold out before the reset case is put back
 * off afterwards.
 */
import { Pool } from 'pg'
import { io as connectSocket } from 'socket.io-client'
import { isRoleAllowed } from '../auth/permissions'
import { needsManageSession } from '../auth/manage-gate'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const made = {
  categories: [] as string[],
  items: [] as string[],
  groups: [] as string[],
  options: [] as string[],
  sessions: [] as string[],
  staffSessions: [] as string[],
  /** Real rows that were sold out before the reset case, to put back off. */
  realOffItems: [] as string[],
  realOffOptions: [] as string[],
}

async function login(pin: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!response.ok || !cookie) throw new Error(`login ${pin}: ${response.status}`)
  made.staffSessions.push(cookie.split('=')[1]!.split('.')[0]!)
  return cookie
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  return {
    status: response.status,
    location: response.headers.get('location') ?? '',
    body: (await response.json().catch(() => null)) as any,
  }
}

const row = async (table: 'menu_items' | 'modifier_options', id: string) =>
  (await sql(`SELECT is_available, version FROM ${table} WHERE id = $1`, [id]))[0] as { is_available: boolean; version: number }
const logFor = async (rowId: string) =>
  (await sql(`SELECT version, staff_id, payload FROM config_changes WHERE row_id = $1 ORDER BY created_at`, [rowId])) as {
    version: number
    staff_id: string
    payload: any
  }[]
const setItem = (cookie: string, id: string, available: boolean) =>
  api(cookie, 'PATCH', `/api/menu-items/${id}/availability`, { available })
const setOption = (cookie: string, id: string, available: boolean) =>
  api(cookie, 'PATCH', `/api/menu-options/${id}/availability`, { available })

function rbac() {
  for (const role of ['owner', 'waiter'] as const) {
    check(`${role} may open Sold out and its APIs`,
      isRoleAllowed('/manage/sold-out', role, 'GET') &&
        isRoleAllowed('/api/menu-items/x/availability', role, 'PATCH') &&
        isRoleAllowed('/api/menu-options/x/availability', role, 'PATCH') &&
        isRoleAllowed('/api/menu-items/availability/reset', role, 'POST'))
  }
  check('kitchen may not',
    !isRoleAllowed('/manage/sold-out', 'kitchen', 'GET') &&
      !isRoleAllowed('/api/menu-items/x/availability', 'kitchen', 'PATCH') &&
      !isRoleAllowed('/api/menu-options/x/availability', 'kitchen', 'PATCH'))
  check('a waiter is still refused the rest of Manage',
    !isRoleAllowed('/manage', 'waiter') && !isRoleAllowed('/manage/menu', 'waiter') &&
      !isRoleAllowed('/manage/sold-outx', 'waiter') && !isRoleAllowed('/api/manage/menu', 'waiter'))
  check('Sold out needs no Manage session', !needsManageSession('/manage/sold-out') && !needsManageSession('/manage/sold-out/x'))
  check('everything else in Manage still does',
    needsManageSession('/manage/sold-outx') && needsManageSession('/manage/menu') && needsManageSession('/manage') &&
      needsManageSession('/api/manage/menu') && !needsManageSession('/manage/unlock') &&
      !needsManageSession('/api/menu-items/x/availability'))
}

async function run() {
  rbac()

  const owner = await login('5678')
  const waiter = await login('1234')
  const kitchen = await login('4321')
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const [waiterRow] = await sql(`SELECT id FROM staff WHERE role = 'waiter' AND is_active AND tenant_id = $1 LIMIT 1`, [tenant.id])

  // ── The gates, through the real proxy ──────────────────────────────────────
  check('a waiter opens /manage/sold-out without the password (200)', (await api(waiter, 'GET', '/manage/sold-out')).status === 200)
  check('an owner without a Manage session opens it too (200)', (await api(owner, 'GET', '/manage/sold-out')).status === 200)
  const waiterMenuPage = await api(waiter, 'GET', '/manage/menu')
  check('a waiter typing /manage/menu is sent to /', waiterMenuPage.status === 307 && new URL(waiterMenuPage.location, BASE).pathname === '/',
    `${waiterMenuPage.status} ${waiterMenuPage.location}`)
  const ownerMenuPage = await api(owner, 'GET', '/manage/menu')
  check('an owner without a Manage session gets the unlock screen for Menu',
    ownerMenuPage.status === 307 && ownerMenuPage.location.includes('/manage/unlock'), `${ownerMenuPage.status} ${ownerMenuPage.location}`)
  const kitchenPage = await api(kitchen, 'GET', '/manage/sold-out')
  check('kitchen is sent to / from Sold out', kitchenPage.status === 307 && new URL(kitchenPage.location, BASE).pathname === '/')
  check('kitchen is refused the APIs (403)',
    (await setItem(kitchen, '00000000-0000-4000-8000-000000000000', false)).status === 403 &&
      (await setOption(kitchen, '00000000-0000-4000-8000-000000000000', false)).status === 403 &&
      (await api(kitchen, 'GET', '/api/menu-items/sold-out')).status === 403)

  // ── Rows of our own ─────────────────────────────────────────────────────────
  const [cat] = await sql(`INSERT INTO menu_categories (tenant_id, name, display_order) VALUES ($1, 'ZZ Verify SO', 9999) RETURNING id`, [tenant.id])
  made.categories.push(cat.id)
  const dish = async (name: string, active = true) => {
    const [r] = await sql(
      `INSERT INTO menu_items (tenant_id, category_id, name, price_paisa, production_destination, is_active)
       VALUES ($1, $2, $3, 150000, 'kitchen', $4) RETURNING id`,
      [tenant.id, cat.id, name, active],
    )
    made.items.push(r.id)
    return r.id as string
  }
  const fish = await dish('ZZ Verify SO Fish')
  const prawns = await dish('ZZ Verify SO Prawns')
  const gone = await dish('ZZ Verify SO Removed', false)
  const option = async (itemId: string, name: string) => {
    const [g] = await sql(`INSERT INTO modifier_groups (tenant_id, menu_item_id, name) VALUES ($1, $2, 'ZZ Sauce') RETURNING id`, [tenant.id, itemId])
    made.groups.push(g.id)
    const [o] = await sql(`INSERT INTO modifier_options (tenant_id, group_id, name) VALUES ($1, $2, $3) RETURNING id`, [tenant.id, g.id, name])
    made.options.push(o.id)
    return o.id as string
  }
  const garlic = await option(fish, 'ZZ Garlic')
  const goneOption = await option(gone, 'ZZ Orphan')

  // Listen like another tablet.
  const heard: { item: any[]; changed: number } = { item: [], changed: 0 }
  const socket = connectSocket(BASE, { extraHeaders: { cookie: owner }, transports: ['websocket'] })
  socket.on('menu:item_updated', (payload: any) => heard.item.push(payload))
  socket.on('menu:changed', () => (heard.changed += 1))
  await new Promise<void>((resolve) => {
    socket.on('connect', () => resolve())
    setTimeout(resolve, 3000)
  })

  // ── A dish ──────────────────────────────────────────────────────────────────
  const off = await setItem(waiter, fish, false)
  const afterOff = await row('menu_items', fish)
  const log1 = await logFor(fish)
  check('a waiter marks a dish sold out (200)',
    off.status === 200 && off.body?.data?.available === false && off.body?.data?.version === 2, JSON.stringify(off.body))
  check('is_available false, version + 1', afterOff.is_available === false && afterOff.version === 2)
  check('one config_changes row, with the waiter as who',
    log1.length === 1 && log1[0]!.staff_id === waiterRow.id && log1[0]!.version === 2 && log1[0]!.payload.isAvailable === false,
    JSON.stringify(log1.map((l) => [l.version, l.staff_id])))
  const again = await setItem(owner, fish, false)
  check('the same call again: 200, no new version, no new log row',
    again.status === 200 && again.body?.data?.version === 2 && (await row('menu_items', fish)).version === 2 && (await logFor(fish)).length === 1)
  const waiterMenu = await (await fetch(`${BASE}/api/menu`, { headers: { cookie: waiter } })).json() as any
  const onMenu = waiterMenu.data.flatMap((c: any) => c.items).find((i: any) => i.id === fish)
  check("the waiters' menu shows it greyed, not hidden", onMenu?.available === false)
  const board = await api(waiter, 'GET', '/api/menu-items/sold-out')
  const onBoard = board.body?.data?.flatMap((c: any) => c.items).find((i: any) => i.id === fish)
  check('the Sold out board lists it, off, with its option',
    board.status === 200 && onBoard?.isAvailable === false && onBoard.groups[0]?.options[0]?.id === garlic &&
      !board.body.data.flatMap((c: any) => c.items).some((i: any) => i.id === gone))

  // ── Send refuses it (a refused send never prints) ───────────────────────────
  const [session] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, tab_label) VALUES ($1, 'counter', $2, 'ZZ Verify SO') RETURNING id`,
    [tenant.id, waiterRow.id],
  )
  made.sessions.push(session.id)
  const [seat] = await sql(`INSERT INTO seat_slots (session_id, seat_label) VALUES ($1, 'Seat 1') RETURNING id`, [session.id])
  const send = await api(waiter, 'POST', `/api/sessions/${session.id}/orders`, {
    submissionId: crypto.randomUUID(),
    lines: [{ seatSlotId: seat.id, menuItemId: fish, quantity: 1, modifierText: '', optionIds: [], quotedPricePaisa: 150000 }],
  })
  check('Send refuses a sold-out dish', send.status >= 400 && JSON.stringify(send.body).includes('UNAVAILABLE'),
    `${send.status} ${JSON.stringify(send.body).slice(0, 160)}`)
  const [{ n: sent }] = await sql(`SELECT count(*)::int n FROM order_events WHERE session_id = $1`, [session.id])
  check('and nothing was written', sent === 0)

  const on = await setItem(waiter, fish, true)
  check('back on (200, version 3, a second log row)',
    on.status === 200 && on.body?.data?.available === true && (await row('menu_items', fish)).version === 3 && (await logFor(fish)).length === 2)
  check('a removed dish is 404', (await setItem(waiter, gone, false)).status === 404)
  check("an unknown (or another tenant's) id is 404", (await setItem(waiter, '00000000-0000-4000-8000-000000000000', false)).status === 404)
  check('a bad body is 400', (await api(waiter, 'PATCH', `/api/menu-items/${fish}/availability`, { available: 'no' })).status === 400)

  // ── An option ───────────────────────────────────────────────────────────────
  const optOff = await setOption(waiter, garlic, false)
  check('an option sold out (200, logged)',
    optOff.status === 200 && (await row('modifier_options', garlic)).is_available === false && (await logFor(garlic)).length === 1)
  const optOn = await setOption(owner, garlic, true)
  check('and back on', optOn.status === 200 && (await row('modifier_options', garlic)).is_available === true)
  check('an option under a removed dish is 404', (await setOption(waiter, goneOption, false)).status === 404)

  // ── Put everything back on ──────────────────────────────────────────────────
  // Real rows already off are remembered and put back off after.
  made.realOffItems = (await sql(
    `SELECT id FROM menu_items WHERE tenant_id = $1 AND is_active AND NOT is_available AND NOT (id = ANY($2::uuid[]))`,
    [tenant.id, made.items],
  )).map((r: any) => r.id)
  made.realOffOptions = (await sql(
    `SELECT id FROM modifier_options WHERE tenant_id = $1 AND is_active AND NOT is_available AND NOT (id = ANY($2::uuid[]))`,
    [tenant.id, made.options],
  )).map((r: any) => r.id)
  await setItem(waiter, fish, false)
  await setItem(waiter, prawns, false)
  await setOption(waiter, garlic, false)
  const logsBefore = (await logFor(fish)).length + (await logFor(prawns)).length + (await logFor(garlic)).length
  // Every active-chain row that is off right now — ours plus any real ones.
  const [{ n: offNow }] = await sql(
    `SELECT (SELECT count(*) FROM menu_items i JOIN menu_categories c ON c.id = i.category_id
              WHERE i.tenant_id = $1 AND i.is_active AND c.is_active AND NOT i.is_available)
          + (SELECT count(*) FROM modifier_options o JOIN modifier_groups g ON g.id = o.group_id
              JOIN menu_items i ON i.id = g.menu_item_id JOIN menu_categories c ON c.id = i.category_id
              WHERE o.tenant_id = $1 AND o.is_active AND g.is_active AND i.is_active AND c.is_active AND NOT o.is_available) AS n`,
    [tenant.id],
  )
  const changedBefore = heard.changed
  const reset = await api(waiter, 'POST', '/api/menu-items/availability/reset')
  const logsAfter = (await logFor(fish)).length + (await logFor(prawns)).length + (await logFor(garlic)).length
  check('reset: everything back on, count returned',
    reset.status === 200 && reset.body?.data?.count === Number(offNow) && Number(offNow) >= 3 &&
      (await row('menu_items', fish)).is_available && (await row('menu_items', prawns)).is_available &&
      (await row('modifier_options', garlic)).is_available,
    `${JSON.stringify(reset.body)} expected ${offNow}`)
  check('one log row per changed row (3 of ours)', logsAfter - logsBefore === 3, `${logsAfter - logsBefore}`)
  check('the removed option was not touched by the reset', (await row('modifier_options', goneOption)).is_available === true)

  await new Promise((resolve) => setTimeout(resolve, 400))
  const fishEvents = heard.item.filter((p) => p.itemId === fish)
  check('every dish toggle told the tablets (menu:item_updated with the payload)',
    fishEvents.length >= 3 && fishEvents.some((p) => p.available === false && p.portionCount === null) &&
      fishEvents.some((p) => p.available === true),
    JSON.stringify(fishEvents))
  check('option toggles and the reset sent menu:changed (reset once)', heard.changed - changedBefore === 1 && heard.changed >= 4,
    `${heard.changed} total, ${heard.changed - changedBefore} from reset`)
  socket.disconnect()
}

async function cleanup() {
  // Real rows that were off before the reset go back off (their log rows stay).
  await sql(`UPDATE menu_items SET is_available = false WHERE id = ANY($1::uuid[])`, [made.realOffItems])
  await sql(`UPDATE modifier_options SET is_available = false WHERE id = ANY($1::uuid[])`, [made.realOffOptions])
  // Ours: soft-removed, the way the owner would.
  await sql(`UPDATE modifier_options SET is_active = false WHERE id = ANY($1::uuid[])`, [made.options])
  await sql(`UPDATE modifier_groups SET is_active = false WHERE id = ANY($1::uuid[])`, [made.groups])
  await sql(`UPDATE menu_items SET is_active = false WHERE id = ANY($1::uuid[])`, [made.items])
  await sql(`UPDATE menu_categories SET is_active = false WHERE id = ANY($1::uuid[])`, [made.categories])
  const guards = [
    ['config_changes', 'immutable_config_changes'],
    ['order_events', 'immutable_order_events'],
    ['order_rounds', 'immutable_order_rounds'],
  ] as const
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (['localhost', '127.0.0.1', '::1'].includes(host)) {
    try {
      for (const [table, trigger] of guards) await sql(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
      await sql(`DELETE FROM config_changes WHERE row_id = ANY($1::uuid[])`, [
        [...made.items, ...made.options, ...made.groups, ...made.categories],
      ])
      await sql(`DELETE FROM print_jobs WHERE session_id = ANY($1::uuid[])`, [made.sessions])
      await sql(`DELETE FROM order_events WHERE session_id = ANY($1::uuid[])`, [made.sessions])
      await sql(`DELETE FROM order_rounds WHERE session_id = ANY($1::uuid[])`, [made.sessions])
    } finally {
      for (const [table, trigger] of guards) {
        await sql(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`).catch((error) =>
          console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error),
        )
      }
    }
    await sql(`DELETE FROM seat_slots WHERE session_id = ANY($1::uuid[])`, [made.sessions])
    await sql(`DELETE FROM order_sessions WHERE id = ANY($1::uuid[])`, [made.sessions])
  }
  await sql(`DELETE FROM staff_sessions WHERE id = ANY($1::uuid[])`, [made.staffSessions])
}

run()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error('cleanup failed:', error))
    await pool.end()
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exitCode = results.every(Boolean) ? 0 : 1
  })
