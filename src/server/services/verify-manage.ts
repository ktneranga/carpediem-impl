/* eslint-disable @typescript-eslint/no-explicit-any -- reads arbitrary API JSON; nothing here is imported by the app. */
/**
 * Story 10.0 — the Manage area and its password, verified through the real
 * routes and the proxy. The story's 18-case Testing table.
 *
 *   pnpm exec tsx --env-file=.env src/server/services/verify-manage.ts
 *
 * The DEV SERVER MUST BE RUNNING (pnpm dev).
 *
 * It leaves the restaurant as it found it. With no Manage password set, it
 * sets one, uses it and clears it. With one already set it refuses to run
 * unless VERIFY_MANAGE_PASSWORD holds it, and then puts the original hash,
 * count and lock back at the end. It deletes exactly the POS sessions it made.
 * Case 17 runs the reset command, which ends EVERY Manage session.
 */
import { execSync } from 'node:child_process'
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'
import { safeManagePath } from '../../lib/return-to'

const BASE = process.env.VERIFY_BASE ?? 'http://localhost:3000'
const OWNER_PIN = process.env.VERIFY_OWNER_PIN ?? '5678'
const WAITER_PIN = process.env.VERIFY_WAITER_PIN ?? '1234'
const PASSWORD = 'verify-manage-pw-10.0'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
const sql = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}

const myStaffSessions: string[] = []
let tenantId = ''
let original: { hash: string | null; attempts: number; locked: Date | null } | null = null

// ── HTTP ─────────────────────────────────────────────────────────────────────
const idOf = (cookie: string) => cookie.split('=')[1]!.split('.')[0]!

async function login(pin: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
  const setCookie = response.headers.get('set-cookie')
  if (!response.ok || !setCookie) throw new Error(`login ${pin} failed: ${response.status}`)
  const cookie = setCookie.split(';')[0]!
  myStaffSessions.push(idOf(cookie))
  return cookie
}

type Res = { status: number; body: any; location: string | null; manageCookie: string | null; text: string }

async function call(cookies: (string | null)[], path: string, init?: RequestInit): Promise<Res> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      cookie: cookies.filter(Boolean).join('; '),
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    // a page
  }
  const manage = response.headers
    .getSetCookie()
    .find((c) => c.startsWith('__cdrms_manage=') && !c.startsWith('__cdrms_manage=;'))
  return {
    status: response.status,
    body,
    location: response.headers.get('location'),
    manageCookie: manage ? manage.split(';')[0]! : null,
    text,
  }
}

const post = (cookies: (string | null)[], path: string, body?: unknown) =>
  call(cookies, path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

const unlock = (pos: string, password: string) => post([pos], '/api/manage/unlock', { password })

/** A gated API path. No route lives there, so "through the gate" is a 404, "locked" a 401. */
const GATED_API = '/api/manage/verify-probe'
const isLocked = (res: Res) => res.status === 401 && res.body?.error?.code === 'MANAGE_LOCKED'

const tenantRow = async () =>
  (await sql(
    `SELECT manage_password_hash AS hash, manage_failed_attempts AS attempts, manage_locked_until AS locked
       FROM tenants WHERE id = $1`,
    [tenantId],
  ))[0]
const manageRows = async (staffSessionId: string) =>
  Number((await sql(`SELECT count(*)::int AS n FROM manage_sessions WHERE staff_session_id = $1`, [staffSessionId]))[0].n)

// ── The matrix ───────────────────────────────────────────────────────────────
async function run() {
  ;[{ id: tenantId }] = await sql(`SELECT id FROM tenants LIMIT 1`)
  const before = await tenantRow()
  original = { hash: before.hash, attempts: before.attempts, locked: before.locked }

  if (before.hash) {
    const given = process.env.VERIFY_MANAGE_PASSWORD
    if (!given || !(await bcrypt.compare(given, before.hash))) {
      throw new Error(
        'A Manage password is already set. Run with VERIFY_MANAGE_PASSWORD=<it> (it is restored afterwards).',
      )
    }
    // Start from "not set"; the original is put back in cleanup.
    await sql(
      `UPDATE tenants SET manage_password_hash = NULL, manage_failed_attempts = 0, manage_locked_until = NULL WHERE id = $1`,
      [tenantId],
    )
  }

  const owner = await login(OWNER_PIN)

  // 1
  const r1 = await call([owner], '/manage/menu')
  check(
    '1 no password: /manage/menu → unlock?next=/manage/menu',
    r1.status === 307 && (r1.location ?? '').endsWith('/manage/unlock?next=%2Fmanage%2Fmenu'),
    `${r1.status} ${r1.location}`,
  )
  const r1b = await call([owner], '/manage/unlock')
  check('1b unlock screen reachable, asks to choose one', r1b.status === 200 && r1b.text.includes('Choose a password'), String(r1b.status))

  // 2
  const short = await post([owner], '/api/manage/password', { password: '7chars!' })
  const long = await post([owner], '/api/manage/password', { password: 'é'.repeat(36) + 'x' }) // 73 bytes
  const afterBad = await tenantRow()
  check(
    '2 password 7 chars / 73 bytes → 400, nothing stored',
    short.status === 400 && long.status === 400 && afterBad.hash === null,
    `${short.status} ${long.status}`,
  )
  check('2b error does not echo the password', !JSON.stringify([short.body, long.body]).includes('7chars!'))

  // 5 (before any unlock)
  check('5 fresh owner, gated API without unlock → 401 MANAGE_LOCKED', isLocked(await call([owner], GATED_API)))

  // 3
  const set = await post([owner], '/api/manage/password', { password: PASSWORD })
  const afterSet = await tenantRow()
  check(
    '3 set → 201 + Manage cookie, bcrypt hash, no plain text',
    set.status === 201 && !!set.manageCookie && String(afterSet.hash).startsWith('$2') &&
      !JSON.stringify(afterSet).includes(PASSWORD),
    `${set.status} cookie=${!!set.manageCookie}`,
  )
  const manageA = set.manageCookie!
  const page = await call([owner, manageA], '/manage/menu')
  check('3b Manage pages load after setting', page.status === 200 && page.text.includes('Coming with Story'), String(page.status))
  check('3c /manage → /manage/menu', (await call([owner, manageA], '/manage')).status === 307)
  check('3d gated API passes the gate (404 from no route)', (await call([owner, manageA], GATED_API)).status === 404)

  // 4
  const again = await post([owner], '/api/manage/password', { password: 'another-one-123' })
  check('4 set again → 409 ALREADY_SET', again.status === 409 && again.body?.error?.code === 'ALREADY_SET', String(again.status))

  // 6
  const owner2 = await login(OWNER_PIN)
  const u6 = await unlock(owner2, PASSWORD)
  check('6 unlock with the right password → 200', u6.status === 200 && !!u6.manageCookie, String(u6.status))
  check('6b Manage pages load', (await call([owner2, u6.manageCookie], '/manage/staff')).status === 200)

  // 13, 14
  const owner3 = await login(OWNER_PIN)
  check('13 same owner, another login → locked until it unlocks', isLocked(await call([owner3], GATED_API)))
  check("14 session A's Manage cookie with session B's POS cookie → refused", isLocked(await call([owner3, manageA], GATED_API)))

  // 7
  const left: number[] = []
  let all401 = true
  for (let i = 0; i < 4; i++) {
    const res = await unlock(owner3, 'wrong-password-x')
    all401 &&= res.status === 401 && res.body?.error?.code === 'WRONG_PASSWORD'
    left.push(res.body?.error?.attemptsLeft)
  }
  const u7 = await unlock(owner3, PASSWORD)
  check(
    '7 4 wrong (attemptsLeft 4→1), then right → 200, count 0',
    all401 && left.join(',') === '4,3,2,1' && u7.status === 200 && (await tenantRow()).attempts === 0,
    `${left.join(',')} then ${u7.status}`,
  )

  // 8
  const statuses8: number[] = []
  let r8: Res | null = null
  for (let i = 0; i < 5; i++) {
    r8 = await unlock(owner3, 'wrong-password-x')
    statuses8.push(r8.status)
  }
  const right8 = await unlock(owner3, PASSWORD)
  check(
    '8 5 wrong → 5th is 429 with Retry-After; right one during lock → 429',
    statuses8.join(',') === '401,401,401,401,429' && r8!.body?.error?.retryAfterSeconds > 0 && right8.status === 429,
    `${statuses8.join(',')} then ${right8.status}`,
  )
  const lockPage = await call([owner3], '/manage/unlock')
  check('8b unlock screen says how long to wait', lockPage.text.includes('Try again in'))

  // 10
  await sql(`UPDATE tenants SET manage_locked_until = now() - interval '1 second' WHERE id = $1`, [tenantId])
  const u10 = await unlock(owner3, PASSWORD)
  check('10 lock expired → right password 200', u10.status === 200, String(u10.status))

  // 9
  const burst = await Promise.all(Array.from({ length: 6 }, () => unlock(owner3, 'wrong-password-x')))
  const n401 = burst.filter((r) => r.status === 401).length
  const n429 = burst.filter((r) => r.status === 429).length
  const row9 = await tenantRow()
  const lockSeconds = Number(
    (await sql(`SELECT extract(epoch from (manage_locked_until - now())) AS s FROM tenants WHERE id = $1`, [tenantId]))[0].s,
  )
  check(
    '9 6 wrong at once → exactly 4 counted wrong, then locked; lock ≈ 5 min, count reset',
    n401 === 4 && n429 === 2 && row9.attempts === 0 && lockSeconds > 280 && lockSeconds <= 300,
    `401×${n401} 429×${n429} lock ${Math.round(lockSeconds)}s`,
  )
  await sql(`UPDATE tenants SET manage_locked_until = NULL, manage_failed_attempts = 0 WHERE id = $1`, [tenantId])

  // 11
  const manage2 = u6.manageCookie!
  await sql(
    `UPDATE manage_sessions SET last_active_at = now() - interval '16 minutes' WHERE staff_session_id = $1`,
    [idOf(owner2)],
  )
  const r11 = await call([owner2, manage2], GATED_API)
  const tables11 = await call([owner2], '/api/tables')
  check(
    '11 Manage idle 16 min → 401 MANAGE_LOCKED; POS session still works',
    isLocked(r11) && tables11.status === 200 && (await manageRows(idOf(owner2))) === 0,
    `${r11.status} tables ${tables11.status}`,
  )
  const page11 = await call([owner2, manage2], '/manage/menu')
  check('11b idle Manage page → unlock screen', page11.status === 307 && (page11.location ?? '').includes('/manage/unlock'))

  // 18
  const owner4 = await login(OWNER_PIN)
  const u18 = await unlock(owner4, PASSWORD)
  const lock = await post([owner4, u18.manageCookie], '/api/manage/lock')
  check(
    '18 Lock → row gone, next Manage request locked',
    lock.status === 200 && (await manageRows(idOf(owner4))) === 0 && isLocked(await call([owner4, u18.manageCookie], GATED_API)),
    String(lock.status),
  )
  check('18b Lock with no Manage session → 200', (await post([owner4], '/api/manage/lock')).status === 200)

  // 12
  const u12 = await unlock(owner4, PASSWORD)
  const had = await manageRows(idOf(owner4))
  await post([owner4], '/api/auth/logout')
  check('12 logout → Manage session row gone', u12.status === 200 && had === 1 && (await manageRows(idOf(owner4))) === 0)

  // 15
  const waiter = await login(WAITER_PIN)
  const w1 = await call([waiter], '/manage')
  const w2 = await post([waiter], '/api/manage/unlock', { password: PASSWORD })
  const w3 = await call([waiter], '/manage/unlock')
  check(
    '15 waiter: /manage → /, /api/manage/unlock → 403, /manage/unlock → /',
    w1.status === 307 && new URL(w1.location!, BASE).pathname === '/' && w2.status === 403 &&
      w3.status === 307 && new URL(w3.location!, BASE).pathname === '/',
    `${w1.status} ${w1.location} · ${w2.status} · ${w3.status}`,
  )
  check('15b /manager-notes is not gated as Manage', !isLocked(await call([owner3], '/api/manager-notes')))

  // 16
  const evil = ['https://evil.example', '//evil.example', '/\\evil.example', '/manage/unlock', '/orders/x']
  check(
    '16 next off-site or outside Manage → /manage',
    evil.every((n) => safeManagePath(n) === '/manage') && safeManagePath('/manage/staff') === '/manage/staff',
    evil.map(safeManagePath).join(' '),
  )
  const e1 = await call([owner3], '/manage/unlock?next=https%3A%2F%2Fevil.example')
  const e2 = await call([owner3], '/manage/unlock?next=%2F%2Fevil.example')
  // Next's router state echoes the request URL, so the page TEXT contains it
  // whatever we do; what matters is the `next` the form is given.
  const formNext = (text: string) => /\\"next\\":\\"([^\\"]*)\\"/.exec(text)?.[1]
  check(
    '16b unlock form is given next=/manage for an evil next',
    e1.status === 200 && e2.status === 200 && formNext(e1.text) === '/manage' && formNext(e2.text) === '/manage',
    `${formNext(e1.text)} ${formNext(e2.text)}`,
  )

  // 17
  execSync('pnpm manage:reset-password', { stdio: 'inherit' })
  const r17 = await tenantRow()
  const sessions17 = Number((await sql(`SELECT count(*)::int AS n FROM manage_sessions`))[0].n)
  check(
    '17 reset → hash null, count 0, lock null, no Manage sessions',
    r17.hash === null && r17.attempts === 0 && r17.locked === null && sessions17 === 0,
  )
  check('17b next owner entry sets a new one', (await call([owner3], '/manage/unlock')).text.includes('Choose a password'))
}

async function cleanup() {
  try {
    if (original && tenantId) {
      await sql(
        `UPDATE tenants SET manage_password_hash = $2, manage_failed_attempts = $3, manage_locked_until = $4 WHERE id = $1`,
        [tenantId, original.hash, original.attempts, original.locked],
      )
    }
    if (myStaffSessions.length) {
      // Cascades to their Manage sessions.
      await sql(`DELETE FROM staff_sessions WHERE id = ANY($1::uuid[])`, [myStaffSessions])
    }
  } catch (error) {
    console.error('cleanup failed:', error)
  }
}

async function main() {
  try {
    await run()
  } catch (error) {
    console.error(error)
    results.push(false)
  } finally {
    await cleanup()
  }
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

void main()
