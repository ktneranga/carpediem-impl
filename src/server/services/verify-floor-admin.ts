/* eslint-disable @typescript-eslint/no-explicit-any -- reads arbitrary API JSON; nothing here is imported by the app. */
/**
 * Story 10.3 lite — zones and tables through the real routes and the Manage gate.
 *
 *   pnpm exec tsx --env-file=.env src/server/services/verify-floor-admin.ts
 *
 * THE DEV SERVER MUST BE RUNNING. It never touches the Manage password: it
 * signs in as the owner and opens a Manage session for that POS session
 * directly in the database (as unlocking would), then deletes it. Everything it
 * makes is named `ZZ …`. Seating goes through the real route (no ticket
 * prints on opening a table). On a local database the cleanup deletes its own
 * sessions, `config_changes` rows, tables and zones with the guards off only
 * around that; anywhere else it soft-removes them.
 */
import { Pool } from 'pg'
import { io as connectSocket } from 'socket.io-client'
import { signSessionId } from '../auth/session-cookie'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const made = { zones: [] as string[], tables: [] as string[], sessions: [] as string[], staffSessions: [] as string[] }
let startedAt = new Date()
let originalZoneOrder: string[] = []

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

const floorRows = async (cookie: string) => ((await api(cookie, 'GET', '/api/tables')).body?.data ?? []) as any[]
const versionOf = async (table: 'tables' | 'zones', id: string) =>
  ((await sql(`SELECT version FROM ${table} WHERE id = $1`, [id]))[0]?.version ?? 0) as number

async function run() {
  startedAt = new Date((await sql(`SELECT now() AS now`))[0].now)
  originalZoneOrder = (await sql(`SELECT id FROM zones WHERE is_active ORDER BY display_order, id`)).map((z) => z.id)

  const owner = await login('5678')
  const waiter = await login('1234')
  const manage = await unlock(owner)

  // Case 12: the gate.
  check('a waiter is refused (403)', (await api(waiter, 'GET', '/api/manage/floor')).status === 403)
  check('an owner without the Manage unlock is refused (401 MANAGE_LOCKED)',
    (await api(owner, 'GET', '/api/manage/floor')).body?.error?.code === 'MANAGE_LOCKED')

  // Case 11: listen like a tablet.
  let heard = 0
  const socket = connectSocket(BASE, { extraHeaders: { cookie: owner }, transports: ['websocket'] })
  socket.on('floor:changed', () => (heard += 1))
  await new Promise<void>((resolve) => {
    socket.on('connect', () => resolve())
    setTimeout(resolve, 3000)
  })

  // Case 1: a zone and two tables.
  const zone = await api(manage, 'POST', '/api/manage/floor/zones', { name: '  ZZ   Garden ' })
  check('add a zone (201), name tidied', zone.status === 201 && zone.body?.data?.name === 'ZZ Garden', JSON.stringify(zone.body))
  const zoneId = zone.body?.data?.id as string
  made.zones.push(zoneId)
  const zone2 = await api(manage, 'POST', '/api/manage/floor/zones', { name: 'ZZ Deck' })
  const zone2Id = zone2.body?.data?.id as string
  made.zones.push(zone2Id)

  const addTable = async (zid: string, label: string, capacity: number | null = null) => {
    const result = await api(manage, 'POST', `/api/manage/floor/zones/${zid}/tables`, { label, capacity })
    if (result.body?.data?.id) made.tables.push(result.body.data.id)
    return result
  }
  const a = await addTable(zoneId, 'ZZ A1', 4)
  const b = await addTable(zoneId, 'ZZ A2')
  check('add two tables (201)', a.status === 201 && b.status === 201 && a.body?.data?.capacity === 4, JSON.stringify(a.body))
  const aId = a.body?.data?.id as string
  const bId = b.body?.data?.id as string
  let rows = await floorRows(waiter)
  const inZone = rows.filter((r) => r.zoneId === zoneId).map((r) => r.id)
  check('they are on the floor (/api/tables), in that zone, in order', JSON.stringify(inZone) === JSON.stringify([aId, bId]),
    JSON.stringify(inZone))
  check('31 seats is refused (422)', (await addTable(zoneId, 'ZZ Big', 31)).status === 422)
  check('a 21-character label is refused (422)', (await addTable(zoneId, 'ZZ ' + 'x'.repeat(18))).status === 422)

  // Case 2: drag and drop.
  const droppedTables = await api(manage, 'POST', '/api/manage/floor/reorder', { kind: 'table', parentId: zoneId, ids: [bId, aId] })
  rows = await floorRows(waiter)
  check('a drop reorders the tables on the floor', droppedTables.status === 200 &&
    JSON.stringify(rows.filter((r) => r.zoneId === zoneId).map((r) => r.id)) === JSON.stringify([bId, aId]))
  const zoneIds = (await sql(`SELECT id FROM zones WHERE is_active ORDER BY display_order, id`)).map((z) => z.id) as string[]
  const ourFirst = [zoneId, ...zoneIds.filter((id) => id !== zoneId)]
  const droppedZones = await api(manage, 'POST', '/api/manage/floor/reorder', { kind: 'zone', parentId: null, ids: ourFirst })
  rows = await floorRows(waiter)
  check('a drop reorders the zones: the floor pills follow', droppedZones.status === 200 && rows[0]?.zoneId === zoneId,
    rows[0]?.zoneName)
  const partial = await api(manage, 'POST', '/api/manage/floor/reorder', { kind: 'table', parentId: zoneId, ids: [aId] })
  check('a drop over a list that changed is refused (409 STALE)', partial.status === 409 && partial.body?.error?.code === 'STALE')

  // Case 3: labels unique ignoring case.
  const dupAdd = await addTable(zone2Id, 'zz a1')
  check('a duplicate label (other case) on add is refused (409 LABEL_TAKEN)',
    dupAdd.status === 409 && dupAdd.body?.error?.code === 'LABEL_TAKEN', JSON.stringify(dupAdd.body))
  const dupRename = await api(manage, 'PATCH', `/api/manage/floor/tables/${bId}`, { version: await versionOf('tables', bId), label: 'ZZ a1' })
  check('… and on rename', dupRename.status === 409 && dupRename.body?.error?.code === 'LABEL_TAKEN')

  // Case 9: stale.
  const staleEdit = await api(manage, 'PATCH', `/api/manage/floor/tables/${aId}`, { version: 1, capacity: 6 })
  check('an edit with an old version is refused (409 STALE)', staleEdit.status === 409 && staleEdit.body?.error?.code === 'STALE')

  // Case 4: rename and move an occupied table.
  const seated = await api(waiter, 'POST', `/api/tables/${aId}/sessions`, {})
  const sessionId = seated.body?.data?.sessionId as string
  if (sessionId) made.sessions.push(sessionId)
  check('seat ZZ A1 (201)', seated.status === 201, JSON.stringify(seated.body))
  const renamed = await api(manage, 'PATCH', `/api/manage/floor/tables/${aId}`, {
    version: await versionOf('tables', aId), label: 'ZZ A9', zoneId: zone2Id,
  })
  rows = await floorRows(waiter)
  const movedRow = rows.find((r) => r.id === aId)
  check('rename + move an occupied table: allowed, its order stays on it, in the new zone',
    renamed.status === 200 && movedRow?.label === 'ZZ A9' && movedRow?.zoneId === zone2Id && movedRow?.sessionId === sessionId,
    JSON.stringify(movedRow))

  // Case 5: in use.
  const removeBusy = await api(manage, 'DELETE', `/api/manage/floor/tables/${aId}?version=${await versionOf('tables', aId)}`)
  check('remove a table with an open order is refused (409 TABLE_IN_USE)',
    removeBusy.status === 409 && removeBusy.body?.error?.code === 'TABLE_IN_USE' && /ZZ A9/.test(removeBusy.body?.error?.message),
    JSON.stringify(removeBusy.body))
  const c = await addTable(zoneId, 'ZZ A3')
  const cId = c.body?.data?.id as string
  const merged = await api(waiter, 'POST', `/api/tables/${bId}/sessions`, { additionalTableIds: [cId] })
  if (merged.body?.data?.sessionId) made.sessions.push(merged.body.data.sessionId)
  // Status alone must not decide (Trap 4): clear it, the open attachment still blocks.
  await sql(`UPDATE tables SET status = 'open' WHERE id = $1`, [cId])
  const removeMerged = await api(manage, 'DELETE', `/api/manage/floor/tables/${cId}?version=${await versionOf('tables', cId)}`)
  check('remove a table in a merged group is refused (409 TABLE_IN_USE), even with status open',
    merged.status === 201 && removeMerged.status === 409 && removeMerged.body?.error?.code === 'TABLE_IN_USE',
    `${merged.status} ${JSON.stringify(removeMerged.body)}`)
  await sql(`UPDATE tables SET status = 'occupied' WHERE id = $1`, [cId])

  // Out of service is never touched by an edit (Story 3.7's state).
  const d = await addTable(zone2Id, 'ZZ D1', 2)
  const dId = d.body?.data?.id as string
  await sql(`UPDATE tables SET status = 'unavailable', unavailable_reason = 'ZZ broken' WHERE id = $1`, [dId])
  await api(manage, 'PATCH', `/api/manage/floor/tables/${dId}`, { version: await versionOf('tables', dId), label: 'ZZ D2', capacity: 3 })
  const [oos] = await sql(`SELECT status, unavailable_reason, label FROM tables WHERE id = $1`, [dId])
  check('an edit leaves out-of-service alone', oos?.status === 'unavailable' && oos?.unavailable_reason === 'ZZ broken' && oos?.label === 'ZZ D2',
    JSON.stringify(oos))
  await sql(`UPDATE tables SET status = 'open', unavailable_reason = NULL WHERE id = $1`, [dId])

  // Case 6: remove a free table — gone everywhere a table is offered.
  const removed = await api(manage, 'DELETE', `/api/manage/floor/tables/${dId}?version=${await versionOf('tables', dId)}`)
  rows = await floorRows(waiter)
  check('remove a free table (200): gone from the floor', removed.status === 200 && !rows.some((r) => r.id === dId))
  const seatRemoved = await api(waiter, 'POST', `/api/tables/${dId}/sessions`, {})
  check('seating it by id is refused (404 TABLE_NOT_FOUND)', seatRemoved.status === 404 && seatRemoved.body?.error?.code === 'TABLE_NOT_FOUND')
  const [tenant] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const [waiterRow] = await sql(`SELECT id FROM staff WHERE role = 'waiter' AND is_active LIMIT 1`)
  const [counter] = await sql(
    `INSERT INTO order_sessions (tenant_id, kind, opened_by_staff_id, tab_label) VALUES ($1, 'counter', $2, 'ZZ Verify') RETURNING id`,
    [tenant.id, waiterRow.id],
  )
  made.sessions.push(counter.id)
  const moveOnto = await api(waiter, 'POST', `/api/sessions/${counter.id}/tables`, { tableIds: [dId] })
  check('moving an order onto it is refused (404)', moveOnto.status === 404, JSON.stringify(moveOnto.body))
  const mergeIn = await api(waiter, 'POST', `/api/tables/${aId}/merge`, { tableIds: [dId] })
  check('merging it in is refused (4xx)', mergeIn.status >= 400 && mergeIn.status < 500, `${mergeIn.status} ${JSON.stringify(mergeIn.body)}`)
  const listed = (await api(manage, 'GET', '/api/manage/floor?removed=1')).body?.data
  check('"Show removed tables" lists it', listed?.removed?.some((t: any) => t.id === dId && t.zoneName === 'ZZ Deck'))

  // Case 3 (restore) + 7.
  const taker = await addTable(zoneId, 'zz d2')
  const restoreTaken = await api(manage, 'POST', `/api/manage/floor/tables/${dId}/restore`, { version: await versionOf('tables', dId) })
  check('restore is refused while another active table has its label (409 LABEL_TAKEN)',
    restoreTaken.status === 409 && restoreTaken.body?.error?.code === 'LABEL_TAKEN')
  await api(manage, 'DELETE', `/api/manage/floor/tables/${taker.body?.data?.id}?version=1`)
  const restored = await api(manage, 'POST', `/api/manage/floor/tables/${dId}/restore`, { version: await versionOf('tables', dId) })
  rows = await floorRows(waiter)
  check('restore puts it back on the floor', restored.status === 200 && rows.some((r) => r.id === dId))

  // Case 8: zones.
  const zoneBusy = await api(manage, 'DELETE', `/api/manage/floor/zones/${zone2Id}?version=${await versionOf('zones', zone2Id)}`)
  check('a zone with tables cannot be removed (409 ZONE_NOT_EMPTY)', zoneBusy.status === 409 && zoneBusy.body?.error?.code === 'ZONE_NOT_EMPTY')
  const empty = await api(manage, 'POST', '/api/manage/floor/zones', { name: 'ZZ Empty' })
  made.zones.push(empty.body?.data?.id)
  const zoneGone = await api(manage, 'DELETE', `/api/manage/floor/zones/${empty.body?.data?.id}?version=1`)
  check('an empty zone can be removed (200)', zoneGone.status === 200)

  // Case 10: the log.
  const log = await sql(`SELECT version, payload FROM config_changes WHERE row_id = $1 ORDER BY created_at`, [dId])
  check('every write of a table is in config_changes with the row after it',
    log.length === 4 && log.map((l) => l.version).join() === "1,2,3,4" && log.at(-1)?.payload?.isActive === true && log.at(-1)?.version === (await versionOf('tables', dId)),
    JSON.stringify(log.map((l) => l.version)))

  check('an unknown id is 404',
    (await api(manage, 'PATCH', `/api/manage/floor/tables/00000000-0000-4000-8000-000000000000`, { version: 1, label: 'x' })).status === 404)

  await new Promise((resolve) => setTimeout(resolve, 300))
  check('every save told the tablets (floor:changed)', heard >= 12, `${heard} heard`)
  socket.disconnect()
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  const local = ['localhost', '127.0.0.1', '::1'].includes(host)
  // The real zones go back to the order they had.
  for (const [index, id] of originalZoneOrder.entries()) {
    await sql(`UPDATE zones SET display_order = $2 WHERE id = $1`, [id, index + 1])
  }
  if (!local) {
    await sql(`UPDATE tables SET is_active = false WHERE id = ANY($1::uuid[])`, [made.tables])
    await sql(`UPDATE zones SET is_active = false WHERE id = ANY($1::uuid[])`, [made.zones])
  } else {
    const guards = [
      ['config_changes', 'immutable_config_changes'],
      ['order_events', 'immutable_order_events'],
    ] as const
    try {
      for (const [table, trigger] of guards) await sql(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
      // Our rows, and the real zones' reorder rows written during this run.
      await sql(
        `DELETE FROM config_changes WHERE row_id = ANY($1::uuid[])
            OR (row_id = ANY($2::uuid[]) AND created_at >= $3)`,
        [[...made.tables, ...made.zones], originalZoneOrder, startedAt],
      )
      await sql(`DELETE FROM order_events WHERE session_id = ANY($1::uuid[])`, [made.sessions])
    } finally {
      for (const [table, trigger] of guards) {
        await sql(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`).catch((error) =>
          console.error(`!! COULD NOT RE-ENABLE ${trigger} ON ${table} !!`, error),
        )
      }
    }
    await sql(`DELETE FROM seat_slots WHERE session_id = ANY($1::uuid[])`, [made.sessions])
    await sql(`DELETE FROM order_session_tables WHERE session_id = ANY($1::uuid[])`, [made.sessions])
    await sql(`DELETE FROM order_sessions WHERE id = ANY($1::uuid[])`, [made.sessions])
    await sql(`DELETE FROM tables WHERE id = ANY($1::uuid[])`, [made.tables])
    await sql(`DELETE FROM zones WHERE id = ANY($1::uuid[])`, [made.zones])
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
