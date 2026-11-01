import 'server-only'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/server/db'
import { modifierGroups, modifierOptions } from '@/server/db/schema'
import type { ModifierGroupRow } from '@/types/orders'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The priced options of a set of menu items, as `itemId → groups` (Story 4.8).
 *
 * ONE loader for the menu the tablet prices from (`GET /api/menu`) and the
 * check the server prices by (`submitRound`), so the two read the same rows
 * the same way: active groups only, options available or not (an unavailable
 * one is shown disabled and refused), both in display order.
 *
 * `lock: true` reads the rows `FOR SHARE`, inside the send's transaction, so an
 * owner re-pricing or retiring an option cannot commit between the price check
 * and the insert — the same reason the menu items themselves are locked.
 */
export async function loadModifierGroups(
  executor: Tx | typeof db,
  { itemIds, tenantId, lock = false }: { itemIds?: string[]; tenantId?: string; lock?: boolean },
): Promise<Map<string, ModifierGroupRow[]>> {
  const byItem = new Map<string, ModifierGroupRow[]>()
  if (itemIds && itemIds.length === 0) return byItem

  const groupFilter = and(
    eq(modifierGroups.isActive, true),
    itemIds ? inArray(modifierGroups.menuItemId, itemIds) : undefined,
    tenantId ? eq(modifierGroups.tenantId, tenantId) : undefined,
  )

  const groupQuery = executor
    .select({
      id: modifierGroups.id,
      menuItemId: modifierGroups.menuItemId,
      name: modifierGroups.name,
      selection: modifierGroups.selection,
      required: modifierGroups.isRequired,
    })
    .from(modifierGroups)
    .where(groupFilter)
    .orderBy(asc(modifierGroups.displayOrder), asc(modifierGroups.name))
  const groups = lock ? await groupQuery.for('share') : await groupQuery
  if (groups.length === 0) return byItem

  const optionQuery = executor
    .select({
      id: modifierOptions.id,
      groupId: modifierOptions.groupId,
      name: modifierOptions.name,
      priceDeltaPaisa: modifierOptions.priceDeltaPaisa,
      isDefault: modifierOptions.isDefault,
      maxCount: modifierOptions.maxCount,
      excludesGroupId: modifierOptions.excludesGroupId,
      available: modifierOptions.isAvailable,
    })
    .from(modifierOptions)
    .where(inArray(modifierOptions.groupId, groups.map((group) => group.id)))
    .orderBy(asc(modifierOptions.displayOrder), asc(modifierOptions.name))
  const options = lock ? await optionQuery.for('share') : await optionQuery

  const optionsByGroup = new Map<string, ModifierGroupRow['options']>()
  for (const option of options) {
    const list = optionsByGroup.get(option.groupId) ?? []
    list.push({
      id: option.id,
      name: option.name,
      priceDeltaPaisa: option.priceDeltaPaisa,
      isDefault: option.isDefault,
      maxCount: option.maxCount,
      excludesGroupId: option.excludesGroupId,
      available: option.available,
    })
    optionsByGroup.set(option.groupId, list)
  }

  for (const group of groups) {
    const list = byItem.get(group.menuItemId) ?? []
    list.push({
      id: group.id,
      name: group.name,
      selection: group.selection,
      required: group.required,
      options: optionsByGroup.get(group.id) ?? [],
    })
    byItem.set(group.menuItemId, list)
  }
  return byItem
}
