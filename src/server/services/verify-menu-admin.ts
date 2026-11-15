/* eslint-disable @typescript-eslint/no-explicit-any -- reads arbitrary API JSON; nothing here is imported by the app. */
/**
 * Story 10.4 — menu management through the real routes and the Manage gate.
 *
 *   pnpm exec tsx --env-file=.env src/server/services/verify-menu-admin.ts
 *
 * THE DEV SERVER MUST BE RUNNING. It never touches the Manage password: it
 * signs in as the owner and opens a Manage session for that POS session
 * directly in the database (as unlocking would), then deletes it. Everything it
 * makes is named `ZZ Verify …` and is soft-removed at the end; its
 * `config_changes` and order rows are deleted with the guards off only around
 * its own cleanup, on a local database.
 */
import { Pool } from 'pg'
import { io as connectSocket } from 'socket.io-client'
import { signSessionId } from '../auth/session-cookie'
import { paisaFromLkrInput } from '../../lib/format'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const made = { categories: [] as string[], items: [] as string[], sessions: [] as string[], staffSessions: [] as string[] }

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

async function unlock(posCookie: string): Promise<string> {
  const staffSessionId = posCookie.split('=')[1]!.split('.')[0]!
  const [row] = await sql(`INSERT INTO manage_sessions (staff_session_id) VALUES ($1) RETURNING id`, [staffSessionId])
  return `${posCookie}; __cdrms_manage=${signSessionId(row.id)}`
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as any }
}

const changesFor = async (rowId: string) =>
  (await sql(`SELECT version, payload FROM config_changes WHERE row_id = $1 ORDER BY created_at`, [rowId])) as {
    version: number
    payload: any
  }[]

async function waiterMenu(cookie: string) {
  return (await (await fetch(`${BASE}/api/menu`, { headers: { cookie } })).json()) as any
}
const dishOnMenu = (menu: any, id: string) => menu.data.flatMap((c: any) => c.items).find((i: any) => i.id === id)

async function run() {
  // Case 13: the price helper.
  check('price helper: whole rupees in, paisa out',
    paisaFromLkrInput('1,250') === 125000 && paisaFromLkrInput('1250') === 125000 &&
      paisaFromLkrInput('1250.50') === null && paisaFromLkrInput('abc') === null && paisaFromLkrInput('') === null &&
      paisaFromLkrInput('-5') === null && paisaFromLkrInput('-1,000', { allowNegative: true }) === -100000)

  const owner = await login('5678')
  const waiter = await login('1234')
  const manage = await unlock(owner)

  // Case 14: the gate.
  check('a waiter is refused (403)', (await api(waiter, 'GET', '/api/manage/menu')).status === 403)
  check('an owner without the Manage unlock is refused (401 MANAGE_LOCKED)',
    (await api(owner, 'GET', '/api/manage/menu')).body?.error?.code === 'MANAGE_LOCKED')

  // Case 16: listen like a tablet.
  let heard = 0
  const socket = connectSocket(BASE, { extraHeaders: { cookie: owner }, transports: ['websocket'] })
  socket.on('menu:changed', () => (heard += 1))
  await new Promise<void>((resolve) => {
    socket.on('connect', () => resolve())
    setTimeout(resolve, 3000)
  })

  // Case 1: category + dish.
  const cat = await api(manage, 'POST', '/api/manage/menu/categories', { name: 'ZZ Verify Category' })
  check('add a category (201)', cat.status === 201, JSON.stringify(cat.body))
  const catId = cat.body?.data?.id as string
  made.categories.push(catId)
  const dish = await api(manage, 'POST', '/api/manage/menu/items', {
    categoryId: catId, name: '  ZZ Verify   Prawns ', pricePaisa: 125000, productionDestination: 'kitchen',
  })
  check('add a dish (201), name tidied', dish.status === 201 && dish.body?.data?.name === 'ZZ Verify Prawns', JSON.stringify(dish.body))
  const dishId = dish.body?.data?.id as string
  made.items.push(dishId)
  check("it is on the waiters' menu at 125000 paisa", dishOnMenu(await waiterMenu(waiter), dishId)?.pricePaisa === 125000)
  check('cents are refused (422)',
    (await api(manage, 'POST', '/api/manage/menu/items', { categoryId: catId, name: 'ZZ Verify Cents', pricePaisa: 125050, productionDestination: 'bar' })).status === 422)

  // Case 2 + 3: versions.
  const edit = await api(manage, 'PATCH', `/api/manage/menu/items/${dishId}`, { version: 1, pricePaisa: 130000 })
  check('edit the price with the right version (200, version 2)', edit.status === 200 && edit.body?.data?.version === 2)
  const changes = await changesFor(dishId)
  check('each write logged in config_changes with the row after it',
    changes.length === 2 && changes[1]!.version === 2 && changes[1]!.payload.pricePaisa === 130000, JSON.stringify(changes.map((c) => c.version)))
  const stale = await api(manage, 'PATCH', `/api/manage/menu/items/${dishId}`, { version: 1, pricePaisa: 140000 })
  check('the same edit with the old version is refused (409 STALE)', stale.status === 409 && stale.body?.error?.code === 'STALE')
  check('and the price is unchanged', dishOnMenu(await waiterMenu(waiter), dishId)?.pricePaisa === 130000)

  // Case 4: a sent order keeps its price.
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const [waiterRow] = await sql(`SELECT id FROM staff WHERE role = 'waiter' AND is_active LIMIT 1`)
  const [session] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, tab_label) VALUES ($1, 'counter', $2, 'ZZ Verify') RETURNING id`,
    [tenant.id, waiterRow.id],
  )
  made.sessions.push(session.id)
  const [seat] = await sql(`INSERT INTO seat_slots (session_id, seat_label) VALUES ($1, 'Seat 1') RETURNING id`, [session.id])
  // Only REFUSED sends go through the route: an accepted one would print a
  // kitchen ticket on whatever printer the dev server has. The "already sent"
  // line is written directly, as the send would write it.
  const send = async (lines: { menuItemId: string; quantity?: number; optionIds?: string[]; quotedPricePaisa: number }[]) =>
    api(waiter, 'POST', `/api/sessions/${session.id}/orders`, {
      submissionId: crypto.randomUUID(),
      lines: lines.map((line) => ({ seatSlotId: seat.id, quantity: 1, modifierText: '', optionIds: [], ...line })),
    })
  await sql(
    `INSERT INTO order_events (session_id, staff_id, menu_item_id, event_type, seat_slot_id, quantity, unit_price_paisa, round_number)
     VALUES ($1, $2, $3, 'ITEM_ADDED', $4, 1, 130000, 1)`,
    [session.id, waiterRow.id, dishId, seat.id],
  )
  await api(manage, 'PATCH', `/api/manage/menu/items/${dishId}`, { version: 2, pricePaisa: 150000 })
  const [event] = await sql(`SELECT unit_price_paisa FROM order_events WHERE session_id = $1 AND menu_item_id = $2`, [session.id, dishId])
  check('a price change leaves the sent order at its price', event?.unit_price_paisa === 130000, JSON.stringify(event))

  // Case 8, 9, 10, 11: options.
  const group = await api(manage, 'POST', `/api/manage/menu/items/${dishId}/groups`, { name: 'ZZ Alcohol', selection: 'single', isRequired: true })
  const groupId = group.body?.data?.id as string
  const extras = await api(manage, 'POST', `/api/manage/menu/items/${dishId}/groups`, { name: 'ZZ Extras', selection: 'multi', isRequired: false })
  const extrasId = extras.body?.data?.id as string
  const none = await api(manage, 'POST', `/api/manage/menu/groups/${groupId}/options`, {
    name: 'No alcohol', priceDeltaPaisa: -100000, isDefault: false, maxCount: 1, excludesGroupId: extrasId,
  })
  const single = await api(manage, 'POST', `/api/manage/menu/groups/${groupId}/options`, {
    name: 'Single', priceDeltaPaisa: 0, isDefault: false, maxCount: 1, excludesGroupId: null,
  })
  check('add groups and options, a negative price allowed', group.status === 201 && none.status === 201 && single.status === 201,
    JSON.stringify(none.body))
  const onMenu = dishOnMenu(await waiterMenu(waiter), dishId)
  check("the waiters' sheet shows them", onMenu?.modifierGroups?.length === 2 &&
    onMenu.modifierGroups[0].options.some((o: any) => o.priceDeltaPaisa === -100000 && o.excludesGroupId === extrasId))
  check('rules out its own group is refused (422)',
    (await api(manage, 'PATCH', `/api/manage/menu/options/${single.body?.data?.id}`, { version: 1, excludesGroupId: groupId })).status === 422)
  const noChoice = await send([{ menuItemId: dishId, quantity: 1, quotedPricePaisa: 150000 }])
  check('a required group with no choice is still refused at send', noChoice.status >= 400, String(noChoice.status))
  await api(manage, 'DELETE', `/api/manage/menu/groups/${extrasId}?version=1`)
  const [pointer] = await sql(`SELECT excludes_group_id FROM modifier_options WHERE id = $1`, [none.body?.data?.id])
  check('removing a group clears the "rules out" pointing at it', pointer?.excludes_group_id === null)
  await api(manage, 'DELETE', `/api/manage/menu/options/${single.body?.data?.id}?version=1`)
  const afterOption = dishOnMenu(await waiterMenu(waiter), dishId)
  check('a removed option is gone from the sheet', !afterOption.modifierGroups[0].options.some((o: any) => o.name === 'Single'))
  const withRemoved = await send([{ menuItemId: dishId, quantity: 1, optionIds: [single.body?.data?.id], quotedPricePaisa: 150000 }])
  check('and choosing it at send is refused', withRemoved.status >= 400, String(withRemoved.status))

  // Case 12: moving among ties.
  const second = await api(manage, 'POST', '/api/manage/menu/items', { categoryId: catId, name: 'ZZ Verify Beer', pricePaisa: 90000, productionDestination: 'bar' })
  made.items.push(second.body?.data?.id)
  await sql(`UPDATE menu_items SET display_order = 0 WHERE id = ANY($1::uuid[])`, [made.items])
  const [{ version: beerVersion }] = await sql(`SELECT version FROM menu_items WHERE id = $1`, [second.body?.data?.id])
  const moved = await api(manage, 'POST', `/api/manage/menu/items/${second.body?.data?.id}/move`, { direction: 'up', version: beerVersion })
  const order = (await waiterMenu(waiter)).data.find((c: any) => c.id === catId)?.items.map((i: any) => i.name)
  check('move up works even when every order is 0', moved.status === 200 && order?.[0] === 'ZZ Verify Beer', JSON.stringify(order))

  // Drag and drop (Teran, 2026-11-13): a whole list's new order in one call.
  const before = (await waiterMenu(waiter)).data.find((c: any) => c.id === catId)?.items.map((i: any) => i.id) as string[]
  const dropped = await api(manage, 'POST', '/api/manage/menu/reorder', { kind: 'item', parentId: catId, ids: [...before].reverse() })
  const after = (await waiterMenu(waiter)).data.find((c: any) => c.id === catId)?.items.map((i: any) => i.id) as string[]
  check('a drop saves the new order', dropped.status === 200 && JSON.stringify(after) === JSON.stringify([...before].reverse()))
  const partial = await api(manage, 'POST', '/api/manage/menu/reorder', { kind: 'item', parentId: catId, ids: [before[0]] })
  check('a drop of a list that changed meanwhile is refused (409 STALE)', partial.status === 409 && partial.body?.error?.code === 'STALE')

  // Case 5, 6, 7: remove, restore, category guard.
  const notEmpty = await api(manage, 'DELETE', `/api/manage/menu/categories/${catId}?version=1`)
  check('a category with dishes cannot be removed (409)', notEmpty.status === 409 && notEmpty.body?.error?.code === 'CATEGORY_NOT_EMPTY')
  const [{ version: dishVersion }] = await sql(`SELECT version FROM menu_items WHERE id = $1`, [dishId])
  const removed = await api(manage, 'DELETE', `/api/manage/menu/items/${dishId}?version=${dishVersion}`)
  check('remove a dish (200)', removed.status === 200)
  check("it is gone from the waiters' menu", !dishOnMenu(await waiterMenu(waiter), dishId))
  const sendRemoved = await send([{ menuItemId: dishId, quantity: 1, quotedPricePaisa: 150000 }])
  check('a send of it is refused as unavailable', sendRemoved.status >= 400 && JSON.stringify(sendRemoved.body).includes('UNAVAILABLE'),
    `${sendRemoved.status} ${JSON.stringify(sendRemoved.body).slice(0, 160)}`)
  const [{ n: stillThere }] = await sql(`SELECT count(*)::int n FROM order_events WHERE menu_item_id = $1`, [dishId])
  check('past orders still point at it', stillThere > 0)
  const restored = await api(manage, 'POST', `/api/manage/menu/items/${dishId}/restore`, { version: removed.body?.data?.version })
  check('restore puts it back', restored.status === 200 && !!dishOnMenu(await waiterMenu(waiter), dishId))

  // Switches (Teran, 2026-11-15): a category goes off once its dishes are
  // off, is still listed in Manage, and comes back on.
  const dishV = async () => (await sql(`SELECT version FROM menu_items WHERE id = $1`, [dishId]))[0].version
  const catV = async () => (await sql(`SELECT version FROM menu_categories WHERE id = $1`, [catId]))[0].version
  const onInCat = await sql(`SELECT id, version FROM menu_items WHERE category_id = $1 AND is_active`, [catId])
  for (const row of onInCat) await api(manage, 'DELETE', `/api/manage/menu/items/${row.id}?version=${row.version}`)
  const catOff = await api(manage, 'DELETE', `/api/manage/menu/categories/${catId}?version=${await catV()}`)
  check('a category with its dishes off can be switched off (200)', catOff.status === 200, JSON.stringify(catOff.body))
  const manageList = (await api(manage, 'GET', '/api/manage/menu?removed=1')).body?.data as any[]
  check('Manage still lists the switched-off category, marked off',
    manageList?.some((c) => c.id === catId && c.isActive === false && c.items.some((i: any) => i.id === dishId)))
  check('Manage without ?removed=1 leaves it out', !((await api(manage, 'GET', '/api/manage/menu')).body?.data as any[])?.some((c) => c.id === catId))
  const dishInOffCat = await api(manage, 'POST', `/api/manage/menu/items/${dishId}/restore`, { version: await dishV() })
  check('a dish cannot go on while its category is off (422)', dishInOffCat.status === 422, JSON.stringify(dishInOffCat.body))
  const catOn = await api(manage, 'POST', `/api/manage/menu/categories/${catId}/restore`, { version: await catV() })
  check('the category switches back on (200)', catOn.status === 200 && catOn.body?.data?.isActive === true, JSON.stringify(catOn.body))
  const catOnStale = await api(manage, 'POST', `/api/manage/menu/categories/${catId}/restore`, { version: 1 })
  check('an old version is refused (409 STALE)', catOnStale.status === 409 && catOnStale.body?.error?.code === 'STALE')
  const dishOn = await api(manage, 'POST', `/api/manage/menu/items/${dishId}/restore`, { version: await dishV() })
  check('then the dish goes back on the menu', dishOn.status === 200 && !!dishOnMenu(await waiterMenu(waiter), dishId))

  // Case 15: another tenant's (unknown) id.
  check('an unknown id is 404',
    (await api(manage, 'PATCH', `/api/manage/menu/items/00000000-0000-4000-8000-000000000000`, { version: 1, name: 'x' })).status === 404)

  await new Promise((resolve) => setTimeout(resolve, 300))
  check('every save told the tablets (menu:changed)', heard >= 10, `${heard} heard`)
  socket.disconnect()

  // Case 17: the log is kept.
  let refused = false
  try {
    await sql(`DELETE FROM config_changes WHERE row_id = $1`, [dishId])
  } catch (error) {
    refused = String(error).includes('immutable-table')
  }
  check('config_changes refuses DELETE', refused)
}

async function cleanup() {
  // Soft-remove what we made, the way the owner would.
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
      const rows = [...made.items, ...made.categories]
      await sql(
        `DELETE FROM config_changes WHERE row_id = ANY($1::uuid[])
            OR row_id IN (SELECT id FROM modifier_groups WHERE menu_item_id = ANY($2::uuid[]))
            OR row_id IN (SELECT o.id FROM modifier_options o JOIN modifier_groups g ON g.id = o.group_id WHERE g.menu_item_id = ANY($2::uuid[]))`,
        [rows, made.items],
      )
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
