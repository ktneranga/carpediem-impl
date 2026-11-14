/* eslint-disable @typescript-eslint/no-explicit-any -- reads raw rows; nothing here is imported by the app. */
/**
 * Story 10.6 — per-user permissions: the rules, the staff service, approval,
 * fresh session permissions, and the REAL proxy with real signed cookies, on a
 * throwaway tenant.
 *
 *   npx tsx --conditions=react-server --env-file=.env src/server/services/verify-permissions.ts
 *
 * Every `/api/manage/**` route file on disk is walked, so a new route can't be
 * added without this script saying which area (or owner-only) it belongs to.
 * Cleanup on a local database only.
 */
import bcrypt from 'bcryptjs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { sql as q } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { db } from '@/server/db'
import { proxy } from '@/proxy'
import {
  canAddCustomCharge,
  canApproveVoids,
  canOpenCashDrawer,
  canOpenManage,
  effectivePermissions,
  manageAreaOf,
  MANAGE_AREAS,
  parsePermissionsHeader,
  PERMISSIONS,
} from '@/server/auth/permissions'
import { createSession, SESSION_COOKIE_NAME, validateSession } from '@/server/services/session.service'
import { OwnAccountError, updateStaff } from '@/server/services/staff-admin.service'
import { findApprover, resetWrongPinsForTests, resolveApproval } from '@/server/services/void.service'
import { MenuRuleError } from '@/server/services/menu-admin.service'

const results: boolean[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`)
}
const one = async (text: ReturnType<typeof q>) => (await db.execute(text)).rows[0] as any
const tenantIds: string[] = []

/** `/api/manage/menu/items/[id]` style paths for every route file under src/app/api/manage. */
function manageApiPaths(): string[] {
  const root = join(process.cwd(), 'src', 'app', 'api', 'manage')
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry === 'route.ts') {
        const rel = relative(root, dir).split(sep).join('/')
        out.push(`/api/manage${rel ? `/${rel}` : ''}`.replace(/\[id\]/g, '00000000-0000-0000-0000-000000000000'))
      }
    }
  }
  walk(root)
  return out.sort()
}

/** What each route should map to: an area permission, or null (owner-only). */
function expectedArea(path: string): string | null {
  if (path.startsWith('/api/manage/dashboard')) return 'manage_dashboard'
  if (path.startsWith('/api/manage/menu')) return 'manage_menu'
  if (path.startsWith('/api/manage/floor')) return 'manage_floor'
  if (path.startsWith('/api/manage/settings')) return 'manage_settings'
  return null // staff, password, lock, unlock
}

async function run() {
  // ── The map ────────────────────────────────────────────────────────────────
  const paths = manageApiPaths()
  const wrong = paths.filter((path) => manageAreaOf(path) !== expectedArea(path))
  check(`every /api/manage route maps to its area or owner-only (${paths.length} routes)`, wrong.length === 0 && paths.length > 20, wrong.join(', '))
  check('Staff, password, lock and unlock are never an area',
    ['/api/manage/staff', '/api/manage/staff/x', '/api/manage/password', '/api/manage/lock', '/api/manage/unlock', '/manage/staff', '/manage/unlock'].every((p) => manageAreaOf(p) === null))
  check('pages map like their APIs; /manage itself is not an area',
    manageAreaOf('/manage/menu') === 'manage_menu' && manageAreaOf('/manage/end-of-day') === 'manage_dashboard' &&
      manageAreaOf('/manage') === null && manageAreaOf('/manage/sold-out') === null && manageAreaOf('/manage/menuX') === null)

  // ── The rules ──────────────────────────────────────────────────────────────
  check('owners hold every permission; kitchen none; waiters what is stored',
    effectivePermissions('owner', []).length === PERMISSIONS.length && effectivePermissions('kitchen', ['custom_charge']).length === 0 &&
      JSON.stringify(effectivePermissions('waiter', ['manage_menu', 'bogus'])) === '["manage_menu"]')
  check('custom charge / drawer / approve / manage: owner yes, plain waiter no, holder yes',
    canAddCustomCharge('owner') && !canAddCustomCharge('waiter', []) && canAddCustomCharge('waiter', ['custom_charge']) &&
      canOpenCashDrawer('owner') && !canOpenCashDrawer('waiter', []) && canOpenCashDrawer('waiter', ['open_cash_drawer']) &&
      canApproveVoids('owner', []) && !canApproveVoids('waiter', []) && canApproveVoids('waiter', ['approve_voids']) &&
      canOpenManage('owner', []) && !canOpenManage('waiter', ['custom_charge']) && canOpenManage('waiter', ['manage_floor']) &&
      !canAddCustomCharge('kitchen', ['custom_charge']))
  check('the header parser drops anything unknown', JSON.stringify(parsePermissionsHeader('manage_menu, manage_staff,,x')) === '["manage_menu"]')

  // ── Staff service ──────────────────────────────────────────────────────────
  const tenantId = (await one(q`INSERT INTO tenants (name) VALUES ('ZZ Perms verify') RETURNING id`)).id as string
  tenantIds.push(tenantId)
  await db.execute(q`INSERT INTO tenant_config (tenant_id, restaurant_name, session_timeout_minutes) VALUES (${tenantId}, 'ZZ Perms', 30)`)
  const hash = (pin: string) => bcrypt.hash(pin, 4)
  const owner = (await one(q`INSERT INTO staff (tenant_id, name, role, job_title, pin_hash) VALUES (${tenantId}, 'ZZ Olga', 'owner', 'owner', ${await hash('7101')}) RETURNING id, version`))
  const lead = (await one(q`INSERT INTO staff (tenant_id, name, role, job_title, pin_hash) VALUES (${tenantId}, 'ZZ Lena', 'waiter', 'cashier', ${await hash('7102')}) RETURNING id, version`))
  const plain = (await one(q`INSERT INTO staff (tenant_id, name, role, job_title, pin_hash) VALUES (${tenantId}, 'ZZ Will', 'waiter', 'waiter', ${await hash('7103')}) RETURNING id, version`))
  const chef = (await one(q`INSERT INTO staff (tenant_id, name, role, job_title, pin_hash) VALUES (${tenantId}, 'ZZ Kim', 'kitchen', 'chef', ${await hash('7104')}) RETURNING id, version`))
  const actor = { tenantId, staffId: owner.id as string }

  const granted = await db.transaction((tx) =>
    updateStaff(tx, { ...actor, id: lead.id, version: lead.version, permissions: ['manage_menu', 'approve_voids', 'manage_menu', 'custom_charge'] }))
  check('grant: stored in a fixed order, duplicates dropped', JSON.stringify(granted.permissions) === '["custom_charge","approve_voids","manage_menu"]', JSON.stringify(granted.permissions))
  const logged = await one(q`SELECT payload FROM config_changes WHERE row_id = ${lead.id} ORDER BY created_at DESC LIMIT 1`)
  check('the grant is audited (who, whom, what), never the PIN hash',
    JSON.stringify(logged?.payload?.permissions) === '["custom_charge","approve_voids","manage_menu"]' && !JSON.stringify(logged.payload).includes('$2'))

  const refuse = async (id: string, version: number, permissions: string[]) => {
    try {
      await db.transaction((tx) => updateStaff(tx, { ...actor, id, version, permissions }))
      return false
    } catch (error) {
      return error instanceof MenuRuleError || error instanceof OwnAccountError
    }
  }
  check('refused: an unknown permission, and anything for kitchen', (await refuse(plain.id, plain.version, ['manage_staff'])) && (await refuse(chef.id, chef.version, ['custom_charge'])))
  check('refused: permissions for an owner, or for yourself', await refuse(owner.id, owner.version, ['custom_charge']))

  const tmp = await db.transaction((tx) => updateStaff(tx, { ...actor, id: plain.id, version: plain.version, permissions: ['open_cash_drawer'] }))
  const toChef = await db.transaction((tx) => updateStaff(tx, { ...actor, id: plain.id, version: tmp.version, jobTitle: 'chef' }))
  check('a job change to kitchen clears what they held', toChef.role === 'kitchen' && toChef.permissions.length === 0)
  const backToWaiter = await db.transaction((tx) => updateStaff(tx, { ...actor, id: plain.id, version: toChef.version, jobTitle: 'waiter' }))
  plain.version = backToWaiter.version

  // ── Void approval ──────────────────────────────────────────────────────────
  resetWrongPinsForTests()
  check("a holder's PIN approves another waiter's void", (await findApprover(tenantId, '7102')) === lead.id)
  check("a plain waiter's PIN approves nothing", (await findApprover(tenantId, '7103')) === null)
  const self = await resolveApproval({ staffId: lead.id, role: 'waiter', permissions: ['approve_voids'], tenantId, approverPin: undefined })
  check('a holder voids without a PIN prompt (approves themselves)', self.ok && self.approverId === lead.id)
  const needs = await resolveApproval({ staffId: plain.id, role: 'waiter', permissions: [], tenantId, approverPin: undefined })
  check('a plain waiter still needs an approver', !needs.ok && needs.code === 'APPROVAL_REQUIRED')

  // ── Sessions: permissions read fresh ───────────────────────────────────────
  const leadSession = await createSession({ tenantId, staffId: lead.id, role: 'waiter' })
  const first = await validateSession(leadSession.cookieValue)
  check('the session carries the granted permissions', JSON.stringify(first?.permissions) === '["custom_charge","approve_voids","manage_menu"]')

  // ── The proxy ──────────────────────────────────────────────────────────────
  const visit = async (cookie: string, path: string, method = 'GET', extra: Record<string, string> = {}) => {
    const response = await proxy(new NextRequest(`http://localhost${path}`, {
      method,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}`, ...extra },
    }))
    return {
      status: response.status,
      through: response.headers.get('x-middleware-next') === '1',
      location: response.headers.get('location'),
      permissions: response.headers.get('x-middleware-request-x-staff-permissions'),
    }
  }
  const menuApi = await visit(leadSession.cookieValue, '/api/manage/menu')
  check('a Menu holder reaches /api/manage/menu with only their PIN', menuApi.through, JSON.stringify(menuApi))
  const menuPage = await visit(leadSession.cookieValue, '/manage/menu')
  check('… and the Menu page', menuPage.through, JSON.stringify(menuPage))
  const staffApi = await visit(leadSession.cookieValue, '/api/manage/staff')
  check('… but never Staff (403)', staffApi.status === 403, JSON.stringify(staffApi))
  const settingsApi = await visit(leadSession.cookieValue, '/api/manage/settings', 'PUT')
  check('… nor an area not granted (Settings: 403)', settingsApi.status === 403, JSON.stringify(settingsApi))
  const staffPage = await visit(leadSession.cookieValue, '/manage/staff')
  check('… the Staff page sends them away', !staffPage.through && staffPage.status >= 300 && staffPage.status < 400, JSON.stringify(staffPage))
  const home = await visit(leadSession.cookieValue, '/manage')
  check('/manage lets them in (its page sends them to Menu)', home.through, JSON.stringify(home))
  const forged = await visit(leadSession.cookieValue, '/api/manage/menu', 'GET', { 'x-staff-permissions': 'manage_settings,manage_staff' })
  check('a forged x-staff-permissions header is replaced by the database value',
    forged.permissions === 'custom_charge,approve_voids,manage_menu', String(forged.permissions))

  const plainSession = await createSession({ tenantId, staffId: plain.id, role: 'waiter' })
  const plainMenu = await visit(plainSession.cookieValue, '/api/manage/menu')
  check('a waiter with no areas: /api/manage/menu is 403', plainMenu.status === 403, JSON.stringify(plainMenu))
  const drawer = await visit(plainSession.cookieValue, '/api/cash-drawer/open', 'POST')
  check('/api/cash-drawer now admits waiters to the route (it checks the permission itself)', drawer.through, JSON.stringify(drawer))

  const ownerSession = await createSession({ tenantId, staffId: owner.id, role: 'owner' })
  const ownerMenu = await visit(ownerSession.cookieValue, '/api/manage/menu')
  check('the owner is unchanged: Manage still needs the password (401 MANAGE_LOCKED)', ownerMenu.status === 401, JSON.stringify(ownerMenu))

  // Revoke: the very next request is refused.
  const current = await one(q`SELECT version FROM staff WHERE id = ${lead.id}`)
  await db.transaction((tx) => updateStaff(tx, { ...actor, id: lead.id, version: current.version, permissions: [] }))
  const after = await visit(leadSession.cookieValue, '/api/manage/menu')
  check('a revoke bites on the next request (403)', after.status === 403, JSON.stringify(after))

  check('every area in the map has a page and an API', MANAGE_AREAS.every((area) => area.pages.length > 0 && area.apis.length > 0))
}

async function cleanup() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://x').hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) return
  const stray = ((await db.execute(q`SELECT id FROM tenants WHERE name LIKE 'ZZ Perms %'`)).rows as any[]).map((r) => r.id as string)
  const ids = [...new Set([...tenantIds, ...stray])]
  if (ids.length === 0) return
  const all = `{${ids.join(',')}}`
  try {
    await db.execute(q.raw('ALTER TABLE config_changes DISABLE TRIGGER immutable_config_changes'))
    await db.execute(q`DELETE FROM config_changes WHERE tenant_id = any(${all}::uuid[])`)
  } finally {
    await db.execute(q.raw('ALTER TABLE config_changes ENABLE TRIGGER immutable_config_changes')).catch((error) =>
      console.error('!! COULD NOT RE-ENABLE immutable_config_changes !!', error))
  }
  await db.execute(q`DELETE FROM staff_sessions WHERE tenant_id = any(${all}::uuid[])`)
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
