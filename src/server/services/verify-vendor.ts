/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Vendor access (spec-11-1-vendor-access-export), through the service and the
 * export route handler, on a throwaway tenant.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-vendor.ts
 *
 * The live dump needs pg_dump where the app runs (the Docker image has it);
 * here the route is checked up to starting it, and a missing binary is a 503.
 * Cleanup on a local database only.
 */
import { sql as q } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { db } from '@/server/db'
import { signSessionId } from '@/server/auth/session-cookie'
import {
  checkVendorPassword,
  dumpFilename,
  lastVendorAccess,
  recordExport,
  resetVendorLockoutForTests,
  startVendorSession,
  validateVendorSession,
  VENDOR_COOKIE_NAME,
  vendorConfigured,
} from '@/server/services/vendor.service'
import { GET as exportRoute } from '@/app/api/vendor/export/route'
import { POST as loginRoute } from '@/app/api/vendor/login/route'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const rows = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows as any[]
const one = async (text: ReturnType<typeof q>) => (await rows(text))[0]
const tenantIds: string[] = []
const SECRET = 'zz-vendor-secret-for-verify-0123'
let startedAt = new Date().toISOString()

async function exportWith(cookie: string | null, accept = 'application/json') {
  const request = new NextRequest('http://localhost/api/vendor/export', {
    headers: { accept, ...(cookie ? { cookie: `${VENDOR_COOKIE_NAME}=${cookie}` } : {}) },
  })
  const response = await exportRoute(request)
  const body = response.headers.get('content-type')?.includes('json') ? await response.json() : null
  return { status: response.status, body }
}

async function run() {
  startedAt = (await one(q`SELECT clock_timestamp()::text AS t`)).t
  // ── Configuration ──────────────────────────────────────────────────────────
  const saved = process.env.VENDOR_SECRET
  process.env.VENDOR_SECRET = 'short'
  check('a secret under 16 characters turns vendor access off', !vendorConfigured() && !checkVendorPassword('short').ok)
  delete process.env.VENDOR_SECRET
  const off = checkVendorPassword('anything')
  check('no secret: VENDOR_DISABLED', !off.ok && off.code === 'VENDOR_DISABLED')
  process.env.VENDOR_SECRET = SECRET

  // ── Password and lockout ───────────────────────────────────────────────────
  resetVendorLockoutForTests()
  check('the right password passes', checkVendorPassword(SECRET).ok)
  const wrong = checkVendorPassword('nope')
  check('a wrong password: INVALID_PASSWORD', !wrong.ok && wrong.code === 'INVALID_PASSWORD')
  for (let i = 0; i < 4; i += 1) checkVendorPassword('nope')
  const locked = checkVendorPassword(SECRET)
  check('5 wrong in a row lock it, even the right password next', !locked.ok && locked.code === 'LOCKED' && locked.minutes === 15)
  check('the lock lifts after 15 minutes', checkVendorPassword(SECRET, Date.now() + 15 * 60 * 1000 + 1).ok)
  resetVendorLockoutForTests()
  const t0 = Date.now()
  for (let i = 0; i < 4; i += 1) checkVendorPassword('nope', t0)
  checkVendorPassword('nope', t0 + 16 * 60 * 1000)
  check('wrong tries spread beyond 15 minutes do not add up to a lock', checkVendorPassword(SECRET, t0 + 16 * 60 * 1000 + 1).ok)
  resetVendorLockoutForTests()
  process.env.VENDOR_SECRET = 'x'.repeat(600)
  check('a long secret (600 characters) can still be typed in', checkVendorPassword('x'.repeat(600)).ok)
  process.env.VENDOR_SECRET = SECRET

  // ── Sessions ───────────────────────────────────────────────────────────────
  const tenantId = (await one(q`INSERT INTO tenants (name) VALUES ('ZZ Vendor verify') RETURNING id`)).id as string
  tenantIds.push(tenantId)
  const none = await lastVendorAccess(tenantId)
  check('the owner sees "never" before any vendor access', none.signIn === null && none.export === null)

  const cookie = await startVendorSession(tenantId)
  const session = await validateVendorSession(cookie)
  check('sign-in writes a sign_in row and its cookie is a live session', session?.tenantId === tenantId &&
    (await one(q`SELECT count(*)::int AS n FROM vendor_access_events WHERE tenant_id = ${tenantId} AND kind = 'sign_in'`)).n === 1)
  check('a forged cookie is refused', (await validateVendorSession(cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))) === null)
  check('no cookie is refused', (await validateVendorSession(undefined)) === null)

  const exportRow = (await one(q`INSERT INTO vendor_access_events (tenant_id, kind) VALUES (${tenantId}, 'export') RETURNING id`)).id as string
  check('a signed id of an EXPORT row is not a session', (await validateVendorSession(signSessionId(exportRow))) === null)
  const old = (await one(q`INSERT INTO vendor_access_events (tenant_id, kind, created_at)
    VALUES (${tenantId}, 'sign_in', clock_timestamp() - interval '31 minutes') RETURNING id`)).id as string
  check('a sign-in older than 30 minutes has expired', (await validateVendorSession(signSessionId(old))) === null)

  let immutable = false
  try {
    await rows(q`UPDATE vendor_access_events SET kind = 'export' WHERE id = ${old}`)
  } catch {
    immutable = true
  }
  check('vendor access records cannot be changed', immutable)

  // ── The export route ───────────────────────────────────────────────────────
  const noCookie = await exportWith(null)
  check('export without a vendor sign-in: 401', noCookie.status === 401 && noCookie.body?.error?.code === 'VENDOR_SIGN_IN_REQUIRED')
  const before = (await one(q`SELECT count(*)::int AS n FROM vendor_access_events WHERE tenant_id = ${tenantId} AND kind = 'export'`)).n
  const savedPath = process.env.PG_DUMP_PATH
  // The failure cases run pg_dump directly, not through the dev container.
  const savedContainer = process.env.PG_DUMP_DOCKER_CONTAINER
  delete process.env.PG_DUMP_DOCKER_CONTAINER
  process.env.PG_DUMP_PATH = 'zz-no-such-pg-dump'
  const missing = await exportWith(cookie)
  const after = (await one(q`SELECT count(*)::int AS n FROM vendor_access_events WHERE tenant_id = ${tenantId} AND kind = 'export'`)).n
  check('pg_dump missing: 503 PG_DUMP_MISSING, and no export recorded',
    missing.status === 503 && missing.body?.error?.code === 'PG_DUMP_MISSING' && after === before, `${missing.status} ${before}→${after}`)
  // A "pg_dump" that starts and fails before writing (here: node, which
  // rejects pg_dump's options) must be a 502, not a 200 with an empty file.
  process.env.PG_DUMP_PATH = process.execPath
  const failed = await exportWith(cookie)
  const afterFail = (await one(q`SELECT count(*)::int AS n FROM vendor_access_events WHERE tenant_id = ${tenantId} AND kind = 'export'`)).n
  check('pg_dump that fails before any byte: 502 EXPORT_FAILED, no export recorded',
    failed.status === 502 && failed.body?.error?.code === 'EXPORT_FAILED' && afterFail === before, `${failed.status} ${afterFail}`)
  // The real thing, where pg_dump can run (the Docker image, or a dev PC with
  // PG_DUMP_DOCKER_CONTAINER): a 200 stream that is a pg_dump custom file.
  delete process.env.PG_DUMP_PATH
  if (savedContainer) process.env.PG_DUMP_DOCKER_CONTAINER = savedContainer
  if (process.env.PG_DUMP_DOCKER_CONTAINER) {
    const response = await exportRoute(new NextRequest('http://localhost/api/vendor/export', {
      headers: { cookie: `${VENDOR_COOKIE_NAME}=${cookie}` },
    }))
    const bytes = Buffer.from(await response.arrayBuffer())
    const recorded = (await one(q`SELECT count(*)::int AS n FROM vendor_access_events WHERE tenant_id = ${tenantId} AND kind = 'export'`)).n
    check('a live export: 200, a .dump attachment, a real pg_dump file, recorded',
      response.status === 200 && /attachment; filename="carpe-diem_\d{4}-\d{2}-\d{2}_\d{4}\.dump"/.test(response.headers.get('content-disposition') ?? '') &&
        bytes.subarray(0, 5).toString() === 'PGDMP' && bytes.length > 10_000 && recorded === before + 1,
      `${response.status} ${bytes.length} bytes, ${bytes.subarray(0, 5).toString()}`)
  } else {
    console.log('SKIP a live export (no pg_dump here; set PG_DUMP_DOCKER_CONTAINER to run it)')
  }
  if (savedPath === undefined) delete process.env.PG_DUMP_PATH
  else process.env.PG_DUMP_PATH = savedPath

  await recordExport(tenantId)
  await startVendorSession(tenantId)
  const last = await lastVendorAccess(tenantId)
  check('a later sign-in does not hide the last export', last.export !== null && last.signIn !== null && last.signIn >= last.export)

  const expiredHtml = await exportWith(null, 'text/html')
  check('an expired session clicking Download goes back to /vendor', expiredHtml.status === 307 || expiredHtml.status === 302)

  delete process.env.VENDOR_SECRET
  const switchedOff = await exportWith(cookie)
  check('a live cookie cannot export once vendor access is switched off', switchedOff.status === 503 && switchedOff.body?.error?.code === 'VENDOR_DISABLED')
  process.env.VENDOR_SECRET = SECRET

  // ── The login route ────────────────────────────────────────────────────────
  const login = async (password: string) => {
    const response = await loginRoute(new Request('http://localhost/api/vendor/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }))
    return { status: response.status, cookie: response.headers.get('set-cookie') ?? '', body: await response.json() }
  }
  resetVendorLockoutForTests()
  const signIns = async () => (await one(q`SELECT count(*)::int AS n FROM vendor_access_events WHERE kind = 'sign_in'`)).n as number
  const beforeWrong = await signIns()
  const bad = await login('nope')
  check('login route: wrong password is a 401 and records nothing', bad.status === 401 && bad.body?.error?.code === 'INVALID_PASSWORD' && (await signIns()) === beforeWrong)
  const good = await login(SECRET)
  check('login route: right password is a 200, sets the httpOnly vendor cookie and records a sign-in',
    good.status === 200 && good.cookie.includes(`${VENDOR_COOKIE_NAME}=`) && /HttpOnly/i.test(good.cookie) && /SameSite=strict/i.test(good.cookie) &&
      (await signIns()) === beforeWrong + 1)
  for (let i = 0; i < 5; i += 1) await login('nope')
  const lockedRoute = await login(SECRET)
  check('login route: locked out is a 429', lockedRoute.status === 429 && lockedRoute.body?.error?.code === 'LOCKED')
  resetVendorLockoutForTests()
  delete process.env.VENDOR_SECRET
  const disabled = await login(SECRET)
  check('login route: not configured is a 503', disabled.status === 503 && disabled.body?.error?.code === 'VENDOR_DISABLED')
  process.env.VENDOR_SECRET = SECRET

  check('the file is named for the restaurant clock',
    dumpFilename(new Date('2026-11-14T16:00:00Z'), 'Asia/Colombo') === 'carpe-diem_2026-11-14_2130.dump',
    dumpFilename(new Date('2026-11-14T16:00:00Z'), 'Asia/Colombo'))

  if (saved === undefined) delete process.env.VENDOR_SECRET
  else process.env.VENDOR_SECRET = saved
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = (await rows(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Vendor %'`)).map((r) => r.id as string)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  try {
    await db.execute(q.raw('ALTER TABLE vendor_access_events DISABLE TRIGGER immutable_vendor_access_events'))
    await db.execute(q`DELETE FROM vendor_access_events WHERE tenant_id = any(${all}::uuid[])`)
    // The login route signs in to the installation's tenant: remove what this run wrote there.
    await db.execute(q`DELETE FROM vendor_access_events WHERE created_at >= ${startedAt}::timestamptz`)
  } finally {
    await db.execute(q.raw('ALTER TABLE vendor_access_events ENABLE TRIGGER immutable_vendor_access_events')).catch((error) =>
      console.error('!! COULD NOT RE-ENABLE immutable_vendor_access_events !!', error),
    )
  }
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
