import 'server-only'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { menuCategories, menuItems, modifierGroups, modifierOptions } from '@/server/db/schema'
import { recordConfigChange } from '@/server/services/config-change.service'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Menu management from the Manage area (Story 10.4).
 *
 * ── Every write is versioned and logged ──────────────────────────────────────
 * An update names the version the editor loaded; `WHERE version = $expected`
 * makes a second tablet's stale save fail (`StaleVersionError`) instead of
 * silently overwriting. Each successful write bumps `version`, sets
 * `updated_at`, and appends the new row to `config_changes` in the same
 * transaction (FR71 groundwork).
 *
 * ── Nothing is deleted ───────────────────────────────────────────────────────
 * Remove sets `is_active = false`. Order events, tickets and bills point at
 * these rows, and they carry their own frozen name and price, so removing or
 * re-pricing never rewrites history.
 *
 * ── Money ────────────────────────────────────────────────────────────────────
 * Integer paisa, WHOLE rupees only (Teran, 2026-11-13): every price is a
 * multiple of 100.
 */

export type MenuKind = 'category' | 'item' | 'group' | 'option'

export class MenuNotFoundError extends Error {}
export class StaleVersionError extends Error {}
export class CategoryNotEmptyError extends Error {}
/** A rule broken — the message is safe to show. */
export class MenuRuleError extends Error {}

const TABLES = {
  category: { table: menuCategories, name: 'menu_categories' },
  item: { table: menuItems, name: 'menu_items' },
  group: { table: modifierGroups, name: 'modifier_groups' },
  option: { table: modifierOptions, name: 'modifier_options' },
} as const

type Row = { id: string; version: number } & Record<string, unknown>

export const MAX_PRICE_PAISA = 10_000_000 * 100

// ── Rules ────────────────────────────────────────────────────────────────────

export function cleanName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  if (trimmed.length < 1 || trimmed.length > 60) throw new MenuRuleError('A name is 1 to 60 characters')
  return trimmed
}

function checkPrice(paisa: number, { allowNegative }: { allowNegative: boolean }): number {
  if (!Number.isInteger(paisa) || paisa % 100 !== 0) throw new MenuRuleError('Prices are whole rupees')
  if (Math.abs(paisa) > MAX_PRICE_PAISA || (!allowNegative && paisa < 0)) {
    throw new MenuRuleError('That price is out of range')
  }
  return paisa
}

function checkMaxCount(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new MenuRuleError('Max per dish is 1 to 10')
  return count
}

// ── The versioned write ──────────────────────────────────────────────────────

async function log(tx: Tx, kind: MenuKind, row: Row, tenantId: string, staffId: string) {
  await recordConfigChange(tx, { tenantId, tableName: TABLES[kind].name, rowId: row.id, version: row.version, payload: row, staffId })
}

async function versionedUpdate(
  tx: Tx,
  kind: MenuKind,
  { id, tenantId, staffId, expectedVersion, set }: {
    id: string
    tenantId: string
    staffId: string
    expectedVersion: number
    set: Record<string, unknown>
  },
): Promise<Row> {
  const table = TABLES[kind].table as typeof menuItems
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

async function insertRow(tx: Tx, kind: MenuKind, values: Record<string, unknown>, tenantId: string, staffId: string) {
  const table = TABLES[kind].table as typeof menuItems
  const [row] = (await tx.insert(table).values(values as never).returning()) as unknown as Row[]
  await log(tx, kind, row!, tenantId, staffId)
  return row!
}

async function readRow(tx: Tx, kind: MenuKind, id: string, tenantId: string): Promise<Row> {
  const table = TABLES[kind].table as typeof menuItems
  const [row] = (await tx
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.tenantId, tenantId)))
    .limit(1)) as unknown as Row[]
  if (!row) throw new MenuNotFoundError()
  return row
}

/** The next display order after the last sibling, so a new row goes to the end. */
async function nextOrder(tx: Tx, kind: MenuKind, parent: { column: unknown; id: string } | null, tenantId: string) {
  const table = TABLES[kind].table as typeof menuItems
  const [{ max }] = await tx
    .select({ max: sql<number>`coalesce(max(${table.displayOrder}), 0)::int` })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), parent ? eq(parent.column as typeof table.id, parent.id) : undefined))
  return max + 10
}

// ── Categories ───────────────────────────────────────────────────────────────

export async function createCategory(tx: Tx, a: { tenantId: string; staffId: string; name: string }) {
  return insertRow(tx, 'category', {
    tenantId: a.tenantId,
    name: cleanName(a.name),
    displayOrder: await nextOrder(tx, 'category', null, a.tenantId),
  }, a.tenantId, a.staffId)
}

export async function updateCategory(tx: Tx, a: { tenantId: string; staffId: string; id: string; version: number; name: string }) {
  return versionedUpdate(tx, 'category', { ...a, expectedVersion: a.version, set: { name: cleanName(a.name) } })
}

export async function removeCategory(tx: Tx, a: { tenantId: string; staffId: string; id: string; version: number }) {
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(menuItems)
    .where(and(eq(menuItems.categoryId, a.id), eq(menuItems.tenantId, a.tenantId), eq(menuItems.isActive, true)))
  if (count > 0) throw new CategoryNotEmptyError()
  return versionedUpdate(tx, 'category', { ...a, expectedVersion: a.version, set: { isActive: false } })
}

async function activeCategory(tx: Tx, id: string, tenantId: string) {
  const [category] = await tx
    .select({ id: menuCategories.id })
    .from(menuCategories)
    .where(and(eq(menuCategories.id, id), eq(menuCategories.tenantId, tenantId), eq(menuCategories.isActive, true)))
    .limit(1)
  if (!category) throw new MenuRuleError('Choose a category on the menu')
}

// ── Dishes ───────────────────────────────────────────────────────────────────

export type Destination = 'kitchen' | 'pizza_kitchen' | 'bar'

export async function createItem(
  tx: Tx,
  a: { tenantId: string; staffId: string; categoryId: string; name: string; pricePaisa: number; productionDestination: Destination },
) {
  await activeCategory(tx, a.categoryId, a.tenantId)
  return insertRow(tx, 'item', {
    tenantId: a.tenantId,
    categoryId: a.categoryId,
    name: cleanName(a.name),
    pricePaisa: checkPrice(a.pricePaisa, { allowNegative: false }),
    productionDestination: a.productionDestination,
    displayOrder: await nextOrder(tx, 'item', { column: menuItems.categoryId, id: a.categoryId }, a.tenantId),
  }, a.tenantId, a.staffId)
}

export async function updateItem(
  tx: Tx,
  a: {
    tenantId: string
    staffId: string
    id: string
    version: number
    name?: string
    categoryId?: string
    pricePaisa?: number
    productionDestination?: Destination
  },
) {
  const set: Record<string, unknown> = {}
  if (a.name !== undefined) set.name = cleanName(a.name)
  if (a.pricePaisa !== undefined) set.pricePaisa = checkPrice(a.pricePaisa, { allowNegative: false })
  if (a.productionDestination !== undefined) set.productionDestination = a.productionDestination
  if (a.categoryId !== undefined) {
    await activeCategory(tx, a.categoryId, a.tenantId)
    set.categoryId = a.categoryId
    // To the end of its new category, not into the middle of it.
    set.displayOrder = await nextOrder(tx, 'item', { column: menuItems.categoryId, id: a.categoryId }, a.tenantId)
  }
  return versionedUpdate(tx, 'item', { ...a, expectedVersion: a.version, set })
}

export async function setItemActive(tx: Tx, a: { tenantId: string; staffId: string; id: string; version: number; active: boolean }) {
  if (a.active) {
    // Restoring into a removed category would put it nowhere a waiter can see.
    const item = await readRow(tx, 'item', a.id, a.tenantId)
    await activeCategory(tx, item.categoryId as string, a.tenantId)
  }
  return versionedUpdate(tx, 'item', { ...a, expectedVersion: a.version, set: { isActive: a.active } })
}

// ── Option groups ────────────────────────────────────────────────────────────

export async function createGroup(
  tx: Tx,
  a: { tenantId: string; staffId: string; itemId: string; name: string; selection: 'single' | 'multi'; isRequired: boolean },
) {
  await readRow(tx, 'item', a.itemId, a.tenantId)
  return insertRow(tx, 'group', {
    tenantId: a.tenantId,
    menuItemId: a.itemId,
    name: cleanName(a.name),
    selection: a.selection,
    isRequired: a.isRequired,
    displayOrder: await nextOrder(tx, 'group', { column: modifierGroups.menuItemId, id: a.itemId }, a.tenantId),
  }, a.tenantId, a.staffId)
}

export async function updateGroup(
  tx: Tx,
  a: { tenantId: string; staffId: string; id: string; version: number; name?: string; selection?: 'single' | 'multi'; isRequired?: boolean },
) {
  const set: Record<string, unknown> = {}
  if (a.name !== undefined) set.name = cleanName(a.name)
  if (a.selection !== undefined) set.selection = a.selection
  if (a.isRequired !== undefined) set.isRequired = a.isRequired
  return versionedUpdate(tx, 'group', { ...a, expectedVersion: a.version, set })
}

/** Removes a group, and clears every option's "rules out" that pointed at it. */
export async function removeGroup(tx: Tx, a: { tenantId: string; staffId: string; id: string; version: number }) {
  const removed = await versionedUpdate(tx, 'group', { ...a, expectedVersion: a.version, set: { isActive: false } })
  const pointing = await tx
    .select({ id: modifierOptions.id, version: modifierOptions.version })
    .from(modifierOptions)
    .where(and(eq(modifierOptions.excludesGroupId, a.id), eq(modifierOptions.tenantId, a.tenantId)))
  for (const option of pointing) {
    await versionedUpdate(tx, 'option', {
      id: option.id,
      tenantId: a.tenantId,
      staffId: a.staffId,
      expectedVersion: option.version,
      set: { excludesGroupId: null },
    })
  }
  return removed
}

// ── Options ──────────────────────────────────────────────────────────────────

/** "Rules out" must be another ACTIVE group of the SAME dish, or none. */
async function checkExcludes(tx: Tx, tenantId: string, ownGroupId: string, excludesGroupId: string | null) {
  if (excludesGroupId === null) return null
  const own = await readRow(tx, 'group', ownGroupId, tenantId)
  const [target] = await tx
    .select({ id: modifierGroups.id })
    .from(modifierGroups)
    .where(
      and(
        eq(modifierGroups.id, excludesGroupId),
        eq(modifierGroups.tenantId, tenantId),
        eq(modifierGroups.menuItemId, own.menuItemId as string),
        eq(modifierGroups.isActive, true),
        ne(modifierGroups.id, ownGroupId),
      ),
    )
    .limit(1)
  if (!target) throw new MenuRuleError('An option can only rule out another group of the same dish')
  return excludesGroupId
}

export async function createOption(
  tx: Tx,
  a: {
    tenantId: string
    staffId: string
    groupId: string
    name: string
    priceDeltaPaisa: number
    isDefault: boolean
    maxCount: number
    excludesGroupId: string | null
  },
) {
  await readRow(tx, 'group', a.groupId, a.tenantId)
  return insertRow(tx, 'option', {
    tenantId: a.tenantId,
    groupId: a.groupId,
    name: cleanName(a.name),
    priceDeltaPaisa: checkPrice(a.priceDeltaPaisa, { allowNegative: true }),
    isDefault: a.isDefault,
    maxCount: checkMaxCount(a.maxCount),
    excludesGroupId: await checkExcludes(tx, a.tenantId, a.groupId, a.excludesGroupId),
    displayOrder: await nextOrder(tx, 'option', { column: modifierOptions.groupId, id: a.groupId }, a.tenantId),
  }, a.tenantId, a.staffId)
}

export async function updateOption(
  tx: Tx,
  a: {
    tenantId: string
    staffId: string
    id: string
    version: number
    name?: string
    priceDeltaPaisa?: number
    isDefault?: boolean
    maxCount?: number
    excludesGroupId?: string | null
  },
) {
  const set: Record<string, unknown> = {}
  if (a.name !== undefined) set.name = cleanName(a.name)
  if (a.priceDeltaPaisa !== undefined) set.priceDeltaPaisa = checkPrice(a.priceDeltaPaisa, { allowNegative: true })
  if (a.isDefault !== undefined) set.isDefault = a.isDefault
  if (a.maxCount !== undefined) set.maxCount = checkMaxCount(a.maxCount)
  if (a.excludesGroupId !== undefined) {
    const option = await readRow(tx, 'option', a.id, a.tenantId)
    set.excludesGroupId = await checkExcludes(tx, a.tenantId, option.groupId as string, a.excludesGroupId)
  }
  return versionedUpdate(tx, 'option', { ...a, expectedVersion: a.version, set })
}

export async function removeOption(tx: Tx, a: { tenantId: string; staffId: string; id: string; version: number }) {
  return versionedUpdate(tx, 'option', { ...a, expectedVersion: a.version, set: { isActive: false } })
}

// ── Moving ───────────────────────────────────────────────────────────────────

const PARENT: Record<MenuKind, string | null> = {
  category: null,
  item: 'categoryId',
  group: 'menuItemId',
  option: 'groupId',
}

/**
 * Moves a row one place up or down among its active siblings.
 *
 * Seeded siblings often share `display_order` 0 and sort by name, so a swap of
 * two equal numbers would do nothing. The siblings are first renumbered 10, 20,
 * 30… in the order the screen shows them (order, then name), then the two
 * neighbours swap. Every row whose number changes is versioned and logged.
 */
export async function moveRow(
  tx: Tx,
  kind: MenuKind,
  a: { tenantId: string; staffId: string; id: string; version: number; direction: 'up' | 'down' },
) {
  const table = TABLES[kind].table as typeof menuItems
  const moving = await readRow(tx, kind, a.id, a.tenantId)
  if (moving.version !== a.version) throw new StaleVersionError()
  const parentKey = PARENT[kind]
  const parentColumn = parentKey ? (table as unknown as Record<string, typeof table.id>)[parentKey] : null

  const siblings = (await tx
    .select({ id: table.id, version: table.version, displayOrder: table.displayOrder })
    .from(table)
    .where(
      and(
        eq(table.tenantId, a.tenantId),
        eq(table.isActive, true),
        parentColumn ? eq(parentColumn, moving[parentKey!] as string) : undefined,
      ),
    )
    .orderBy(asc(table.displayOrder), asc(table.name))
    .for('update')) as { id: string; version: number; displayOrder: number }[]

  const index = siblings.findIndex((row) => row.id === a.id)
  const target = a.direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= siblings.length) return { moved: false }

  const order = siblings.map((row) => row.id)
  ;[order[index], order[target]] = [order[target]!, order[index]!]
  for (const [position, id] of order.entries()) {
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
  return { moved: true }
}

/**
 * Sets the whole order of one list at once — a drag and drop (Teran,
 * 2026-11-13). `ids` is every ACTIVE sibling in its new order: the categories,
 * one category's dishes, one dish's groups or one group's options. A list that
 * is not exactly the current set (someone added or removed one meanwhile) is
 * refused as stale, so a drop never silently drops a row. Rows land at 10, 20,
 * 30…; only rows whose number changes are versioned and logged.
 */
export async function reorderRows(
  tx: Tx,
  kind: MenuKind,
  a: { tenantId: string; staffId: string; parentId: string | null; ids: string[] },
) {
  const table = TABLES[kind].table as typeof menuItems
  const parentKey = PARENT[kind]
  const parentColumn = parentKey ? (table as unknown as Record<string, typeof table.id>)[parentKey] : null
  if (parentColumn && !a.parentId) throw new MenuRuleError('Which list is this?')

  const siblings = (await tx
    .select({ id: table.id, version: table.version, displayOrder: table.displayOrder })
    .from(table)
    .where(
      and(
        eq(table.tenantId, a.tenantId),
        eq(table.isActive, true),
        parentColumn ? eq(parentColumn, a.parentId!) : undefined,
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

export type ManageOption = {
  id: string
  version: number
  name: string
  priceDeltaPaisa: number
  isDefault: boolean
  maxCount: number
  excludesGroupId: string | null
  /** The sold-out switch (Story 8.3). */
  isAvailable: boolean
}
export type ManageGroup = {
  id: string
  version: number
  name: string
  selection: 'single' | 'multi'
  isRequired: boolean
  options: ManageOption[]
}
export type ManageItem = {
  id: string
  version: number
  categoryId: string
  name: string
  pricePaisa: number
  productionDestination: Destination
  isActive: boolean
  /** The sold-out switch (Story 8.3). Not `isActive`, which is removed. */
  isAvailable: boolean
  groups: ManageGroup[]
}
export type ManageCategory = { id: string; version: number; name: string; items: ManageItem[] }

/** The whole menu as the editor needs it: versions, removed dishes on request. */
export async function loadMenuForManage(
  executor: Tx | typeof db,
  { tenantId, includeRemoved }: { tenantId: string; includeRemoved: boolean },
): Promise<ManageCategory[]> {
  const categories = await executor
    .select({ id: menuCategories.id, version: menuCategories.version, name: menuCategories.name })
    .from(menuCategories)
    .where(and(eq(menuCategories.tenantId, tenantId), eq(menuCategories.isActive, true)))
    .orderBy(asc(menuCategories.displayOrder), asc(menuCategories.name))
  const items = await executor
    .select({
      id: menuItems.id,
      version: menuItems.version,
      categoryId: menuItems.categoryId,
      name: menuItems.name,
      pricePaisa: menuItems.pricePaisa,
      productionDestination: menuItems.productionDestination,
      isActive: menuItems.isActive,
      isAvailable: menuItems.isAvailable,
    })
    .from(menuItems)
    .where(and(eq(menuItems.tenantId, tenantId), includeRemoved ? undefined : eq(menuItems.isActive, true)))
    .orderBy(asc(menuItems.displayOrder), asc(menuItems.name))
  const groups = await executor
    .select({
      id: modifierGroups.id,
      version: modifierGroups.version,
      itemId: modifierGroups.menuItemId,
      name: modifierGroups.name,
      selection: modifierGroups.selection,
      isRequired: modifierGroups.isRequired,
    })
    .from(modifierGroups)
    .where(and(eq(modifierGroups.tenantId, tenantId), eq(modifierGroups.isActive, true)))
    .orderBy(asc(modifierGroups.displayOrder), asc(modifierGroups.name))
  const options = await executor
    .select({
      id: modifierOptions.id,
      version: modifierOptions.version,
      groupId: modifierOptions.groupId,
      name: modifierOptions.name,
      priceDeltaPaisa: modifierOptions.priceDeltaPaisa,
      isDefault: modifierOptions.isDefault,
      maxCount: modifierOptions.maxCount,
      excludesGroupId: modifierOptions.excludesGroupId,
      isAvailable: modifierOptions.isAvailable,
    })
    .from(modifierOptions)
    .where(and(eq(modifierOptions.tenantId, tenantId), eq(modifierOptions.isActive, true)))
    .orderBy(asc(modifierOptions.displayOrder), asc(modifierOptions.name))

  const optionsByGroup = new Map<string, ManageOption[]>()
  for (const { groupId, ...option } of options) {
    optionsByGroup.set(groupId, [...(optionsByGroup.get(groupId) ?? []), option])
  }
  const groupsByItem = new Map<string, ManageGroup[]>()
  for (const { itemId, ...group } of groups) {
    groupsByItem.set(itemId, [...(groupsByItem.get(itemId) ?? []), { ...group, options: optionsByGroup.get(group.id) ?? [] }])
  }
  const itemsByCategory = new Map<string, ManageItem[]>()
  for (const item of items) {
    itemsByCategory.set(item.categoryId, [
      ...(itemsByCategory.get(item.categoryId) ?? []),
      { ...item, groups: groupsByItem.get(item.id) ?? [] },
    ])
  }
  return categories.map((category) => ({ ...category, items: itemsByCategory.get(category.id) ?? [] }))
}

// ── Sold out (Story 8.3) ─────────────────────────────────────────────────────
//
// `is_available` is the sold-out switch; `is_active` (removed) is never touched
// here. LAST WRITE WINS — no expected version: a boolean set twice is the same
// result, and a STALE refusal mid-service would only slow a waiter down. A
// change still bumps `version` (so an open Manage → Menu editor reloads before
// its next save) and is logged in `config_changes` like every other write
// (FR71). Setting the value it already has writes nothing and logs nothing.

/** Active categories of this tenant — a dish in a removed one is off the menu. */
const activeCategoryIds = (executor: Tx | typeof db, tenantId: string) =>
  executor
    .select({ id: menuCategories.id })
    .from(menuCategories)
    .where(and(eq(menuCategories.tenantId, tenantId), eq(menuCategories.isActive, true)))

/** Active dishes in active categories of this tenant. */
const activeItemIds = (executor: Tx | typeof db, tenantId: string) =>
  executor
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        eq(menuItems.tenantId, tenantId),
        eq(menuItems.isActive, true),
        inArray(menuItems.categoryId, activeCategoryIds(executor, tenantId)),
      ),
    )

/** Active groups of active dishes of this tenant. */
const activeGroupIds = (executor: Tx | typeof db, tenantId: string) =>
  executor
    .select({ id: modifierGroups.id })
    .from(modifierGroups)
    .where(
      and(
        eq(modifierGroups.tenantId, tenantId),
        eq(modifierGroups.isActive, true),
        inArray(modifierGroups.menuItemId, activeItemIds(executor, tenantId)),
      ),
    )

const bump = { version: sql`version + 1`, updatedAt: sql`now()` }

/** A dish sold out (`available: false`) or back on. Returns the row as it now is. */
export async function setItemAvailable(
  tx: Tx,
  a: { tenantId: string; staffId: string; id: string; available: boolean },
) {
  const live = and(
    eq(menuItems.id, a.id),
    eq(menuItems.tenantId, a.tenantId),
    eq(menuItems.isActive, true),
    inArray(menuItems.categoryId, activeCategoryIds(tx, a.tenantId)),
  )
  const [changed] = await tx
    .update(menuItems)
    .set({ isAvailable: a.available, ...bump } as never)
    .where(and(live, ne(menuItems.isAvailable, a.available)))
    .returning()
  if (changed) {
    await log(tx, 'item', changed as unknown as Row, a.tenantId, a.staffId)
    return changed
  }
  const [current] = await tx.select().from(menuItems).where(live).limit(1)
  if (!current) throw new MenuNotFoundError()
  return current
}

/** An option sold out or back on. The option, its group and its dish must be active. */
export async function setOptionAvailable(
  tx: Tx,
  a: { tenantId: string; staffId: string; id: string; available: boolean },
) {
  const live = and(
    eq(modifierOptions.id, a.id),
    eq(modifierOptions.tenantId, a.tenantId),
    eq(modifierOptions.isActive, true),
    inArray(modifierOptions.groupId, activeGroupIds(tx, a.tenantId)),
  )
  const [changed] = await tx
    .update(modifierOptions)
    .set({ isAvailable: a.available, ...bump } as never)
    .where(and(live, ne(modifierOptions.isAvailable, a.available)))
    .returning()
  if (changed) {
    await log(tx, 'option', changed as unknown as Row, a.tenantId, a.staffId)
    return changed
  }
  const [current] = await tx.select().from(modifierOptions).where(live).limit(1)
  if (!current) throw new MenuNotFoundError()
  return current
}

/** Every active sold-out dish and option back on, in the caller's ONE transaction. Returns how many. */
export async function resetAvailability(tx: Tx, a: { tenantId: string; staffId: string }) {
  const items = await tx
    .update(menuItems)
    .set({ isAvailable: true, ...bump } as never)
    .where(
      and(
        eq(menuItems.tenantId, a.tenantId),
        eq(menuItems.isActive, true),
        eq(menuItems.isAvailable, false),
        inArray(menuItems.categoryId, activeCategoryIds(tx, a.tenantId)),
      ),
    )
    .returning()
  for (const row of items) await log(tx, 'item', row as unknown as Row, a.tenantId, a.staffId)
  const options = await tx
    .update(modifierOptions)
    .set({ isAvailable: true, ...bump } as never)
    .where(
      and(
        eq(modifierOptions.tenantId, a.tenantId),
        eq(modifierOptions.isActive, true),
        eq(modifierOptions.isAvailable, false),
        inArray(modifierOptions.groupId, activeGroupIds(tx, a.tenantId)),
      ),
    )
    .returning()
  for (const row of options) await log(tx, 'option', row as unknown as Row, a.tenantId, a.staffId)
  return { count: items.length + options.length }
}

/**
 * The Sold out board: every active dish in menu order, with its active groups
 * and options and each one's switch. The editor's own read — one menu query
 * for Manage, not a third.
 */
export function loadSoldOutBoard(executor: Tx | typeof db, tenantId: string) {
  return loadMenuForManage(executor, { tenantId, includeRemoved: false })
}
