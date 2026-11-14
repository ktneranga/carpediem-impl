import 'server-only'
import { isPermission, PERMISSIONS, type Permission } from '@/server/auth/permissions'
import bcrypt from 'bcryptjs'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { manageSessions, staff, staffRoleEnum, staffSessions } from '@/server/db/schema'
import { accessOf, isStaffJob, type StaffJob } from '@/lib/staff-jobs'
import { isForeignKeyViolation } from '@/server/db/errors'
import { recordConfigChange } from '@/server/services/config-change.service'
import { MenuNotFoundError, MenuRuleError, StaleVersionError } from '@/server/services/menu-admin.service'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Staff accounts from Manage → Staff (Story 10.2).
 *
 * Built like floor-admin.service.ts: every write names the version the editor
 * loaded, bumps `version`, sets `updated_at` and appends the row to
 * `config_changes` in the same transaction — but never the PIN hash.
 *
 * ── PINs are unique among ACTIVE staff ───────────────────────────────────────
 * Login takes the first bcrypt match, so a shared PIN would silently sign one
 * person in as the other. Salted hashes can't be compared with each other, so
 * the check bcrypt-compares the candidate PIN against every other active row,
 * under a per-tenant advisory lock so two saves can't both pass. That is also
 * why Reactivate takes a PIN: the stored hash alone can't be checked.
 *
 * ── The job decides the access ───────────────────────────────────────────────
 * Nobody picks a role: `role` (owner / waiter / kitchen) follows the job
 * (`accessOf`, src/lib/staff-jobs.ts). Extra rights for one person are
 * per-person permissions (Story 10.6), not a role.
 *
 * ── Sessions follow at once ──────────────────────────────────────────────────
 * `staff_sessions.role` is a denormalised copy the proxy reads on every
 * request. A role change rewrites it (and a demoted owner loses Manage);
 * deactivating deletes the person's sessions (Manage cascades).
 *
 * ── Delete only without history ──────────────────────────────────────────────
 * Orders, bills, payments and the change log point at staff rows (no cascade).
 * Delete is for someone added by mistake: any reference refuses it
 * (`HasHistoryError`) and the owner deactivates instead.
 */

export type StaffRole = (typeof staffRoleEnum.enumValues)[number]

export class PinTakenError extends Error {
  constructor() {
    super('That PIN is already in use. Choose another.')
  }
}
export class NameTakenError extends Error {
  constructor(readonly name: string) {
    super(`There is already someone called ${name}`)
  }
}
export class LastOwnerError extends Error {
  constructor() {
    super('There must always be at least one active owner.')
  }
}
export class OwnAccountError extends Error {
  constructor() {
    super('You can’t change your own job, deactivate or delete yourself. Another owner can.')
  }
}
export class HasHistoryError extends Error {
  constructor(readonly name: string) {
    super(`${name} has orders, bills or changes on record, so they can’t be deleted. Deactivate them instead.`)
  }
}

const PIN_COST = 10

/** What the editor and the change log see: never `pinHash`. */
export type ManageStaff = {
  id: string
  version: number
  name: string
  role: StaffRole
  jobTitle: string
  isActive: boolean
  /** Granted beyond the role (Story 10.6); always empty for owners and kitchen. */
  permissions: Permission[]
}

type StaffRow = typeof staff.$inferSelect

function publicRow(row: StaffRow): Omit<StaffRow, 'pinHash'> {
  const rest: Partial<StaffRow> = { ...row }
  delete rest.pinHash
  return rest as Omit<StaffRow, 'pinHash'>
}

function toManage(row: StaffRow): ManageStaff {
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    role: row.role,
    jobTitle: row.jobTitle,
    isActive: row.isActive,
    permissions: (row.permissions ?? []).filter(isPermission),
  }
}

// ── Rules ────────────────────────────────────────────────────────────────────

export function cleanStaffName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 1 || trimmed.length > 40) throw new MenuRuleError('A name is 1 to 40 characters')
  return trimmed
}

/** A job from `STAFF_JOBS`. Its access becomes the person's role. */
export function checkJob(job: string): StaffJob {
  if (!isStaffJob(job)) throw new MenuRuleError('Choose a job from the list')
  return job
}

/**
 * The permissions someone may hold (Story 10.6): known names, no duplicates,
 * and only for a waiter-role person — owners hold everything already, kitchen
 * staff are display-only.
 */
export function checkPermissions(role: StaffRole, permissions: readonly string[]): Permission[] {
  const unknown = permissions.find((p) => !isPermission(p))
  if (unknown !== undefined) throw new MenuRuleError('Choose permissions from the list')
  const unique = [...new Set(permissions)] as Permission[]
  if (unique.length > 0 && role !== 'waiter') {
    throw new MenuRuleError(role === 'owner' ? 'Owners can already do everything' : 'Kitchen staff can’t hold permissions')
  }
  return PERMISSIONS.filter((p) => unique.includes(p))
}

export function checkPin(pin: string): string {
  if (!/^\d{4}$/.test(pin)) throw new MenuRuleError('A PIN is exactly 4 digits')
  return pin
}

/** Serialises every staff write of a tenant (AC 3): two saves can't both pass the PIN check. */
export async function lockStaff(tx: Tx, tenantId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('staff_pin:' || ${tenantId}::text))`)
}

/** No OTHER active staff member of the tenant signs in with this PIN. */
export async function checkPinFree(tx: Tx, tenantId: string, pin: string, exceptId: string | null) {
  const others = await tx
    .select({ pinHash: staff.pinHash })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId), eq(staff.isActive, true), exceptId ? ne(staff.id, exceptId) : undefined))
  let taken = false
  for (const other of others) {
    if (await bcrypt.compare(pin, other.pinHash)) taken = true
  }
  if (taken) throw new PinTakenError()
}

/** No OTHER active staff member of the tenant has this name, ignoring case. */
export async function checkNameFree(tx: Tx, tenantId: string, name: string, exceptId: string | null) {
  const [taken] = await tx
    .select({ id: staff.id })
    .from(staff)
    .where(
      and(
        eq(staff.tenantId, tenantId),
        eq(staff.isActive, true),
        sql`lower(${staff.name}) = lower(${name})`,
        exceptId ? ne(staff.id, exceptId) : undefined,
      ),
    )
    .limit(1)
  if (taken) throw new NameTakenError(name)
}

/** Refuses when `id` is the tenant's only active owner. */
async function checkNotLastOwner(tx: Tx, tenantId: string, id: string) {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId), eq(staff.isActive, true), eq(staff.role, 'owner'), ne(staff.id, id)))
  if (count === 0) throw new LastOwnerError()
}

async function readStaff(tx: Tx, id: string, tenantId: string): Promise<StaffRow> {
  const [row] = await tx
    .select()
    .from(staff)
    .where(and(eq(staff.id, id), eq(staff.tenantId, tenantId)))
    .limit(1)
  if (!row) throw new MenuNotFoundError()
  return row
}

// ── The versioned write ──────────────────────────────────────────────────────

async function log(tx: Tx, row: StaffRow, tenantId: string, staffId: string, pinChanged: boolean) {
  await recordConfigChange(tx, {
    tenantId,
    tableName: 'staff',
    rowId: row.id,
    version: row.version,
    payload: { ...publicRow(row), ...(pinChanged ? { pinChanged: true } : {}) },
    staffId,
  })
}

async function versionedUpdate(
  tx: Tx,
  { id, tenantId, staffId, expectedVersion, set, pinChanged }: {
    id: string
    tenantId: string
    staffId: string
    expectedVersion: number
    set: Partial<StaffRow>
    pinChanged: boolean
  },
): Promise<StaffRow> {
  const [row] = await tx
    .update(staff)
    .set({ ...set, version: sql`${staff.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(staff.id, id), eq(staff.tenantId, tenantId), eq(staff.version, expectedVersion)))
    .returning()
  if (!row) throw new StaleVersionError()
  await log(tx, row, tenantId, staffId, pinChanged)
  return row
}

/** The person's POS sessions, as a subquery (for their Manage sessions). */
const sessionsOf = (tx: Tx, id: string) => tx.select({ id: staffSessions.id }).from(staffSessions).where(eq(staffSessions.staffId, id))

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createStaff(
  tx: Tx,
  a: { tenantId: string; staffId: string; name: string; jobTitle: string; pin: string },
): Promise<ManageStaff> {
  await lockStaff(tx, a.tenantId)
  const name = cleanStaffName(a.name)
  const jobTitle = checkJob(a.jobTitle)
  const role = accessOf(jobTitle)
  const pin = checkPin(a.pin)
  await checkNameFree(tx, a.tenantId, name, null)
  await checkPinFree(tx, a.tenantId, pin, null)
  const [row] = await tx
    .insert(staff)
    .values({ tenantId: a.tenantId, name, role, jobTitle, pinHash: await bcrypt.hash(pin, PIN_COST) })
    .returning()
  await log(tx, row!, a.tenantId, a.staffId, true)
  return toManage(row!)
}

/**
 * Name, job and PIN — only what is given changes. A job with other access
 * changes the role; `staffId` (the actor) can't do that to themselves.
 */
export async function updateStaff(
  tx: Tx,
  a: {
    tenantId: string
    staffId: string
    id: string
    version: number
    name?: string
    jobTitle?: string
    pin?: string
    /** Story 10.6: the full set to hold (replaces what they had). */
    permissions?: string[]
  },
): Promise<ManageStaff> {
  await lockStaff(tx, a.tenantId)
  const current = await readStaff(tx, a.id, a.tenantId)
  const set: Partial<StaffRow> = {}

  if (a.name !== undefined) {
    const name = cleanStaffName(a.name)
    if (current.isActive) await checkNameFree(tx, a.tenantId, name, a.id)
    set.name = name
  }
  let roleChanged = false
  if (a.jobTitle !== undefined) {
    const job = checkJob(a.jobTitle)
    set.jobTitle = job
    const role = accessOf(job)
    if (role !== current.role) {
      if (a.id === a.staffId) throw new OwnAccountError()
      if (current.role === 'owner' && current.isActive) await checkNotLastOwner(tx, a.tenantId, a.id)
      set.role = role
      roleChanged = true
    }
  }
  if (a.pin !== undefined) {
    const pin = checkPin(a.pin)
    if (current.isActive) await checkPinFree(tx, a.tenantId, pin, a.id)
    set.pinHash = await bcrypt.hash(pin, PIN_COST)
  }
  // Story 10.6. Checked against the role they will have AFTER this change, and
  // cleared when the new job is an owner or kitchen one.
  const nextRole = set.role ?? current.role
  if (a.permissions !== undefined) {
    if (a.id === a.staffId && a.permissions.length > 0) throw new OwnAccountError()
    set.permissions = checkPermissions(nextRole, a.permissions)
  } else if (roleChanged && nextRole !== 'waiter' && (current.permissions ?? []).length > 0) {
    set.permissions = []
  }

  const row = await versionedUpdate(tx, {
    id: a.id,
    tenantId: a.tenantId,
    staffId: a.staffId,
    expectedVersion: a.version,
    set,
    pinChanged: a.pin !== undefined,
  })

  if (roleChanged) {
    // At once, on every tablet: the proxy reads the role from the session.
    await tx.update(staffSessions).set({ role: row.role }).where(eq(staffSessions.staffId, a.id))
    if (row.role !== 'owner') {
      await tx.delete(manageSessions).where(inArray(manageSessions.staffSessionId, sessionsOf(tx, a.id)))
    }
  }
  return toManage(row)
}

/**
 * Deactivate (`active: false`) or reactivate someone.
 *
 * Deactivate signs them out everywhere (their Manage goes with it). Reactivate
 * needs a PIN — it may be their old one — checked against every active PIN, and
 * their name must still be free.
 */
export async function setStaffActive(
  tx: Tx,
  a: { tenantId: string; staffId: string; id: string; version: number; active: boolean; pin?: string },
): Promise<ManageStaff> {
  await lockStaff(tx, a.tenantId)
  if (a.id === a.staffId) throw new OwnAccountError()
  const current = await readStaff(tx, a.id, a.tenantId)

  if (!a.active) {
    if (current.role === 'owner' && current.isActive) await checkNotLastOwner(tx, a.tenantId, a.id)
    const row = await versionedUpdate(tx, {
      id: a.id,
      tenantId: a.tenantId,
      staffId: a.staffId,
      expectedVersion: a.version,
      set: { isActive: false },
      pinChanged: false,
    })
    await tx.delete(staffSessions).where(eq(staffSessions.staffId, a.id))
    return toManage(row)
  }

  if (a.pin === undefined) throw new MenuRuleError('Enter a PIN for them')
  const pin = checkPin(a.pin)
  await checkNameFree(tx, a.tenantId, current.name, a.id)
  await checkPinFree(tx, a.tenantId, pin, a.id)
  const row = await versionedUpdate(tx, {
    id: a.id,
    tenantId: a.tenantId,
    staffId: a.staffId,
    expectedVersion: a.version,
    set: { isActive: true, pinHash: await bcrypt.hash(pin, PIN_COST) },
    pinChanged: true,
  })
  return toManage(row)
}

/**
 * Deletes someone with no history (added by mistake). Their sessions go first
 * (Manage cascades); any other reference refuses it. The change log keeps a
 * `deleted` row, as for every other staff change.
 */
export async function deleteStaff(
  tx: Tx,
  a: { tenantId: string; staffId: string; id: string; version: number },
): Promise<{ id: string; deleted: true }> {
  await lockStaff(tx, a.tenantId)
  if (a.id === a.staffId) throw new OwnAccountError()
  const current = await readStaff(tx, a.id, a.tenantId)
  if (current.version !== a.version) throw new StaleVersionError()
  if (current.role === 'owner' && current.isActive) await checkNotLastOwner(tx, a.tenantId, a.id)

  await tx.delete(staffSessions).where(eq(staffSessions.staffId, a.id))
  try {
    // In a savepoint, so the foreign-key error is caught cleanly and reported
    // as "has history"; the whole write still rolls back.
    await tx.transaction((inner) => inner.delete(staff).where(and(eq(staff.id, a.id), eq(staff.tenantId, a.tenantId))))
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new HasHistoryError(current.name)
    throw error
  }
  await recordConfigChange(tx, {
    tenantId: a.tenantId,
    tableName: 'staff',
    rowId: a.id,
    version: current.version + 1,
    payload: { id: a.id, name: current.name, deleted: true },
    staffId: a.staffId,
  })
  return { id: a.id, deleted: true }
}

// ── Reading for the editor ───────────────────────────────────────────────────

const ROLE_ORDER = sql`case ${staff.role} when 'owner' then 0 when 'waiter' then 1 else 2 end`

/** Everyone, active and not, by role (Owner, Waiter, Kitchen) then name. */
export async function loadStaffForManage(executor: Tx | typeof db, tenantId: string): Promise<ManageStaff[]> {
  const rows = await executor
    .select({
      id: staff.id,
      version: staff.version,
      name: staff.name,
      role: staff.role,
      jobTitle: staff.jobTitle,
      isActive: staff.isActive,
      permissions: staff.permissions,
    })
    .from(staff)
    .where(eq(staff.tenantId, tenantId))
    .orderBy(ROLE_ORDER, sql`lower(${staff.name})`, asc(staff.id))
  return rows.map((row) => ({ ...row, permissions: (row.permissions ?? []).filter(isPermission) }))
}
