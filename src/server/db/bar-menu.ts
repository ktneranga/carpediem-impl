/**
 * The bar's menu (Teran, 2026-10-30): the categories a bar tab shows.
 *
 * SAMPLE items at Teran's example prices — a cocktail 2,500, a mocktail 1,500,
 * a shot 1,000 — until the back office manages the menu. Every item is made at
 * the BAR, which is what puts it on a bar tab's menu (`production_destination`).
 *
 * Shared by `seed.ts` (a fresh install) and `seed-bar-menu.ts` (a database
 * seeded before the bar existed), so the two cannot drift.
 *
 * Priced options — no alcohol, double shot, oat milk — ride on the items they
 * belong to (Story 4.8), as SAMPLE groups until the back office manages them.
 * `ensureModifierGroups` writes them, for both seeds.
 */
import { and, eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { modifierGroups, modifierOptions } from './schema'

export type SeedOption = {
  name: string
  priceDeltaPaisa: number
  isDefault?: boolean
  /** More than 1 makes it countable — a −/+ stepper on the sheet. */
  maxCount?: number
}

export type SeedModifierGroup = {
  name: string
  selection: 'single' | 'multi'
  required: boolean
  options: SeedOption[]
}

export type SeedItem = {
  name: string
  pricePaisa: number
  destination: 'kitchen' | 'pizza_kitchen' | 'bar'
  available?: boolean
  portionCount?: number
  modifierGroups?: SeedModifierGroup[]
}

// ── The sample options (Story 4.8, AC 13) ───────────────────────────────────
/**
 * A cocktail's spirit: none for LKR 1,000 less, or the standard single. More
 * spirit is the Extra shots stepper — a "Double shot" here priced exactly what
 * Single + 1 extra shot does, so it was removed (Teran, 2026-11-01).
 */
const ALCOHOL: SeedModifierGroup = {
  name: 'Alcohol',
  selection: 'single',
  required: true,
  options: [
    { name: 'No alcohol', priceDeltaPaisa: -100000 },
    { name: 'Single', priceDeltaPaisa: 0, isDefault: true },
  ],
}

const ICE: SeedModifierGroup = {
  name: 'Ice',
  selection: 'multi',
  required: false,
  options: [{ name: 'No ice', priceDeltaPaisa: 0 }],
}

/**
 * More spirit than a double: each extra shot at the shot's own price, up to
 * four (Teran, 2026-11-01 — "more than two shots" without a manual price).
 */
const extraShots = (shotPaisa: number): SeedModifierGroup => ({
  name: 'Extra shots',
  selection: 'multi',
  required: false,
  options: [{ name: 'Extra shot', priceDeltaPaisa: shotPaisa, maxCount: 4 }],
})

const COFFEE_EXTRAS: SeedModifierGroup = {
  name: 'Extras',
  selection: 'multi',
  required: false,
  options: [
    { name: 'Extra shot', priceDeltaPaisa: 20000, maxCount: 3 },
    { name: 'Oat milk', priceDeltaPaisa: 25000 },
  ],
}

export const BAR_MENU: { category: string; items: SeedItem[] }[] = [
  {
    category: 'Cocktails',
    items: [
      {
        name: 'Mojito',
        pricePaisa: 250000,
        destination: 'bar',
        modifierGroups: [ALCOHOL, extraShots(100000), ICE],
      },
      {
        name: 'Piña Colada',
        pricePaisa: 280000,
        destination: 'bar',
        modifierGroups: [ALCOHOL, extraShots(100000), ICE],
      },
      {
        name: 'Long Island Iced Tea',
        pricePaisa: 320000,
        destination: 'bar',
        modifierGroups: [ALCOHOL, extraShots(100000), ICE],
      },
      { name: 'Arrack & Soda', pricePaisa: 70000, destination: 'bar' },
    ],
  },
  {
    category: 'Mocktails',
    items: [
      { name: 'Virgin Mojito', pricePaisa: 150000, destination: 'bar' },
      { name: 'Passion Fruit Cooler', pricePaisa: 120000, destination: 'bar' },
      { name: 'King Coconut', pricePaisa: 35000, destination: 'bar', portionCount: 25 },
      { name: 'Fresh Lime Soda', pricePaisa: 40000, destination: 'bar' },
    ],
  },
  {
    category: 'Coffee',
    items: [
      { name: 'Espresso', pricePaisa: 60000, destination: 'bar' },
      { name: 'Cappuccino', pricePaisa: 90000, destination: 'bar', modifierGroups: [COFFEE_EXTRAS] },
      { name: 'Iced Coffee', pricePaisa: 100000, destination: 'bar', modifierGroups: [COFFEE_EXTRAS] },
    ],
  },
  {
    category: 'Tea',
    items: [
      { name: 'Ceylon Black Tea', pricePaisa: 40000, destination: 'bar' },
      { name: 'Ginger Tea', pricePaisa: 50000, destination: 'bar' },
      { name: 'Iced Lemon Tea', pricePaisa: 70000, destination: 'bar' },
    ],
  },
  {
    category: 'Beer',
    items: [
      { name: 'Lion Lager', pricePaisa: 55000, destination: 'bar', portionCount: 48 },
      { name: 'Lion Stout', pricePaisa: 80000, destination: 'bar' },
      { name: 'Carlsberg', pricePaisa: 75000, destination: 'bar' },
    ],
  },
  {
    category: 'Whisky',
    items: [
      {
        name: 'Johnnie Walker Red (shot)',
        pricePaisa: 100000,
        destination: 'bar',
        modifierGroups: [extraShots(100000)],
      },
      {
        name: 'Jameson (shot)',
        pricePaisa: 120000,
        destination: 'bar',
        modifierGroups: [extraShots(120000)],
      },
      {
        name: 'Johnnie Walker Black (shot)',
        pricePaisa: 150000,
        destination: 'bar',
        modifierGroups: [extraShots(150000)],
      },
    ],
  },
]

/**
 * Sample options that were seeded once and then dropped (Teran, 2026-11-01):
 * "Double shot" and whisky's "Measure" duplicate the Extra shots stepper.
 * `seed-bar-menu.ts` deletes them from a database seeded before.
 */
export const RETIRED_OPTIONS = [{ group: 'Alcohol', option: 'Double shot' }]
export const RETIRED_GROUPS = ['Measure']

/** A seed's transaction handle — both seeds open their own `node-postgres` pool. */
type SeedTx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

/**
 * Gives a menu item its sample option groups. IDEMPOTENT: a group is matched by
 * (item, name) and an option by (group, name), and only what is missing is
 * inserted — an existing one is never changed, so a price the owner edited
 * survives a re-run. Returns how many groups and options it created.
 */
export async function ensureModifierGroups(
  tx: SeedTx,
  tenantId: string,
  menuItemId: string,
  groups: SeedModifierGroup[] = [],
): Promise<{ groups: number; options: number }> {
  const created = { groups: 0, options: 0 }
  for (const [groupIndex, group] of groups.entries()) {
    const [found] = await tx
      .select({ id: modifierGroups.id })
      .from(modifierGroups)
      .where(and(eq(modifierGroups.menuItemId, menuItemId), eq(modifierGroups.name, group.name)))
      .limit(1)
    let groupId = found?.id
    if (!groupId) {
      const [inserted] = await tx
        .insert(modifierGroups)
        .values({
          tenantId,
          menuItemId,
          name: group.name,
          selection: group.selection,
          isRequired: group.required,
          displayOrder: groupIndex,
        })
        .returning({ id: modifierGroups.id })
      groupId = inserted.id
      created.groups += 1
    }

    for (const [optionIndex, option] of group.options.entries()) {
      const [existing] = await tx
        .select({ id: modifierOptions.id })
        .from(modifierOptions)
        .where(and(eq(modifierOptions.groupId, groupId), eq(modifierOptions.name, option.name)))
        .limit(1)
      if (existing) continue
      await tx.insert(modifierOptions).values({
        tenantId,
        groupId,
        name: option.name,
        priceDeltaPaisa: option.priceDeltaPaisa,
        isDefault: option.isDefault ?? false,
        maxCount: option.maxCount ?? 1,
        displayOrder: optionIndex,
      })
      created.options += 1
    }
  }
  return created
}
