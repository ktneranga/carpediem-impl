import 'server-only'
import bcrypt from 'bcryptjs'
import { sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { staff, tenantConfig, tenants } from '@/server/db/schema'
import { isValidManagePasswordLength } from '@/server/services/manage-password.service'
import { recordConfigChange } from '@/server/services/config-change.service'
import { MenuRuleError } from '@/server/services/menu-admin.service'
import { checkPin, cleanStaffName } from '@/server/services/staff-admin.service'

/**
 * First-run setup (spec-first-run-setup, Teran 2026-11-14): on an install with
 * no restaurant, create the restaurant, its config and the first owner — the
 * five things nobody can enter anywhere else, because nobody can sign in yet.
 * Menu, floor and staff are then entered in Manage.
 *
 * ── Only while there is no restaurant ────────────────────────────────────────
 * Checked INSIDE the transaction, under `LOCK TABLE tenants IN EXCLUSIVE MODE`,
 * so two simultaneous submits on an empty install create one restaurant; the
 * second waits, then sees it and is refused.
 */

type Executor = typeof db

const BCRYPT_COST = 10 // the Staff and Manage cost (architecture.md:205)

export class AlreadySetUpError extends Error {
  constructor() {
    super('This system is already set up. Sign in with your PIN.')
  }
}

/** A setup field that is wrong, named so the form can point at it. */
export class SetupFieldError extends MenuRuleError {
  constructor(readonly field: SetupField, message: string) {
    super(message)
  }
}

export type SetupField = 'restaurantName' | 'timeZone' | 'ownerName' | 'pin' | 'managePassword'

export type SetupInput = {
  restaurantName: string
  timeZone: string
  ownerName: string
  pin: string
  managePassword: string
}

/** The zone's standard IANA name (e.g. "asia/colombo" → "Asia/Colombo"), or null. */
function canonicalZone(zone: string): string | null {
  try {
    const name = new Intl.DateTimeFormat('en-GB', { timeZone: zone }).resolvedOptions().timeZone
    return name.includes('/') || name === 'UTC' ? name : null
  } catch {
    return null
  }
}

/** Cleans and checks every field; throws a `SetupFieldError` for the first wrong one. */
export function checkSetup(input: SetupInput): SetupInput {
  const restaurantName = input.restaurantName.trim().replace(/\s+/g, ' ')
  if (restaurantName.length < 1 || restaurantName.length > 60) {
    throw new SetupFieldError('restaurantName', 'The restaurant name is 1 to 60 characters')
  }
  const timeZone = canonicalZone(input.timeZone.trim())
  if (!timeZone) throw new SetupFieldError('timeZone', 'Choose a time zone from the list')
  let ownerName: string
  try {
    ownerName = cleanStaffName(input.ownerName)
  } catch (error) {
    throw new SetupFieldError('ownerName', error instanceof Error ? error.message : 'Check the name')
  }
  let pin: string
  try {
    pin = checkPin(input.pin)
  } catch (error) {
    throw new SetupFieldError('pin', error instanceof Error ? error.message : 'Check the PIN')
  }
  if (!isValidManagePasswordLength(input.managePassword)) {
    // bcrypt counts bytes: a letter outside English can take 2–3 of the 72.
    throw new SetupFieldError('managePassword', 'The Manage password is 8 to 72 characters (fewer with non-English letters)')
  }
  return { restaurantName, timeZone, ownerName, pin, managePassword: input.managePassword }
}

/**
 * Creates the restaurant. `executor` is the app's pool by default; the verify
 * script passes one for a throwaway database.
 */
export async function runSetup(raw: SetupInput, executor: Executor = db): Promise<{ tenantId: string; ownerId: string }> {
  const input = checkSetup(raw)
  // Hashed before the lock: two bcrypt rounds must not hold the table.
  const [pinHash, passwordHash] = await Promise.all([
    bcrypt.hash(input.pin, BCRYPT_COST),
    bcrypt.hash(input.managePassword, BCRYPT_COST),
  ])

  return executor.transaction(async (tx) => {
    await tx.execute(sql`lock table tenants in exclusive mode`)
    const existing = await tx.execute(sql`select 1 from tenants limit 1`)
    if (existing.rows.length > 0) throw new AlreadySetUpError()

    const [tenant] = await tx
      .insert(tenants)
      .values({ name: input.restaurantName, timezone: input.timeZone, managePasswordHash: passwordHash })
      .returning({ id: tenants.id })
    await tx.insert(tenantConfig).values({ tenantId: tenant!.id, restaurantName: input.restaurantName })
    const [owner] = await tx
      .insert(staff)
      .values({ tenantId: tenant!.id, name: input.ownerName, role: 'owner', jobTitle: 'owner', pinHash })
      .returning()
    // Same record a staff member added in Manage gets; never the PIN hash.
    await recordConfigChange(tx, {
      tenantId: tenant!.id,
      tableName: 'staff',
      rowId: owner!.id,
      version: owner!.version,
      payload: { id: owner!.id, name: owner!.name, role: owner!.role, jobTitle: owner!.jobTitle, isActive: owner!.isActive, pinChanged: true },
      staffId: owner!.id,
    })
    return { tenantId: tenant!.id, ownerId: owner!.id }
  })
}
