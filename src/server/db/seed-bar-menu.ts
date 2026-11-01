/**
 * Brings a database seeded BEFORE the bar existed up to the bar menu
 * (Teran, 2026-10-30). A fresh install gets it from `seed.ts` directly.
 *
 *   pnpm exec tsx --env-file=.env src/server/db/seed-bar-menu.ts
 *
 * Idempotent — run it twice and the second run changes nothing:
 * - each bar category is created only if no category has that name;
 * - an item that already exists by name (Lion Lager, King Coconut…) is MOVED
 *   into its bar category rather than duplicated, keeping its id, so past
 *   orders and bills still point at it;
 * - the old "Drinks" category is DEACTIVATED, never deleted — items and order
 *   history reference it, and a deactivated category simply leaves the menu;
 * - every bar item, found OR created, gets its sample priced options (Story
 *   4.8): a group or option already there by name is left exactly as it is;
 * - the RETIRED sample options ("Double shot", whisky's "Measure") are DELETED
 *   from bar items. Unlike a category, nothing references an option row: a
 *   sent order keeps its own copy in `order_events.options`, so past orders and
 *   bills still read "Double shot". A line staged with one and not yet sent is
 *   flagged on the tablet and re-added.
 *
 * Refuses to run in production, like `seed.ts`: this is sample data.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { menuCategories, menuItems, modifierGroups, modifierOptions, tenants } from './schema'
import { BAR_MENU, RETIRED_GROUPS, RETIRED_OPTIONS, ensureModifierGroups } from './bar-menu'

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[seed-bar-menu] Refusing to run with NODE_ENV=production')
  }

  // Its own pool, as `seed.ts` has: `./index` imports 'server-only', which
  // throws outside Next.js.
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('[seed-bar-menu] DATABASE_URL is not set')
  const pool = new Pool({ connectionString })
  const db = drizzle(pool)

  const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1)
  if (!tenant) throw new Error('[seed-bar-menu] No tenant — run the main seed first')

  const summary = {
    categoriesCreated: 0,
    itemsCreated: 0,
    itemsMoved: 0,
    groupsCreated: 0,
    optionsCreated: 0,
    groupsRemoved: 0,
    optionsRemoved: 0,
    drinksRetired: false,
  }

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: menuCategories.id, name: menuCategories.name, order: menuCategories.displayOrder })
      .from(menuCategories)
      .where(eq(menuCategories.tenantId, tenant.id))
    // After whatever is there now, so the bar follows the food on a table's menu.
    let nextOrder = Math.max(0, ...existing.map((row) => row.order)) + 1

    for (const group of BAR_MENU) {
      let categoryId = existing.find((row) => row.name === group.category)?.id
      if (!categoryId) {
        const [created] = await tx
          .insert(menuCategories)
          .values({ tenantId: tenant.id, name: group.category, displayOrder: nextOrder++ })
          .returning({ id: menuCategories.id })
        categoryId = created.id
        summary.categoriesCreated += 1
      }

      for (const [index, item] of group.items.entries()) {
        const [found] = await tx
          .select({ id: menuItems.id, categoryId: menuItems.categoryId })
          .from(menuItems)
          .where(and(eq(menuItems.tenantId, tenant.id), eq(menuItems.name, item.name)))
          .limit(1)

        let itemId = found?.id
        if (found) {
          if (found.categoryId !== categoryId) {
            await tx
              .update(menuItems)
              .set({ categoryId, displayOrder: index })
              .where(eq(menuItems.id, found.id))
            summary.itemsMoved += 1
          }
        } else {
          const [created] = await tx
            .insert(menuItems)
            .values({
              tenantId: tenant.id,
              categoryId,
              name: item.name,
              pricePaisa: item.pricePaisa,
              productionDestination: item.destination,
              isAvailable: item.available ?? true,
              portionCount: item.portionCount ?? null,
              displayOrder: index,
            })
            .returning({ id: menuItems.id })
          itemId = created.id
          summary.itemsCreated += 1
        }

        const added = await ensureModifierGroups(tx, tenant.id, itemId!, item.modifierGroups)
        summary.groupsCreated += added.groups
        summary.optionsCreated += added.options

        // ── Retired sample options on THIS item ───────────────────────────
        const groups = await tx
          .select({ id: modifierGroups.id, name: modifierGroups.name })
          .from(modifierGroups)
          .where(eq(modifierGroups.menuItemId, itemId!))
        for (const group of groups) {
          if (RETIRED_GROUPS.includes(group.name)) {
            const gone = await tx
              .delete(modifierOptions)
              .where(eq(modifierOptions.groupId, group.id))
              .returning({ id: modifierOptions.id })
            summary.optionsRemoved += gone.length
            await tx.delete(modifierGroups).where(eq(modifierGroups.id, group.id))
            summary.groupsRemoved += 1
            continue
          }
          const names = RETIRED_OPTIONS.filter((retired) => retired.group === group.name).map(
            (retired) => retired.option,
          )
          if (names.length === 0) continue
          const gone = await tx
            .delete(modifierOptions)
            .where(and(eq(modifierOptions.groupId, group.id), inArray(modifierOptions.name, names)))
            .returning({ id: modifierOptions.id })
          summary.optionsRemoved += gone.length
        }
      }
    }

    const retired = await tx
      .update(menuCategories)
      .set({ isActive: false })
      .where(
        and(
          eq(menuCategories.tenantId, tenant.id),
          eq(menuCategories.name, 'Drinks'),
          eq(menuCategories.isActive, true),
        ),
      )
      .returning({ id: menuCategories.id })
    summary.drinksRetired = retired.length > 0
  })

  console.log('[seed-bar-menu] done:', summary)
  await pool.end()
}

main().catch((error) => {
  console.error('[seed-bar-menu] failed:', error)
  process.exit(1)
})
