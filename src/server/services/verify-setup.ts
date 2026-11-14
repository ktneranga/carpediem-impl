/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * First-run setup (spec-first-run-setup), through the service.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-setup.ts
 *
 * Setup only works on an EMPTY install, and the dev database has a restaurant.
 * So the full path runs on a throwaway database on the same local server
 * (`cdrms_setup_verify`): created, migrated with drizzle-kit, used, dropped.
 * Local databases only.
 */
import bcrypt from 'bcryptjs'
import { execSync } from 'node:child_process'
import { sql as q } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { db } from '@/server/db'
import { AlreadySetUpError, checkSetup, runSetup, SetupFieldError, type SetupInput } from '@/server/services/setup.service'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const TEMP = 'cdrms_setup_verify'
const base = new URL(process.env.DATABASE_URL ?? 'postgres://x')
const tempUrl = new URL(base.toString())
tempUrl.pathname = `/${TEMP}`
let tempPool: Pool | null = null
/** Only a run that created the temp database drops it. */
let createdTemp = false

const GOOD: SetupInput = {
  restaurantName: '  ZZ  Setup   Cafe ',
  timeZone: 'Asia/Colombo',
  ownerName: 'ZZ Olga',
  pin: '2468',
  managePassword: 'correct horse',
}

function fieldOf(input: Partial<SetupInput>): string | null {
  try {
    checkSetup({ ...GOOD, ...input })
    return null
  } catch (error) {
    return error instanceof SetupFieldError ? error.field : 'other'
  }
}

async function dropTemp() {
  await db.execute(q.raw(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${TEMP}' and pid <> pg_backend_pid()`))
  await db.execute(q.raw(`drop database if exists ${TEMP}`))
}

async function run() {
  if (!['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    console.log('SKIP: not a local database')
    return
  }

  // ── Validation ─────────────────────────────────────────────────────────────
  check('a good form passes, name cleaned', checkSetup(GOOD).restaurantName === 'ZZ Setup Cafe')
  check('empty restaurant name → restaurantName', fieldOf({ restaurantName: '   ' }) === 'restaurantName')
  check('not a time zone → timeZone', fieldOf({ timeZone: 'Mars/Base' }) === 'timeZone' && fieldOf({ timeZone: 'colombo' }) === 'timeZone')
  check('empty owner name → ownerName', fieldOf({ ownerName: ' ' }) === 'ownerName')
  check('PIN not 4 digits → pin', fieldOf({ pin: '12a4' }) === 'pin' && fieldOf({ pin: '12345' }) === 'pin')
  check('password under 8 → managePassword', fieldOf({ managePassword: 'short' }) === 'managePassword')

  // ── An install that already has a restaurant ──────────────────────────────
  // Only when the dev database HAS a restaurant: on an empty one this would
  // really set it up with test credentials.
  const before = Number((await db.execute(q`select count(*)::int as n from tenants`)).rows[0]!.n)
  if (before > 0) {
    let refused = false
    try {
      await runSetup(GOOD)
    } catch (error) {
      refused = error instanceof AlreadySetUpError
    }
    const after = Number((await db.execute(q`select count(*)::int as n from tenants`)).rows[0]!.n)
    check('with a restaurant already there, setup is refused and writes nothing', refused && after === before, `${before}→${after}`)
  } else {
    console.log('SKIP "already set up" on the dev database: it has no restaurant (not setting it up)')
  }
  check('a time zone is stored in its standard spelling', checkSetup({ ...GOOD, timeZone: 'asia/colombo' }).timeZone === 'Asia/Colombo')

  // ── An empty install ───────────────────────────────────────────────────────
  await dropTemp()
  await db.execute(q.raw(`create database ${TEMP}`))
  createdTemp = true
  execSync('npx drizzle-kit migrate', { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: tempUrl.toString() }, stdio: 'ignore' })
  tempPool = new Pool({ connectionString: tempUrl.toString(), max: 4 })
  const temp = drizzle(tempPool) as unknown as typeof db
  const one = async (text: ReturnType<typeof q>) => (await temp.execute(text)).rows[0] as any

  check('the empty install has every table and no restaurant',
    (await one(q`select count(*)::int as n from tenants`)).n === 0 &&
      (await one(q`select count(*)::int as n from information_schema.tables where table_name = 'vendor_access_events'`)).n === 1)

  // Two submits at once: one restaurant.
  const race = await Promise.allSettled([runSetup(GOOD, temp), runSetup({ ...GOOD, restaurantName: 'ZZ Second' }, temp)])
  const won = race.filter((r) => r.status === 'fulfilled')
  const lost = race.filter((r) => r.status === 'rejected')
  check('two submits at once: exactly one restaurant, the other refused',
    won.length === 1 && lost.length === 1 && (lost[0] as PromiseRejectedResult).reason instanceof AlreadySetUpError &&
      (await one(q`select count(*)::int as n from tenants`)).n === 1)

  const tenant = await one(q`select * from tenants`)
  const config = await one(q`select * from tenant_config where tenant_id = ${tenant.id}`)
  const owner = await one(q`select * from staff where tenant_id = ${tenant.id}`)
  check('the restaurant: name, zone, business day default',
    ['ZZ Setup Cafe', 'ZZ Second'].includes(tenant.name) && tenant.timezone === 'Asia/Colombo' && tenant.business_day_start_hour === 4)
  check('its config carries the name', config?.restaurant_name === tenant.name)
  check('the owner: role owner, job Owner, active', owner?.role === 'owner' && owner.job_title === 'owner' && owner.is_active === true && owner.name === 'ZZ Olga')
  check('the PIN and the Manage password are stored hashed and match',
    owner.pin_hash !== '2468' && (await bcrypt.compare('2468', owner.pin_hash)) && (await bcrypt.compare('correct horse', tenant.manage_password_hash)))
  const change = await one(q`select payload from config_changes where row_id = ${owner.id}`)
  check('the owner is in the config record, without the PIN hash', !!change && !JSON.stringify(change.payload).includes('$2'))

  let again = false
  try {
    await runSetup(GOOD, temp)
  } catch (error) {
    again = error instanceof AlreadySetUpError
  }
  check('setup again after it worked is refused', again)
}

run()
  .catch((error) => {
    results.push(false)
    console.error(error)
  })
  .finally(async () => {
    await tempPool?.end().catch(() => undefined)
    if (createdTemp) await dropTemp().catch((error) => console.error('could not drop the temp database:', error))
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
    process.exit(results.every(Boolean) ? 0 : 1)
  })
