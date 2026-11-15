import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { menuCategories, menuItems, modifierGroups, modifierOptions } from '@/server/db/schema'
import * as menu from '@/server/services/menu-admin.service'
import { DISHES_SHEET, nameKey, OPTIONS_SHEET, type ParsedMenu, type SheetError } from '@/server/menu-import/workbook'

/**
 * Menu bulk upload (spec-menu-bulk-upload-excel): matches the rows of a filled
 * sheet against the menu and either PLANS (counts what would change, writes
 * nothing) or APPLIES them. Both run the same code, so the check the owner sees
 * is the import that follows.
 *
 * Matching is by name, ignoring case and extra spaces: category; dish within
 * its category; option group within its dish; option within its group. A
 * match is updated only where a value differs; anything not in the sheet is
 * left alone — nothing is ever deleted or switched off (Teran, 2026-11-15).
 * Every write goes through the menu-admin functions, so names, prices,
 * versions and `config_changes` follow the editor's rules.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

type Counts = { new: number; updated: number }
export type ImportSummary = {
  categories: Counts
  dishes: Counts
  groups: Counts
  options: Counts
  errors: SheetError[]
}

/** Thrown by an apply whose plan has errors (the menu changed since the check). */
export class ImportRejectedError extends Error {}

export async function importMenu(
  tx: Tx,
  a: { tenantId: string; staffId: string; parsed: ParsedMenu; apply: boolean },
): Promise<ImportSummary> {
  const { tenantId, staffId, parsed, apply } = a
  // One import at a time per restaurant: two at once (a retry after a timeout,
  // two tablets) would both create the same new categories and dishes.
  if (apply) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`menu-import:${tenantId}`}))`)
  const summary: ImportSummary = {
    categories: { new: 0, updated: 0 },
    dishes: { new: 0, updated: 0 },
    groups: { new: 0, updated: 0 },
    options: { new: 0, updated: 0 },
    errors: [...parsed.errors],
  }

  // ── What is on the menu now ──────────────────────────────────────────────
  const categoryRows = await tx
    .select({ id: menuCategories.id, name: menuCategories.name, isActive: menuCategories.isActive })
    .from(menuCategories)
    .where(eq(menuCategories.tenantId, tenantId))
    .orderBy(asc(menuCategories.displayOrder))
  const itemRows = await tx
    .select({
      id: menuItems.id,
      version: menuItems.version,
      categoryId: menuItems.categoryId,
      name: menuItems.name,
      pricePaisa: menuItems.pricePaisa,
      productionDestination: menuItems.productionDestination,
      isActive: menuItems.isActive,
    })
    .from(menuItems)
    .where(eq(menuItems.tenantId, tenantId))
  const groupRows = await tx
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
  const optionRows = await tx
    .select({
      id: modifierOptions.id,
      version: modifierOptions.version,
      groupId: modifierOptions.groupId,
      name: modifierOptions.name,
      priceDeltaPaisa: modifierOptions.priceDeltaPaisa,
      isDefault: modifierOptions.isDefault,
      maxCount: modifierOptions.maxCount,
    })
    .from(modifierOptions)
    .where(and(eq(modifierOptions.tenantId, tenantId), eq(modifierOptions.isActive, true)))

  // Several rows may share a name (e.g. a removed and a new one): the switched-on one wins.
  const pick = <T extends { isActive?: boolean }>(map: Map<string, T>, key: string, row: T) => {
    const held = map.get(key)
    if (!held || (!held.isActive && row.isActive)) map.set(key, row)
  }
  const categories = new Map<string, (typeof categoryRows)[number]>()
  for (const row of categoryRows) pick(categories, nameKey(row.name), row)
  const items = new Map<string, (typeof itemRows)[number]>()
  for (const row of itemRows) pick(items, `${row.categoryId}|${nameKey(row.name)}`, row)
  // A dish's name in any OTHER switched-on category: a row naming it under a
  // new category is a move, which the import does not do (it would leave the
  // old one on the POS and add a second).
  const activeCategoryName = new Map(categoryRows.filter((c) => c.isActive).map((c) => [c.id, c.name]))
  const dishHomes = new Map<string, string[]>()
  for (const row of itemRows) {
    const home = activeCategoryName.get(row.categoryId)
    if (row.isActive && home) dishHomes.set(nameKey(row.name), [...(dishHomes.get(nameKey(row.name)) ?? []), home])
  }
  const groups = new Map(groupRows.map((row) => [`${row.itemId}|${nameKey(row.name)}`, row]))
  const options = new Map(optionRows.map((row) => [`${row.groupId}|${nameKey(row.name)}`, row]))

  // ── Plan (and, when applying, write) ────────────────────────────────────
  // Ids of what this import creates, keyed like the maps above. In a plan
  // they are placeholders: nothing downstream reads a placeholder's row.
  const newId = (kind: string, key: string) => `new:${kind}:${key}`
  const categoryIds = new Map<string, string>()
  const dishIds = new Map<string, string>()

  for (const dish of parsed.dishes) {
    const fail = (message: string) => summary.errors.push({ sheet: DISHES_SHEET, row: dish.row, message })
    const catKey = nameKey(dish.category)
    let categoryId = categoryIds.get(catKey)
    if (!categoryId) {
      const existing = categories.get(catKey)
      if (existing && !existing.isActive) {
        fail(`Category "${existing.name}" is switched off in Manage: switch it on or use another name`)
        continue
      }
      if (existing) categoryId = existing.id
      else {
        summary.categories.new += 1
        categoryId = apply
          ? (await menu.createCategory(tx, { tenantId, staffId, name: dish.category })).id
          : newId('category', catKey)
      }
      categoryIds.set(catKey, categoryId)
    }

    const dishKey = `${catKey}|${nameKey(dish.name)}`
    const existing = items.get(`${categoryId}|${nameKey(dish.name)}`)
    if (existing && !existing.isActive) {
      fail(`"${existing.name}" is switched off in Manage: switch it on or use another name`)
      continue
    }
    if (existing) {
      dishIds.set(dishKey, existing.id)
      const set: { pricePaisa?: number; productionDestination?: menu.Destination } = {}
      if (existing.pricePaisa !== dish.pricePaisa) set.pricePaisa = dish.pricePaisa
      if (existing.productionDestination !== dish.destination) set.productionDestination = dish.destination
      if (Object.keys(set).length > 0) {
        summary.dishes.updated += 1
        if (apply) await menu.updateItem(tx, { tenantId, staffId, id: existing.id, version: existing.version, ...set })
      }
      continue
    }
    const elsewhere = dishHomes.get(nameKey(dish.name))?.find((home) => nameKey(home) !== catKey)
    if (elsewhere) {
      fail(`"${dish.name}" is already on the menu in ${elsewhere}: change its category in Manage, or use another name`)
      continue
    }
    summary.dishes.new += 1
    dishIds.set(
      dishKey,
      apply
        ? (
            await menu.createItem(tx, {
              tenantId,
              staffId,
              categoryId,
              name: dish.name,
              pricePaisa: dish.pricePaisa,
              productionDestination: dish.destination,
            })
          ).id
        : newId('dish', dishKey),
    )
  }

  const groupIds = new Map<string, string>()
  // Choose / Required as the sheet gives them for each group, from whichever
  // row fills them in; two rows that disagree are an error, not "first wins".
  const groupSettings = new Map<string, { selection?: 'single' | 'multi'; isRequired?: boolean; row: number }>()
  for (const option of parsed.options) {
    const key = [option.category, option.dish, option.group].map(nameKey).join('|')
    const held = groupSettings.get(key) ?? { row: option.row }
    const clash =
      (option.selection !== undefined && held.selection !== undefined && option.selection !== held.selection) ||
      (option.isRequired !== undefined && held.isRequired !== undefined && option.isRequired !== held.isRequired)
    if (clash) {
      summary.errors.push({
        sheet: OPTIONS_SHEET,
        row: option.row,
        message: `Choose or Required differs from row ${held.row} for the group "${option.group}"`,
      })
    }
    groupSettings.set(key, {
      row: held.row,
      selection: held.selection ?? option.selection,
      isRequired: held.isRequired ?? option.isRequired,
    })
  }

  for (const option of parsed.options) {
    const fail = (message: string) => summary.errors.push({ sheet: OPTIONS_SHEET, row: option.row, message })
    const dishKey = `${nameKey(option.category)}|${nameKey(option.dish)}`
    let itemId = dishIds.get(dishKey)
    if (!itemId) {
      // Not in the Dishes sheet: a dish already on the menu.
      const category = categories.get(nameKey(option.category))
      const item = category ? items.get(`${category.id}|${nameKey(option.dish)}`) : undefined
      if (!category || !item || !category.isActive || !item.isActive) {
        fail(`No dish "${option.dish}" in ${option.category}, in the Dishes sheet or on the menu`)
        continue
      }
      itemId = item.id
    }

    const groupKey = `${itemId}|${nameKey(option.group)}`
    const wanted = groupSettings.get([option.category, option.dish, option.group].map(nameKey).join('|'))!
    let groupId = groupIds.get(groupKey)
    if (!groupId) {
      const existing = groups.get(groupKey)
      if (existing) {
        groupId = existing.id
        // Only what the sheet fills in; a blank keeps the live value.
        const set: { selection?: 'single' | 'multi'; isRequired?: boolean } = {}
        if (wanted.selection !== undefined && wanted.selection !== existing.selection) set.selection = wanted.selection
        if (wanted.isRequired !== undefined && wanted.isRequired !== existing.isRequired) set.isRequired = wanted.isRequired
        if (Object.keys(set).length > 0) {
          summary.groups.updated += 1
          if (apply) await menu.updateGroup(tx, { tenantId, staffId, id: existing.id, version: existing.version, ...set })
        }
      } else {
        summary.groups.new += 1
        groupId = apply
          ? (
              await menu.createGroup(tx, {
                tenantId,
                staffId,
                itemId,
                name: option.group,
                selection: wanted.selection ?? 'single',
                isRequired: wanted.isRequired ?? false,
              })
            ).id
          : newId('group', groupKey)
      }
      groupIds.set(groupKey, groupId)
    }

    const existing = options.get(`${groupId}|${nameKey(option.option)}`)
    if (existing) {
      const set: { priceDeltaPaisa?: number; isDefault?: boolean; maxCount?: number } = {}
      if (option.priceDeltaPaisa !== undefined && existing.priceDeltaPaisa !== option.priceDeltaPaisa) set.priceDeltaPaisa = option.priceDeltaPaisa
      if (option.isDefault !== undefined && existing.isDefault !== option.isDefault) set.isDefault = option.isDefault
      if (option.maxCount !== undefined && existing.maxCount !== option.maxCount) set.maxCount = option.maxCount
      if (Object.keys(set).length > 0) {
        summary.options.updated += 1
        if (apply) await menu.updateOption(tx, { tenantId, staffId, id: existing.id, version: existing.version, ...set })
      }
      continue
    }
    summary.options.new += 1
    if (apply) {
      await menu.createOption(tx, {
        tenantId,
        staffId,
        groupId,
        name: option.option,
        priceDeltaPaisa: option.priceDeltaPaisa ?? 0,
        isDefault: option.isDefault ?? false,
        maxCount: option.maxCount ?? 1,
        excludesGroupId: null,
      })
    }
  }

  // An apply never half-writes: any error rolls the whole transaction back.
  if (apply && summary.errors.length > 0) throw new ImportRejectedError(summary.errors[0]!.message)
  return summary
}
