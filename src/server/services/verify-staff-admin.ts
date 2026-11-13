/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Story 10.2 — staff accounts, through the service, on a throwaway tenant.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-staff-admin.ts
 *
 * No dev server needed. Everything lives in its own `ZZ Staff verify` tenant, so
 * the last-owner rule and PIN uniqueness are tested without touching the real
 * staff. Nothing references the people it makes (no orders), so on a local
 * database the cleanup deletes them, their sessions, their `config_changes`
 * (guard off only around that) and the tenant; anywhere else it only
 * deactivates them. It never prints a PIN or a hash.
 */
import bcrypt from 'bcryptjs'
import { sql as q } from 'drizzle-orm'
import { db } from '@/server/db'
import { MenuNotFoundError, MenuRuleError, StaleVersionError } from '@/server/services/menu-admin.service'
import {
  createStaff,
  deleteStaff,
  HasHistoryError,
  LastOwnerError,
  loadStaffForManage,
  NameTakenError,
  OwnAccountError,
  PinTakenError,
  setStaffActive,
  updateStaff,
} from '@/server/services/staff-admin.service'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const rows = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows as any[]
const write = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn)

/** Runs `fn` and checks it throws `kind` (and rolls back). */
async function refuses(name: string, kind: new (...args: any[]) => Error, fn: (tx: Tx) => Promise<unknown>) {
  try {
    await write(fn)
    check(name, false, 'it was allowed')
  } catch (error) {
    check(name, error instanceof kind, error instanceof Error ? error.constructor.name : String(error))
  }
}

let tenantId = ''
const staffRow = async (id: string) => (await rows(q`SELECT * FROM staff WHERE id = ${id}`))[0]

async function run() {
  tenantId = (await rows(q`INSERT INTO tenants (name) VALUES ('ZZ Staff verify') RETURNING id`))[0].id
  const bossHash = await bcrypt.hash('9001', 10)
  const bossId = (await rows(q`INSERT INTO staff (tenant_id, name, role, pin_hash)
    VALUES (${tenantId}, 'ZZ Boss', 'owner', ${bossHash}) RETURNING id`))[0].id as string
  const boss = { tenantId, staffId: bossId }

  // ── Create ────────────────────────────────────────────────────────────────
  const nimal = await write((tx) => createStaff(tx, { ...boss, name: '  ZZ   Nimal ', jobTitle: 'waiter', pin: '4101' }))
  const nimalRow = await staffRow(nimal.id)
  check('create: name tidied, version 1, active, no pinHash returned',
    nimal.name === 'ZZ Nimal' && nimal.version === 1 && nimal.isActive && !('pinHash' in nimal))
  check('create: the PIN is stored as a bcrypt hash, not the PIN',
    nimalRow.pin_hash.startsWith('$2') && nimalRow.pin_hash !== '4101' && (await bcrypt.compare('4101', nimalRow.pin_hash)))
  const logged = await rows(q`SELECT payload FROM config_changes WHERE row_id = ${nimal.id}`)
  check('create: one config_changes row, no pinHash, pinChanged true',
    logged.length === 1 && !('pinHash' in logged[0].payload) && logged[0].payload.pinChanged === true)

  // ── PIN and name uniqueness ───────────────────────────────────────────────
  await refuses('a PIN another active person uses is refused', PinTakenError,
    (tx) => createStaff(tx, { ...boss, name: 'ZZ Other', jobTitle: 'waiter', pin: '4101' }))
  await refuses('the boss PIN is refused too', PinTakenError,
    (tx) => createStaff(tx, { ...boss, name: 'ZZ Other', jobTitle: 'chef', pin: '9001' }))
  const old = await write((tx) => createStaff(tx, { ...boss, name: 'ZZ Old', jobTitle: 'chef', pin: '4102' }))
  check('the job sets the access: chef → kitchen, waiter → waiter', old.role === 'kitchen' && nimal.role === 'waiter')
  const bar = await write((tx) => createStaff(tx, { ...boss, name: 'ZZ Bar', jobTitle: 'bartender', pin: '4103' }))
  const barLog = await rows(q`SELECT payload FROM config_changes WHERE row_id = ${bar.id}`)
  check('a bartender gets orders-and-bills access; the job is logged', bar.jobTitle === 'bartender' && bar.role === 'waiter' &&
    barLog[0]?.payload.jobTitle === 'bartender')
  const oldOff = await write((tx) => setStaffActive(tx, { ...boss, id: old.id, version: old.version, active: false }))
  const fresh = await write((tx) => createStaff(tx, { ...boss, name: 'ZZ Fresh', jobTitle: 'waiter', pin: '4102' }))
  check('a PIN only an INACTIVE person had is allowed', fresh.isActive)
  await refuses('the same name in another case is refused', NameTakenError,
    (tx) => createStaff(tx, { ...boss, name: 'zz NIMAL', jobTitle: 'waiter', pin: '4150' }))

  // Two saves at once with the same PIN: the advisory lock lets only one through.
  const race = await Promise.allSettled([
    write((tx) => createStaff(tx, { ...boss, name: 'ZZ Race A', jobTitle: 'waiter', pin: '4160' })),
    write((tx) => createStaff(tx, { ...boss, name: 'ZZ Race B', jobTitle: 'waiter', pin: '4160' })),
  ])
  check('two simultaneous saves with one PIN: exactly one wins',
    race.filter((r) => r.status === 'fulfilled').length === 1 &&
      race.some((r) => r.status === 'rejected' && r.reason instanceof PinTakenError))

  // ── Edit ──────────────────────────────────────────────────────────────────
  await refuses('a stale version is refused', StaleVersionError,
    (tx) => updateStaff(tx, { ...boss, id: nimal.id, version: 99, name: 'ZZ Nimal P' }))
  const renamed = await write((tx) => updateStaff(tx, { ...boss, id: nimal.id, version: 1, name: 'ZZ Nimal P' }))
  check('rename: version 2', renamed.version === 2 && renamed.name === 'ZZ Nimal P')
  const repinned = await write((tx) => updateStaff(tx, { ...boss, id: fresh.id, version: fresh.version, pin: '4321' }))
  check('after a PIN change, login\'s bcrypt.compare matches the new PIN',
    await bcrypt.compare('4321', (await staffRow(fresh.id)).pin_hash))
  const repinLog = await rows(q`SELECT payload FROM config_changes WHERE row_id = ${fresh.id} ORDER BY created_at DESC LIMIT 1`)
  check('a PIN change is logged as pinChanged, without the hash', repinLog[0]?.payload.pinChanged === true && !('pinHash' in repinLog[0].payload))
  await refuses('changing a PIN to one in use is refused', PinTakenError,
    (tx) => updateStaff(tx, { ...boss, id: fresh.id, version: repinned.version, pin: '4101' }))

  // ── Role change follows the sessions at once ──────────────────────────────
  const session = (await rows(q`INSERT INTO staff_sessions (tenant_id, staff_id, role, expires_at)
    VALUES (${tenantId}, ${nimal.id}, 'waiter', now() + interval '1 hour') RETURNING id`))[0].id as string
  const promoted = await write((tx) => updateStaff(tx, { ...boss, id: nimal.id, version: renamed.version, jobTitle: 'owner' }))
  check('job waiter → owner rewrites their session role',
    (await rows(q`SELECT role FROM staff_sessions WHERE id = ${session}`))[0]?.role === 'owner')
  await rows(q`INSERT INTO manage_sessions (staff_session_id) VALUES (${session}) RETURNING id`)
  const demoted = await write((tx) => updateStaff(tx, { ...boss, id: nimal.id, version: promoted.version, jobTitle: 'waiter' }))
  check('owner → waiter: session role waiter, Manage closed',
    (await rows(q`SELECT role FROM staff_sessions WHERE id = ${session}`))[0]?.role === 'waiter' &&
      (await rows(q`SELECT 1 FROM manage_sessions WHERE staff_session_id = ${session}`)).length === 0)

  // ── Deactivate / reactivate ───────────────────────────────────────────────
  const nimalOff = await write((tx) => setStaffActive(tx, { ...boss, id: nimal.id, version: demoted.version, active: false }))
  check('deactivate: inactive, their sessions deleted',
    !nimalOff.isActive && (await rows(q`SELECT 1 FROM staff_sessions WHERE staff_id = ${nimal.id}`)).length === 0)
  await refuses('reactivate with a PIN someone took meanwhile is refused', PinTakenError,
    (tx) => setStaffActive(tx, { ...boss, id: old.id, version: oldOff.version, active: true, pin: '4321' }))
  await refuses('reactivate without a PIN is refused', MenuRuleError,
    (tx) => setStaffActive(tx, { ...boss, id: old.id, version: oldOff.version, active: true }))
  const oldBack = await write((tx) => setStaffActive(tx, { ...boss, id: old.id, version: oldOff.version, active: true, pin: '4199' }))
  check('reactivate with a free PIN works', oldBack.isActive && (await bcrypt.compare('4199', (await staffRow(old.id)).pin_hash)))
  await write((tx) => createStaff(tx, { ...boss, name: 'zz nimal p', jobTitle: 'waiter', pin: '4170' }))
  await refuses('reactivate when someone active took the name is refused', NameTakenError,
    (tx) => setStaffActive(tx, { ...boss, id: nimal.id, version: nimalOff.version, active: true, pin: '4171' }))

  // ── Last owner, own account ───────────────────────────────────────────────
  const asWaiter = { tenantId, staffId: fresh.id }
  const bossVersion = () => staffRow(bossId).then((r) => r.version as number)
  await refuses('deactivating the only active owner is refused', LastOwnerError,
    async (tx) => setStaffActive(tx, { ...asWaiter, id: bossId, version: await bossVersion(), active: false }))
  await refuses('demoting the only active owner is refused', LastOwnerError,
    async (tx) => updateStaff(tx, { ...asWaiter, id: bossId, version: await bossVersion(), jobTitle: 'waiter' }))
  await refuses('changing your own role is refused', OwnAccountError,
    async (tx) => updateStaff(tx, { ...boss, id: bossId, version: await bossVersion(), jobTitle: 'waiter' }))
  await refuses('deactivating yourself is refused', OwnAccountError,
    async (tx) => setStaffActive(tx, { ...boss, id: bossId, version: await bossVersion(), active: false }))
  const selfRename = await write(async (tx) => updateStaff(tx, { ...boss, id: bossId, version: await bossVersion(), name: 'ZZ Boss Two' }))
  check('renaming yourself is allowed', selfRename.name === 'ZZ Boss Two')
  await refuses('changing your own job (and so your access) is refused', OwnAccountError,
    async (tx) => updateStaff(tx, { ...boss, id: bossId, version: await bossVersion(), jobTitle: 'cashier' }))

  // ── Validation, tenant ────────────────────────────────────────────────────
  await refuses('job "manager" is refused', MenuRuleError,
    (tx) => createStaff(tx, { ...boss, name: 'ZZ Bad', jobTitle: 'manager', pin: '4180' }))
  await refuses('a 3-digit PIN is refused', MenuRuleError,
    (tx) => createStaff(tx, { ...boss, name: 'ZZ Bad', jobTitle: 'waiter', pin: '418' }))
  await refuses('a 41-character name is refused', MenuRuleError,
    (tx) => createStaff(tx, { ...boss, name: 'Z'.repeat(41), jobTitle: 'waiter', pin: '4180' }))
  const elsewhere = (await rows(q`SELECT id, version FROM staff WHERE tenant_id <> ${tenantId} LIMIT 1`))[0]
  if (elsewhere) {
    await refuses('another tenant\'s person is not found', MenuNotFoundError,
      (tx) => updateStaff(tx, { ...boss, id: elsewhere.id, version: elsewhere.version, name: 'ZZ Hijack' }))
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const oops = await write((tx) => createStaff(tx, { ...boss, name: 'ZZ Oops', jobTitle: 'helper', pin: '4190' }))
  await rows(q`INSERT INTO staff_sessions (tenant_id, staff_id, role, expires_at)
    VALUES (${tenantId}, ${oops.id}, 'waiter', now() + interval '1 hour')`)
  await refuses('delete with a stale version is refused', StaleVersionError,
    (tx) => deleteStaff(tx, { ...boss, id: oops.id, version: 99 }))
  await write((tx) => deleteStaff(tx, { ...boss, id: oops.id, version: oops.version }))
  const oopsLog = await rows(q`SELECT payload FROM config_changes WHERE row_id = ${oops.id} ORDER BY created_at DESC LIMIT 1`)
  check('someone with no history is deleted (sessions too), and the delete is logged',
    !(await staffRow(oops.id)) && (await rows(q`SELECT 1 FROM staff_sessions WHERE staff_id = ${oops.id}`)).length === 0 &&
      oopsLog[0]?.payload.deleted === true)
  // A second owner who has made a change (config_changes.staff_id points at them).
  const helperOwner = await write((tx) => createStaff(tx, { ...boss, name: 'ZZ Co-owner', jobTitle: 'owner', pin: '4191' }))
  await write((tx) => createStaff(tx, { tenantId, staffId: helperOwner.id, name: 'ZZ Made by co', jobTitle: 'helper', pin: '4192' }))
  await refuses('someone with history is not deleted (deactivate instead)', HasHistoryError,
    (tx) => deleteStaff(tx, { ...boss, id: helperOwner.id, version: helperOwner.version }))
  check('the refused delete left them in place', !!(await staffRow(helperOwner.id)))
  await refuses('deleting yourself is refused', OwnAccountError,
    async (tx) => deleteStaff(tx, { ...boss, id: bossId, version: await bossVersion() }))

  // ── The list, and the log never holds a hash ──────────────────────────────
  const list = await loadStaffForManage(db, tenantId)
  const order = list.filter((p) => p.isActive).map((p) => p.role)
  const sorted = [...order].sort((x, y) => ['owner', 'waiter', 'kitchen'].indexOf(x) - ['owner', 'waiter', 'kitchen'].indexOf(y))
  check('list: Owner, Waiter, Kitchen order; no pinHash', JSON.stringify(order) === JSON.stringify(sorted) &&
    list.every((p) => !('pinHash' in p)) && list.some((p) => !p.isActive))
  const leaks = await rows(q`SELECT 1 FROM config_changes WHERE table_name = 'staff' AND tenant_id = ${tenantId}
    AND (payload ? 'pinHash' OR payload::text LIKE '%$2%')`)
  const total = await rows(q`SELECT 1 FROM config_changes WHERE table_name = 'staff' AND tenant_id = ${tenantId}`)
  check('no staff config_changes payload holds pinHash or a bcrypt string', leaks.length === 0 && total.length > 5,
    `${total.length} rows`)
}

async function cleanup() {
  if (!tenantId) return
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  const local = ['localhost', '127.0.0.1', '::1'].includes(host)
  await db.execute(q`DELETE FROM staff_sessions WHERE tenant_id = ${tenantId}`)
  if (!local) {
    await db.execute(q`UPDATE staff SET is_active = false WHERE tenant_id = ${tenantId}`)
    return
  }
  try {
    await db.execute(q`ALTER TABLE config_changes DISABLE TRIGGER immutable_config_changes`)
    await db.execute(q`DELETE FROM config_changes WHERE tenant_id = ${tenantId}`)
  } finally {
    await db.execute(q`ALTER TABLE config_changes ENABLE TRIGGER immutable_config_changes`).catch((error) =>
      console.error('!! COULD NOT RE-ENABLE immutable_config_changes !!', error),
    )
  }
  await db.execute(q`DELETE FROM staff WHERE tenant_id = ${tenantId}`)
  await db.execute(q`DELETE FROM tenants WHERE id = ${tenantId}`)
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
