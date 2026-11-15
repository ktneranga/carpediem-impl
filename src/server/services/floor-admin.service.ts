import 'server-only'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { orderSessionTables, tables, zones } from '@/server/db/schema'
import { recordConfigChange } from '@/server/services/config-change.service'
import { MenuNotFoundError, MenuRuleError, StaleVersionError } from '@/server/services/menu-admin.service'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The floor — zones and their tables — from the Manage area (Story 10.3 lite).
 *
 * Built like menu-admin.service.ts: every write names the version the editor
 * loaded (`StaleVersionError` on a second tablet's stale save), bumps
 * `version`, sets `updated_at` and appends the row to `config_changes` in the
 * same transaction (FR71). It reuses that service's error classes so the shared
 * route helper maps them the same way.
 *
 * ── Nothing is deleted ───────────────────────────────────────────────────────
 * Remove sets `is_active = false`. Sessions, bills and receipts point at tables
 * and keep naming them.
 *
 * ── Service is never disturbed ───────────────────────────────────────────────
 * A table in use (an open `order_session_tables` row — which also covers every
 * table of a merged group — or `status = 'occupied'`) cannot be removed. It can
 * be renamed or moved to another zone: its order stays on it. Nothing here ever
 * writes `status` or `unavailable_reason` (Story 3.7 owns those).
 */

export type FloorKind = 'zone' | 'table'

export class ZoneNotEmptyError extends Error {}
/** A table switched on while its zone is off: it would show nowhere. */
export class ZoneOffError extends Error {}
export class TableInUseError extends Error {
  constructor(readonly label: string) {
    super(`Close or move the order on ${label} first`)
  }
}
export class LabelTakenError extends Error {
  constructor(readonly label: string) {
    super(`There is already a table called ${label}`)
  }
}

/** The partial unique index on active labels — the backstop behind the check. */
export const TABLE_LABEL_INDEX = 'idx_tables_tenant_label_active'

const TABLES = {
  zone: { table: zones, name: 'zones' },
  table: { table: tables, name: 'tables' },
} as const

type Row = { id: string; version: number } & Record<string, unknown>

// ── Rules ────────────────────────────────────────────────────────────────────

function clean(text: string, max: number, what: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 1 || trimmed.length > max) throw new MenuRuleError(`${what} is 1 to ${max} characters`)
  return trimmed
}

export const cleanZoneName = (name: string) => clean(name, 40, 'A zone name')
export const cleanLabel = (label: string) => clean(label, 20, 'A table label')

function checkCapacity(capacity: number | null): number | null {
  if (capacity === null) return null
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30) throw new MenuRuleError('Seats are 1 to 30')
  return capacity
}

/** No other ACTIVE table of the tenant has this label, ignoring case. */
async function checkLabelFree(tx: Tx, tenantId: string, label: string, exceptId: string | null) {
  const [taken] = await tx
    .select({ id: tables.id })
    .from(tables)
    .where(
      and(
        eq(tables.tenantId, tenantId),
        eq(tables.isActive, true),
        sql`lower(${tables.label}) = lower(${label})`,
        exceptId ? ne(tables.id, exceptId) : undefined,
      ),
    )
    .limit(1)
  if (taken) throw new LabelTakenError(label)
}

async function activeZone(tx: Tx, id: string, tenantId: string) {
  const [zone] = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.id, id), eq(zones.tenantId, tenantId), eq(zones.isActive, true)))
    .limit(1)
    .for('update')
  if (!zone) throw new MenuRuleError('Choose a zone on the floor')
}

/** Switching a table on needs its zone on: a table in an off zone shows nowhere. */
async function zoneIsOn(tx: Tx, id: string, tenantId: string) {
  const [zone] = await tx
    .select({ id: zones.id })
    .from(zones)
    .where(and(eq(zones.id, id), eq(zones.tenantId, tenantId), eq(zones.isActive, true)))
    .limit(1)
    .for('update')
  if (!zone) throw new ZoneOffError('Turn its zone on first')
}

// ── The versioned write ──────────────────────────────────────────────────────

async function log(tx: Tx, kind: FloorKind, row: Row, tenantId: string, staffId: string) {
  await recordConfigChange(tx, { tenantId, tableName: TABLES[kind].name, rowId: row.id, version: row.version, payload: row, staffId })
}

async function versionedUpdate(
  tx: Tx,
  kind: FloorKind,
  { id, tenantId, staffId, expectedVersion, set }: {
    id: string
    tenantId: string
    staffId: string
    expectedVersion: number
    set: Record<string, unknown>
  },
): Promise<Row> {
  const table = TABLES[kind].table as typeof tables
  const [row] = (await tx
    .update(table)
    .set({ ...set, version: sql`${table.version} + 1`, updatedAt: sql`now()` } as never)
    .where(and(eq(table.id, id), eq(table.tenantId, tenantId), eq(table.version, expectedVersion)))
    .returning()) as unknown as Row[]
  if (!row) {
    const [exists] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.tenantId, tenantId)))
      .limit(1)
    throw exists ? new StaleVersionError() : new MenuNotFoundError()
  }
  await log(tx, kind, row, tenantId, staffId)
  return row
}

async function insertRow(tx: Tx, kind: FloorKind, values: Record<string, unknown>, tenantId: string, staffId: string) {
  const table = TABLES[kind].table as typeof tables
  const [row] = (await tx.insert(table).values(values as never).returning()) as unknown as Row[]
  await log(tx, kind, row!, tenantId, staffId)
  return row!
}

async function readTable(tx: Tx, id: string, tenantId: string) {
  const [row] = await tx
    .select()
    .from(tables)
    .where(and(eq(tables.id, id), eq(tables.tenantId, tenantId)))
    .limit(1)
  if (!row) throw new MenuNotFoundError()
  return row
}

/** The next display order after the last sibling, so a new row goes to the end. */
async function nextOrder(tx: Tx, kind: FloorKind, zoneId: string | null, tenantId: string) {
  const table = TABLES[kind].table as typeof tables
  const [{ max }] = await tx
    .select({ max: sql<number>`coalesce(max(${table.displayOrder}), 0)::int` })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), zoneId ? eq(tables.zoneId, zoneId) : undefined))
  return max + 10
}

// ── Zones ────────────────────────────────────────────────────────────────────

export async function createZone(tx: Tx, a: { tenantId: string; staffId: string; name: string }) {
  return insertRow(tx, 'zone', {
    tenantId: a.tenantId,
    name: cleanZoneName(a.name),
    displayOrder: await nextOrder(tx, 'zone', null, a.tenantId),
  }, a.tenantId, a.staffId)
}

export async function updateZone(tx: Tx, a: { tenantId: string; staffId: string; id: string; version: number; name: string }) {
  return versionedUpdate(tx, 'zone', { ...a, expectedVersion: a.version, set: { name: cleanZoneName(a.name) } })
}

/** Refused while the zone still has active tables. */
export async function removeZone(tx: Tx, a: { tenantId: string; staffId: string; id: string; version: number }) {
  // Locked first, for the reason `removeCategory` gives: a table switched on
  // in this zone at the same moment is counted below or refused.
  await tx.select({ id: zones.id }).from(zones).where(eq(zones.id, a.id)).for('update')
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tables)
    .where(and(eq(tables.zoneId, a.id), eq(tables.tenantId, a.tenantId), eq(tables.isActive, true)))
  if (count > 0) throw new ZoneNotEmptyError()
  return versionedUpdate(tx, 'zone', { ...a, expectedVersion: a.version, set: { isActive: false } })
}

/**
 * Switch a zone off (the same rule as `removeZone`: its tables go off first) or
 * back on (Teran, 2026-11-15), at the end of the floor.
 */
export async function setZoneActive(
  tx: Tx,
  a: { tenantId: string; staffId: string; id: string; version: number; active: boolean },
) {
  if (!a.active) return removeZone(tx, a)
  return versionedUpdate(tx, 'zone', {
    ...a,
    expectedVersion: a.version,
    set: { isActive: true, displayOrder: await nextOrder(tx, 'zone', null, a.tenantId) },
  })
}

// ── Tables ───────────────────────────────────────────────────────────────────

export async function createTable(
  tx: Tx,
  a: { tenantId: string; staffId: string; zoneId: string; label: string; capacity: number | null },
) {
  await activeZone(tx, a.zoneId, a.tenantId)
  const label = cleanLabel(a.label)
  await checkLabelFree(tx, a.tenantId, label, null)
  return insertRow(tx, 'table', {
    tenantId: a.tenantId,
    zoneId: a.zoneId,
    label,
    capacity: checkCapacity(a.capacity),
    displayOrder: await nextOrder(tx, 'table', a.zoneId, a.tenantId),
  }, a.tenantId, a.staffId)
}

/** Label, seats and zone. Allowed while occupied: the order stays on the table. */
export async function updateTable(
  tx: Tx,
  a: {
    tenantId: string
    staffId: string
    id: string
    version: number
    label?: string
    capacity?: number | null
    zoneId?: string
  },
) {
  const set: Record<string, unknown> = {}
  if (a.label !== undefined) {
    set.label = cleanLabel(a.label)
    await checkLabelFree(tx, a.tenantId, set.label as string, a.id)
  }
  if (a.capacity !== undefined) set.capacity = checkCapacity(a.capacity)
  if (a.zoneId !== undefined) {
    const current = await readTable(tx, a.id, a.tenantId)
    if (current.zoneId !== a.zoneId) {
      await activeZone(tx, a.zoneId, a.tenantId)
      set.zoneId = a.zoneId
      // To the end of its new zone, not into the middle of it.
      set.displayOrder = await nextOrder(tx, 'table', a.zoneId, a.tenantId)
    }
  }
  return versionedUpdate(tx, 'table', { ...a, expectedVersion: a.version, set })
}

/**
 * Remove (`active: false`) or restore a table.
 *
 * Remove: the UPDATE runs FIRST, so this transaction holds the row lock before
 * the in-use check reads. A seating in flight then blocks on that lock in its
 * own `occupyTables` UPDATE (which requires `is_active`) and fails once this
 * commits; a seating that committed first is seen by the check, and this rolls
 * back. Either way no open order is ever left on a removed table.
 *
 * Restore: the label must still be free, and the table needs an active zone —
 * its own, or `zoneId` when its zone has been removed since.
 */
export async function setTableActive(
  tx: Tx,
  a: { tenantId: string; staffId: string; id: string; version: number; active: boolean; zoneId?: string },
) {
  if (!a.active) {
    const removed = await versionedUpdate(tx, 'table', { ...a, expectedVersion: a.version, set: { isActive: false } })
    const [open] = await tx
      .select({ tableId: orderSessionTables.tableId })
      .from(orderSessionTables)
      .where(and(eq(orderSessionTables.tableId, a.id), isNull(orderSessionTables.releasedAt)))
      .limit(1)
    if (open || removed.status === 'occupied') throw new TableInUseError(removed.label as string)
    return removed
  }

  const table = await readTable(tx, a.id, a.tenantId)
  await checkLabelFree(tx, a.tenantId, table.label, a.id)
  const set: Record<string, unknown> = { isActive: true }
  const zoneId = a.zoneId ?? table.zoneId
  if (a.zoneId === undefined) await zoneIsOn(tx, zoneId, a.tenantId)
  else await activeZone(tx, zoneId, a.tenantId)
  if (zoneId !== table.zoneId) set.zoneId = zoneId
  // Back at the end of its zone: its old place may have been reordered since.
  set.displayOrder = await nextOrder(tx, 'table', zoneId, a.tenantId)
  return versionedUpdate(tx, 'table', { ...a, expectedVersion: a.version, set })
}

// ── Drag and drop ────────────────────────────────────────────────────────────

/**
 * Sets the whole order of one list at once: the zones, or one zone's tables.
 * `ids` is every ACTIVE sibling in its new order; anything else (someone added
 * or removed one meanwhile) is refused as stale. Rows land at 10, 20, 30…;
 * only rows whose number changes are versioned and logged.
 */
export async function reorderRows(
  tx: Tx,
  kind: FloorKind,
  a: { tenantId: string; staffId: string; parentId: string | null; ids: string[] },
) {
  if (kind === 'table' && !a.parentId) throw new MenuRuleError('Which zone is this?')
  const table = TABLES[kind].table as typeof tables

  const siblings = (await tx
    .select({ id: table.id, version: table.version, displayOrder: table.displayOrder })
    .from(table)
    .where(
      and(
        eq(table.tenantId, a.tenantId),
        eq(table.isActive, true),
        kind === 'table' ? eq(tables.zoneId, a.parentId!) : undefined,
      ),
    )
    .for('update')) as { id: string; version: number; displayOrder: number }[]

  const current = new Set(siblings.map((row) => row.id))
  if (a.ids.length !== current.size || new Set(a.ids).size !== a.ids.length || !a.ids.every((id) => current.has(id))) {
    throw new StaleVersionError()
  }
  for (const [position, id] of a.ids.entries()) {
    const sibling = siblings.find((row) => row.id === id)!
    const wanted = (position + 1) * 10
    if (sibling.displayOrder === wanted) continue
    await versionedUpdate(tx, kind, {
      id,
      tenantId: a.tenantId,
      staffId: a.staffId,
      expectedVersion: sibling.version,
      set: { displayOrder: wanted },
    })
  }
  return { reordered: true }
}

// ── Reading for the editor ───────────────────────────────────────────────────

export type ManageTable = {
  id: string
  version: number
  zoneId: string
  label: string
  capacity: number | null
  status: 'open' | 'occupied' | 'unavailable'
  isActive: boolean
  /** An open order (or merged group) is on it right now. */
  inUse: boolean
}
export type ManageZone = { id: string; version: number; name: string; isActive: boolean; tables: ManageTable[] }
/** With `includeRemoved`, switched-off zones and tables are listed too, each table in its own zone. */
export type ManageFloor = { zones: ManageZone[] }

/** The floor as the editor needs it: zones in floor order, tables in order, versions. */
export async function loadFloorForManage(
  executor: Tx | typeof db,
  { tenantId, includeRemoved }: { tenantId: string; includeRemoved: boolean },
): Promise<ManageFloor> {
  const zoneRows = await executor
    .select({ id: zones.id, version: zones.version, name: zones.name, isActive: zones.isActive })
    .from(zones)
    .where(eq(zones.tenantId, tenantId))
    .orderBy(asc(zones.displayOrder), asc(zones.id))
  const tableRows = await executor
    .select({
      id: tables.id,
      version: tables.version,
      zoneId: tables.zoneId,
      label: tables.label,
      capacity: tables.capacity,
      status: tables.status,
      isActive: tables.isActive,
      inUse: sql<boolean>`exists (
        select 1 from ${orderSessionTables}
         where ${orderSessionTables.tableId} = ${tables.id} and ${orderSessionTables.releasedAt} is null)`,
    })
    .from(tables)
    .where(and(eq(tables.tenantId, tenantId), includeRemoved ? undefined : eq(tables.isActive, true)))
    // The same order as the floor grid (/api/tables).
    .orderBy(asc(tables.displayOrder), asc(tables.label))

  const byZone = new Map<string, ManageTable[]>()
  for (const table of tableRows) byZone.set(table.zoneId, [...(byZone.get(table.zoneId) ?? []), table])
  return {
    zones: zoneRows
      .filter((zone) => includeRemoved || zone.isActive)
      .map((zone) => ({ ...zone, tables: byZone.get(zone.id) ?? [] })),
  }
}
