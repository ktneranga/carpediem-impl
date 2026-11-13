import 'server-only'
import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/server/db'
import { staff } from '@/server/db/schema'
import { isUniqueViolation } from '@/server/db/errors'
import { emitFloorChanged, emitMenuChanged } from '@/server/socket/events'
import {
  LabelTakenError,
  TABLE_LABEL_INDEX,
  TableInUseError,
  ZoneNotEmptyError,
} from '@/server/services/floor-admin.service'
import {
  CategoryNotEmptyError,
  MenuNotFoundError,
  MenuRuleError,
  StaleVersionError,
} from '@/server/services/menu-admin.service'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Shared by every `/api/manage/menu` route (Story 10.4), every
 * `/api/manage/floor` route (Story 10.3) and the Sold out routes (Story 8.3) —
 * they differ only in what they broadcast.
 *
 * The proxy has already required an owner POS session AND a live Manage
 * session (Story 10.0) for `/api/manage`; for Sold out, an owner or waiter
 * POS session. Here: who is writing (for the change
 * log), which tenant (from the staff row, never from the request), one
 * transaction, one `menu:changed` broadcast after commit, and one mapping from
 * the service's errors to HTTP.
 */

export function menuFail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

export const idSchema = z.string().uuid()
export const versionSchema = z.number().int().positive()

export type Actor = { staffId: string; tenantId: string }

export async function actorOf(request: Request): Promise<Actor | null> {
  const staffId = request.headers.get('x-staff-id')
  if (!staffId) return null
  const [member] = await db.select({ tenantId: staff.tenantId }).from(staff).where(eq(staff.id, staffId)).limit(1)
  return member ? { staffId, tenantId: member.tenantId } : null
}

/** Reads a JSON body against `schema`; null on anything malformed. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  const parsed = schema.safeParse(body)
  return parsed.success ? parsed.data : null
}

type Write<T = unknown> = (tx: Tx, actor: Actor) => Promise<T>

/** Runs one menu write: actor, transaction, `menu:changed`, errors. */
export function menuWrite(request: Request, write: Write, status = 200): Promise<NextResponse> {
  return manageWrite(request, write, status, emitMenuChanged, 'menu')
}

/**
 * Runs one Sold out write (Story 8.3) — `/api/menu-items` and `/api/menu-options`,
 * owner AND waiters, no Manage session. `broadcast` gets the write's result, so
 * a dish toggle can send `menu:item_updated` from the row it returned.
 */
export function soldOutWrite<T>(request: Request, write: Write<T>, broadcast: (data: T) => void): Promise<NextResponse> {
  return manageWrite(request, write, 200, broadcast, 'sold-out')
}

/** Runs one floor write (zones, tables): actor, transaction, `floor:changed`, errors. */
export function floorWrite(request: Request, write: Write, status = 200): Promise<NextResponse> {
  return manageWrite(request, write, status, emitFloorChanged, 'floor')
}

async function manageWrite<T>(
  request: Request,
  write: Write<T>,
  status: number,
  broadcast: (data: T) => void,
  area: string,
): Promise<NextResponse> {
  try {
    const actor = await actorOf(request)
    if (!actor) return menuFail('UNAUTHENTICATED', 'Sign in required', 401)
    const data = await db.transaction((tx) => write(tx, actor))
    broadcast(data)
    return NextResponse.json({ success: true, data: data ?? null }, { status })
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return menuFail('STALE', 'Someone else changed this. It has been reloaded.', 409)
    }
    if (error instanceof CategoryNotEmptyError) {
      return menuFail('CATEGORY_NOT_EMPTY', 'Move or remove the dishes in this category first.', 409)
    }
    if (error instanceof ZoneNotEmptyError) {
      return menuFail('ZONE_NOT_EMPTY', 'Move or remove the tables in this zone first.', 409)
    }
    if (error instanceof TableInUseError) return menuFail('TABLE_IN_USE', error.message, 409)
    if (error instanceof LabelTakenError) return menuFail('LABEL_TAKEN', error.message, 409)
    // The partial unique index is the backstop behind the label check (a race).
    if (isUniqueViolation(error, TABLE_LABEL_INDEX)) {
      return menuFail('LABEL_TAKEN', 'There is already a table with that label', 409)
    }
    if (error instanceof MenuNotFoundError) return menuFail('NOT_FOUND', 'Not found', 404)
    if (error instanceof MenuRuleError) return menuFail('INVALID', error.message, 422)
    console.error(`[api/manage/${area}] Write failed:`, error)
    return menuFail('INTERNAL_ERROR', 'Could not save the change', 500)
  }
}

/** `?version=` on a DELETE, as a positive integer, or null. */
export function versionParam(request: Request): number | null {
  const parsed = versionSchema.safeParse(Number(new URL(request.url).searchParams.get('version')))
  return parsed.success ? parsed.data : null
}

/** Unwraps and checks a dynamic `[id]` segment (or another name, e.g. `[itemId]`). */
export async function idParam<K extends string = 'id'>(
  params: Promise<Record<K, string>>,
  name: K = 'id' as K,
): Promise<string | null> {
  const parsed = idSchema.safeParse((await params)[name])
  return parsed.success ? parsed.data : null
}

export const moveSchema = z.object({ direction: z.enum(['up', 'down']), version: versionSchema })
export const nameSchema = z.string().max(200)
/** Integer paisa; whole rupees are checked by the service. */
export const paisaSchema = z.number().int()
export const destinationSchema = z.enum(['kitchen', 'pizza_kitchen', 'bar'])
