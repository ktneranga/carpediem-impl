import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'
import { hasUnfillableRequiredGroup } from '@/lib/options'
import { db } from '@/server/db'
import { menuCategories, menuItems, tenants } from '@/server/db/schema'
import { loadModifierGroups } from '@/server/orders/modifier-groups'
import type { ModifierGroupRow } from '@/types/orders'

/**
 * One item as the client sees it.
 *
 * camelCase, never raw column names — `architecture.md:520`: "Drizzle returns
 * snake_case. A mapping layer in each service converts to camelCase before the
 * Route Handler returns the response."
 *
 * `available`, not `isAvailable`, because that is the name Story 4.2's AC-5 puts
 * in the contract and Epic 8's `menu:item_updated` payload uses the same word.
 * One name for one fact across the API and the socket.
 */
export type MenuItemRow = {
  id: string
  name: string
  /** Integer paisa. Never a float — see `src/lib/format.ts`. */
  pricePaisa: number
  available: boolean
  productionDestination: 'kitchen' | 'pizza_kitchen' | 'bar'
  /** Null when the item is not portion-tracked. Epic 8 owns the counting. */
  portionCount: number | null
  /**
   * A photograph, or null — which is the common case.
   *
   * The card renders a category-icon tile when this is absent. That is a
   * designed state, not a missing one: `ux:411` ruled images out entirely on the
   * grounds that restaurants cannot photograph 100+ items, and that reasoning
   * still holds for most of the menu.
   */
  imageUrl: string | null
  /**
   * The dish's priced options — "Alcohol: No alcohol / Single", "Extra shots"
   * (Story 4.8). `[]` when it has none. Required, not optional: the tablet
   * PRICES from this, and a missing field would price an optioned dish wrong.
   * Unavailable options are included and flagged, as unavailable items are.
   */
  modifierGroups: ModifierGroupRow[]
}

export type MenuCategoryRow = {
  id: string
  name: string
  items: MenuItemRow[]
}

function fail(code: string, message: string, status: number) {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

/**
 * The ordering menu — every active category with its items (FR7).
 *
 * ── Why unavailable items are RETURNED ───────────────────────────────────────
 * Nothing is filtered by `is_available`. An 86'd item must still appear, greyed
 * out: a waiter needs to see that the dish exists in order to tell the guest it
 * has run out. Filtering server-side would make it vanish from the menu
 * entirely, which reads as "we never sold that" rather than "we are out".
 *
 * ── Why one query ────────────────────────────────────────────────────────────
 * A join plus assembly in JS, rather than a query per category. The menu is
 * bounded by one restaurant — the PRD's own figure is 100+ items — and this runs
 * on every order screen. `/api/tables` established the same shape.
 *
 * RBAC comes from `{ prefix: '/api/menu', roles: ['owner','waiter'] }`, added in
 * Task 2 BEFORE this file existed: the prefix matched no policy until then, and
 * an unmatched prefix is default-allow.
 */
export async function GET() {
  try {
    // Single-tenant-per-stack (NFR-SC1), same as /api/tables.
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).limit(1)
    if (!tenant) {
      return fail('NOT_PROVISIONED', 'No restaurant is configured', 503)
    }

    const rows = await db
      .select({
        categoryId: menuCategories.id,
        categoryName: menuCategories.name,
        itemId: menuItems.id,
        itemName: menuItems.name,
        pricePaisa: menuItems.pricePaisa,
        available: menuItems.isAvailable,
        productionDestination: menuItems.productionDestination,
        portionCount: menuItems.portionCount,
        imageUrl: menuItems.imageUrl,
      })
      .from(menuCategories)
      // LEFT, so a category with no items still appears. An empty category is a
      // configuration fact the owner should see, not one the API hides.
      // Removed dishes (Story 10.4, `is_active = false`) are not on the menu.
      // In the JOIN, not the WHERE, so a category whose dishes are all removed
      // still appears, empty.
      .leftJoin(menuItems, and(eq(menuItems.categoryId, menuCategories.id), eq(menuItems.isActive, true)))
      .where(and(eq(menuCategories.tenantId, tenant.id), eq(menuCategories.isActive, true)))
      .orderBy(
        asc(menuCategories.displayOrder),
        asc(menuCategories.name),
        asc(menuItems.displayOrder),
        asc(menuItems.name),
      )

    // Every item's options in one more query (Story 4.8).
    const groupsByItem = await loadModifierGroups(db, { tenantId: tenant.id })

    // Assembled in insertion order, which the ORDER BY above already fixed —
    // a Map preserves it, so no re-sorting is needed on either side.
    const categories = new Map<string, MenuCategoryRow>()

    for (const row of rows) {
      let category = categories.get(row.categoryId)
      if (!category) {
        category = { id: row.categoryId, name: row.categoryName, items: [] }
        categories.set(row.categoryId, category)
      }

      // Null on the left-join miss — a category with no items.
      if (row.itemId === null) continue

      const groups = groupsByItem.get(row.itemId) ?? []
      category.items.push({
        id: row.itemId,
        name: row.itemName ?? '',
        pricePaisa: row.pricePaisa ?? 0,
        // Also unavailable when a REQUIRED option group has nothing left to
        // choose: the send would refuse every line of it (code review
        // 2026-11-01), so the waiter sees it greyed instead.
        available: (row.available ?? false) && !hasUnfillableRequiredGroup(groups),
        productionDestination: row.productionDestination ?? 'kitchen',
        portionCount: row.portionCount,
        imageUrl: row.imageUrl,
        modifierGroups: groups,
      })
    }

    return NextResponse.json({ success: true, data: Array.from(categories.values()) })
  } catch (error) {
    console.error('[api/menu] Failed to load the menu:', error)
    return fail('INTERNAL_ERROR', 'Could not load the menu', 500)
  }
}
