/* eslint-disable @typescript-eslint/no-explicit-any -- reads arbitrary API JSON; nothing here is imported by the app. */
/**
 * spec-menu-bulk-upload-excel — Manage → Menu → Bulk upload through the real
 * route and the Manage gate.
 *
 *   pnpm exec tsx --env-file=.env src/server/services/verify-menu-import.ts
 *
 * THE DEV SERVER MUST BE RUNNING. Signs in as the owner and opens a Manage
 * session directly in the database (as verify-menu-admin does). Everything it
 * makes is named `ZZ Import …`; it is soft-removed at the end and, on a local
 * database, its `config_changes` rows are deleted with the guard off.
 */
import ExcelJS from 'exceljs'
import { Pool } from 'pg'
import { signSessionId } from '../auth/session-cookie'
import { parseMenuWorkbook } from '../menu-import/workbook'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const staffSessions: string[] = []

async function login(pin: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!response.ok || !cookie) throw new Error(`login ${pin}: ${response.status}`)
  staffSessions.push(cookie.split('=')[1]!.split('.')[0]!)
  return cookie
}

async function unlock(posCookie: string): Promise<string> {
  const staffSessionId = posCookie.split('=')[1]!.split('.')[0]!
  const [row] = await sql(`INSERT INTO manage_sessions (staff_session_id) VALUES ($1) RETURNING id`, [staffSessionId])
  return `${posCookie}; __cdrms_manage=${signSessionId(row.id)}`
}

/** A workbook in the upload format, from plain rows. */
async function workbook(dishes: unknown[][], options: unknown[][] = []): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const d = book.addWorksheet('Dishes')
  d.addRow(['Category', 'Dish', 'Price (LKR)', 'Station'])
  for (const row of dishes) d.addRow(row)
  const o = book.addWorksheet('Options')
  o.addRow(['Category', 'Dish', 'Option group', 'Choose', 'Required', 'Option', 'Extra price (LKR)', 'Default', 'Max per dish'])
  for (const row of options) o.addRow(row)
  return Buffer.from(await book.xlsx.writeBuffer())
}

async function upload(cookie: string, file: Buffer, { apply = false, name = 'menu.xlsx' } = {}) {
  const body = new FormData()
  body.append('file', new Blob([new Uint8Array(file)]), name)
  const response = await fetch(`${BASE}/api/manage/menu/import${apply ? '?apply=1' : ''}`, { method: 'POST', headers: { cookie }, body })
  return { status: response.status, body: (await response.json().catch(() => null)) as any }
}

const zzCategories = async () =>
  sql(`SELECT id, name, is_active FROM menu_categories WHERE name LIKE 'ZZ Import%' ORDER BY display_order`)
const zzDish = async (name: string) =>
  (await sql(`SELECT id, name, price_paisa, production_destination, version, is_active FROM menu_items WHERE name = $1 ORDER BY is_active DESC, updated_at DESC`, [name]))[0]
const counted = (summary: any) =>
  ['categories', 'dishes', 'groups', 'options'].map((k) => `${summary?.[k]?.new ?? '?'}/${summary?.[k]?.updated ?? '?'}`).join(' ')

const FRESH = [
  ['ZZ Import Food', 'ZZ Import Toast', 2300, 'Kitchen'],
  ['ZZ Import Food', 'ZZ Import Pizza', '2,900', 'Pizza kitchen'],
  ['ZZ Import Drinks', 'ZZ Import Latte', 1000, 'Bar'],
]
const FRESH_OPTIONS = [
  ['ZZ Import Drinks', 'ZZ Import Latte', 'Milk', 'One', 'Yes', 'Cow', 0, 'Yes', 1],
  ['ZZ Import Drinks', 'ZZ Import Latte', 'Milk', 'One', 'Yes', 'Oat', 200, 'No', 1],
]

async function run() {
  const owner = await login('5678')
  const waiter = await login('1234')
  const manage = await unlock(owner)

  // Gate.
  check('a waiter is refused (403)', (await fetch(`${BASE}/api/manage/menu/import`, { headers: { cookie: waiter } })).status === 403)

  // Download: the current menu, in the format the upload reads.
  const download = await fetch(`${BASE}/api/manage/menu/import`, { headers: { cookie: manage } })
  const downloaded = Buffer.from(await download.arrayBuffer())
  const parsedDownload = await parseMenuWorkbook(downloaded)
  check('download is an .xlsx of the menu that reads back cleanly',
    download.status === 200 && (download.headers.get('content-type') ?? '').includes('spreadsheetml') &&
      parsedDownload.errors.length === 0 && parsedDownload.dishes.length > 0,
    `${download.status} ${parsedDownload.dishes.length} dishes ${JSON.stringify(parsedDownload.errors).slice(0, 120)}`)
  const unchanged = await upload(manage, downloaded)
  check('uploading the download unchanged: nothing to change', unchanged.status === 200 && counted(unchanged.body?.data) === '0/0 0/0 0/0 0/0',
    `${unchanged.status} ${counted(unchanged.body?.data)} ${JSON.stringify(unchanged.body?.data?.errors ?? unchanged.body).slice(0, 200)}`)

  // Check, then import.
  const fresh = await workbook(FRESH, FRESH_OPTIONS)
  const plan = await upload(manage, fresh)
  check('check counts what is new and writes nothing',
    plan.status === 200 && counted(plan.body?.data) === '2/0 3/0 1/0 2/0' && (await zzCategories()).length === 0,
    `${plan.status} ${counted(plan.body?.data)}`)
  const applied = await upload(manage, fresh, { apply: true })
  const cats = await zzCategories()
  const toast = await zzDish('ZZ Import Toast')
  const pizza = await zzDish('ZZ Import Pizza')
  const latte = await zzDish('ZZ Import Latte')
  check('import creates categories (sheet order) and dishes with price and station',
    applied.status === 200 && cats.map((c) => c.name).join() === 'ZZ Import Food,ZZ Import Drinks' &&
      toast?.price_paisa === 230000 && toast?.production_destination === 'kitchen' &&
      pizza?.price_paisa === 290000 && pizza?.production_destination === 'pizza_kitchen' &&
      latte?.production_destination === 'bar',
    `${applied.status} ${JSON.stringify(applied.body).slice(0, 200)}`)
  const opts = await sql(
    `SELECT g.name g, g.is_required r, o.name o, o.price_delta_paisa p, o.is_default d FROM modifier_options o
       JOIN modifier_groups g ON g.id = o.group_id WHERE g.menu_item_id = $1 ORDER BY o.display_order`,
    [latte?.id],
  )
  check('options land on their dish', opts.map((o) => `${o.g}:${o.o}:${o.p}:${o.d}:${o.r}`).join() === 'Milk:Cow:0:true:true,Milk:Oat:20000:false:true',
    JSON.stringify(opts))
  const waiterMenu = (await (await fetch(`${BASE}/api/menu`, { headers: { cookie: waiter } })).json()) as any
  check('the waiters see it', waiterMenu.data.flatMap((c: any) => c.items).some((i: any) => i.id === toast?.id))

  // Same sheet again: no writes.
  const again = await upload(manage, fresh, { apply: true })
  check('the same sheet again changes nothing',
    again.status === 200 && counted(again.body?.data) === '0/0 0/0 0/0 0/0' && (await zzDish('ZZ Import Toast'))?.version === toast?.version,
    counted(again.body?.data))

  // A price change, matched case-insensitively.
  const edited = await workbook([['zz import food', 'ZZ IMPORT  toast', 2500, 'kitchen']])
  const priced = await upload(manage, edited, { apply: true })
  const toast2 = await zzDish('ZZ Import Toast')
  check('a changed price updates the dish (matched ignoring case and spaces)',
    priced.status === 200 && counted(priced.body?.data) === '0/0 0/1 0/0 0/0' && toast2?.price_paisa === 250000 && toast2?.version === toast!.version + 1,
    `${priced.status} ${counted(priced.body?.data)}`)

  // Bad rows: every one listed, nothing written.
  const bad = await workbook([
    ['ZZ Import Food', 'ZZ Import Bad 1', 'abc', 'Kitchen'],
    ['ZZ Import Food', 'ZZ Import Bad 2', 2350.5, 'Kitchen'],
    ['ZZ Import Food', '', 100, 'Kitchen'],
    ['ZZ Import Food', 'X'.repeat(61), 100, 'Kitchen'],
    ['ZZ Import Food', 'ZZ Import Bad 3', 100, 'Kitchenette'],
    ['ZZ Import Food', 'ZZ Import Dup', 100, 'Bar'],
    ['ZZ Import Food', 'zz import dup', 100, 'Bar'],
  ])
  const refused = await upload(manage, bad, { apply: true })
  const rows = (refused.body?.data?.errors ?? []).map((e: any) => e.row)
  check('bad rows: 422, each row named, nothing written',
    refused.status === 422 && [2, 3, 4, 5, 6, 8].every((r) => rows.includes(r)) && !(await zzDish('ZZ Import Dup')),
    `${refused.status} ${JSON.stringify(refused.body?.data?.errors).slice(0, 300)}`)

  const orphan = await upload(manage, await workbook([], [['ZZ Import Food', 'ZZ Import Nothing', 'Size', 'One', 'No', 'Big', 100, 'No', 1]]))
  check('an option for an unknown dish is refused (422)', orphan.status === 422 && orphan.body?.data?.errors?.[0]?.sheet === 'Options',
    JSON.stringify(orphan.body).slice(0, 200))

  await sql(`UPDATE menu_items SET is_active = false WHERE id = $1`, [pizza?.id])
  const offDish = await upload(manage, await workbook([['ZZ Import Food', 'ZZ Import Pizza', 3000, 'Pizza kitchen']]))
  check('matching a switched-off dish is refused with a reason (422)',
    offDish.status === 422 && String(offDish.body?.data?.errors?.[0]?.message).includes('switched off'),
    JSON.stringify(offDish.body?.data?.errors))

  const notXlsx = await upload(manage, Buffer.from('hello'), { name: 'menu.csv' })
  check('not an .xlsx: 400', notXlsx.status === 400)
  const brokenXlsx = await upload(manage, Buffer.from('hello'))
  check('a broken .xlsx: 400 "not an Excel file"', brokenXlsx.status === 400 && JSON.stringify(brokenXlsx.body).includes('not an Excel'),
    JSON.stringify(brokenXlsx.body).slice(0, 160))

  // A sheet whose headings were deleted: refused, not read shifted.
  const book = new ExcelJS.Workbook()
  book.addWorksheet('Dishes').addRow(['ZZ Import Food', 'ZZ Import Shifted', 100, 'Kitchen'])
  const shifted = await upload(manage, Buffer.from(await book.xlsx.writeBuffer()))
  check('a sheet without its heading row is refused (400)', shifted.status === 400 && JSON.stringify(shifted.body).includes('headings'),
    JSON.stringify(shifted.body).slice(0, 160))

  // A blank cell on an existing group/option keeps the live value.
  const blank = await upload(manage, await workbook([], [['ZZ Import Drinks', 'ZZ Import Latte', 'Milk', '', '', 'Oat', '', '', '']]), { apply: true })
  const [milk] = await sql(`SELECT g.is_required, o.price_delta_paisa FROM modifier_options o JOIN modifier_groups g ON g.id = o.group_id
    WHERE g.menu_item_id = $1 AND o.name = 'Oat'`, [latte?.id])
  check('blank cells leave an existing option and its group as they are',
    blank.status === 200 && counted(blank.body?.data) === '0/0 0/0 0/0 0/0' && milk?.is_required === true && milk?.price_delta_paisa === 20000,
    `${blank.status} ${counted(blank.body?.data)} ${JSON.stringify(milk)} ${JSON.stringify(blank.body?.data?.errors ?? blank.body).slice(0, 200)}`)

  // A dish already on the menu in another category: flagged, not duplicated.
  const moved = await upload(manage, await workbook([['ZZ Import Drinks', 'ZZ Import Toast', 2500, 'Kitchen']]))
  check('a dish named under another category is refused, not duplicated (422)',
    moved.status === 422 && String(moved.body?.data?.errors?.[0]?.message).includes('already on the menu in ZZ Import Food'),
    JSON.stringify(moved.body?.data?.errors))
}

async function cleanup() {
  const cats = (await zzCategories()).map((c) => c.id)
  const items = (await sql(`SELECT id FROM menu_items WHERE category_id = ANY($1::uuid[])`, [cats])).map((r) => r.id)
  const groups = (await sql(`SELECT id FROM modifier_groups WHERE menu_item_id = ANY($1::uuid[])`, [items])).map((r) => r.id)
  const options = (await sql(`SELECT id FROM modifier_options WHERE group_id = ANY($1::uuid[])`, [groups])).map((r) => r.id)
  await sql(`UPDATE modifier_options SET is_active = false WHERE id = ANY($1::uuid[])`, [options])
  await sql(`UPDATE modifier_groups SET is_active = false WHERE id = ANY($1::uuid[])`, [groups])
  await sql(`UPDATE menu_items SET is_active = false WHERE id = ANY($1::uuid[])`, [items])
  await sql(`UPDATE menu_categories SET is_active = false WHERE id = ANY($1::uuid[])`, [cats])
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (['localhost', '127.0.0.1', '::1'].includes(host)) {
    try {
      await sql(`ALTER TABLE config_changes DISABLE TRIGGER immutable_config_changes`)
      await sql(`DELETE FROM config_changes WHERE row_id = ANY($1::uuid[])`, [[...cats, ...items, ...groups, ...options]])
    } finally {
      await sql(`ALTER TABLE config_changes ENABLE TRIGGER immutable_config_changes`).catch((error) =>
        console.error('!! COULD NOT RE-ENABLE immutable_config_changes !!', error),
      )
    }
    // Renamed so a next run starts clean (names are matched by the import).
    await sql(`UPDATE menu_categories SET name = 'ZZ Old ' || left(id::text, 8) WHERE id = ANY($1::uuid[])`, [cats])
    await sql(`UPDATE menu_items SET name = 'ZZ Old ' || left(id::text, 8) WHERE id = ANY($1::uuid[])`, [items])
  }
  await sql(`DELETE FROM staff_sessions WHERE id = ANY($1::uuid[])`, [staffSessions])
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
