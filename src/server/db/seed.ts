/**
 * Development seed. Creates one tenant, its config, and three staff accounts.
 *
 * Run with:  pnpm db:seed   (DATABASE_URL must be set)
 *
 * This is a DEVELOPER TOOL, not application code. It is the only place in the
 * repository permitted to print a plaintext PIN, and it refuses to run in
 * production. Nothing under src/app or src/server/services may do the same.
 */
// Still no dotenv dependency. The `db:seed` script passes Node's own
// --env-file-if-exists=.env instead, so a local .env is picked up and a
// container without one (env comes from compose) starts unaffected.
// Overriding inline still works:
//   DATABASE_URL="postgres://..." pnpm db:seed
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { menuCategories, menuItems, staff, tables, tenantConfig, tenants, zones } from './schema'

const BCRYPT_COST = 10 // architecture.md:205 — not 8, not 12

const SEED_STAFF = [
  { name: 'Nina',  role: 'waiter'  as const, pin: '1234' },
  { name: 'Aruna', role: 'owner'   as const, pin: '5678' },
  { name: 'Kumar', role: 'kitchen' as const, pin: '4321' },
]

/**
 * The four zones from prd.md:61.
 *
 * Table statuses are only `open` or `unavailable`. NOTHING is seeded as
 * `occupied` — occupancy is derived from an `order_sessions` row with
 * `closed_at IS NULL`, so a table flagged occupied with no session would be
 * inconsistent data that the grid query could not explain.
 * Occupied state arrives for real in Story 3.3.
 */
const SEED_ZONES = [
  {
    name: 'Bean Bags',
    displayOrder: 1,
    tables: [
      { label: 'B1', capacity: 2, status: 'open' as const },
      { label: 'B2', capacity: 2, status: 'open' as const },
      { label: 'B3', capacity: 4, status: 'open' as const },
    ],
  },
  {
    name: 'Sun Beds',
    displayOrder: 2,
    tables: [
      { label: 'S1', capacity: 2, status: 'open' as const },
      // A reason is REQUIRED whenever status is unavailable — enforced by
      // tables_unavailable_reason_matches_status (migration 0006), not just by
      // the API. Seeding one without a reason fails at insert.
      { label: 'S2', capacity: 2, status: 'unavailable' as const, reason: 'Sun bed broken' },
      { label: 'S3', capacity: 2, status: 'open' as const },
    ],
  },
  {
    name: 'Tables',
    displayOrder: 3,
    tables: [
      { label: 'Table 1', capacity: 4, status: 'open' as const },
      { label: 'Table 2', capacity: 4, status: 'open' as const },
      { label: 'Table 3', capacity: 6, status: 'open' as const },
      { label: 'Table 4', capacity: 6, status: 'open' as const },
    ],
  },
  {
    name: 'Rooftop',
    displayOrder: 4,
    tables: [
      { label: 'R1', capacity: 4, status: 'open' as const },
      { label: 'R2', capacity: 4, status: 'open' as const },
      { label: 'R3', capacity: 8, status: 'unavailable' as const, reason: 'Awaiting repair' },
    ],
  },
]

/**
 * A menu with enough shape to exercise Story 4.2 and the stories after it.
 *
 * Deliberately covers all THREE production destinations (FR9), because Story 4.5
 * routes on them and a seed with only `kitchen` items would let a broken router
 * pass every test. One item is unavailable so the 86'd rendering has something
 * to render, and several carry `portionCount` so Epic 8 has stock to decrement.
 *
 * Prices are integer PAISA. 185000 is LKR 1,850 — never a float, anywhere.
 */
const SEED_MENU: {
  category: string
  items: {
    name: string
    pricePaisa: number
    destination: 'kitchen' | 'pizza_kitchen' | 'bar'
    available?: boolean
    portionCount?: number
  }[]
}[] = [
  {
    category: 'Starters',
    items: [
      { name: 'Devilled Cashew', pricePaisa: 95000, destination: 'kitchen', portionCount: 20 },
      { name: 'Fish Cutlets', pricePaisa: 80000, destination: 'kitchen', portionCount: 30 },
      { name: 'Garlic Bread', pricePaisa: 65000, destination: 'pizza_kitchen' },
    ],
  },
  {
    category: 'Mains',
    items: [
      { name: 'Grilled Fish', pricePaisa: 185000, destination: 'kitchen', portionCount: 12 },
      { name: 'Butter Prawns', pricePaisa: 245000, destination: 'kitchen', portionCount: 8 },
      { name: 'Lamprais', pricePaisa: 165000, destination: 'kitchen' },
      // The 86'd item. Story 4.2 AC-4 needs one to exist from the first run —
      // an unavailable rendering nobody has seen is an unavailable rendering
      // nobody has tested.
      { name: 'Crab Curry', pricePaisa: 320000, destination: 'kitchen', available: false, portionCount: 0 },
    ],
  },
  {
    category: 'Pizza',
    items: [
      { name: 'Margherita', pricePaisa: 145000, destination: 'pizza_kitchen', portionCount: 15 },
      { name: 'Seafood Pizza', pricePaisa: 210000, destination: 'pizza_kitchen', portionCount: 10 },
    ],
  },
  {
    category: 'Drinks',
    items: [
      { name: 'Lion Lager', pricePaisa: 55000, destination: 'bar', portionCount: 48 },
      { name: 'Arrack & Soda', pricePaisa: 70000, destination: 'bar' },
      { name: 'King Coconut', pricePaisa: 35000, destination: 'bar', portionCount: 25 },
      { name: 'Fresh Lime Soda', pricePaisa: 40000, destination: 'bar' },
    ],
  },
]

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[seed] Refusing to run with NODE_ENV=production')
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('[seed] DATABASE_URL is not set')
  }

  // Own pool rather than importing @/server/db — that module is marked
  // `server-only`, which throws outside a Next.js request context.
  const pool = new Pool({ connectionString })
  const db = drizzle(pool)

  try {
    const existing = await db.select({ id: tenants.id }).from(tenants).limit(1)
    if (existing.length > 0) {
      console.log('[seed] A tenant already exists — nothing to do.')
      console.log('[seed] To re-seed, drop and recreate the database first.')
      return
    }

    // One transaction for the whole fixture.
    //
    // The guard above only checks for a tenant, so a run that died partway
    // through — after the tenant insert but before the zones — left a database
    // that looked seeded and had no tables, and every later run printed
    // "A tenant already exists" and exited. The only recovery was dropping the
    // database. All-or-nothing means a failed seed leaves nothing behind and
    // simply re-running works.
    let tableCount = 0
    let menuItemCount = 0

    await db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: 'Carpe Diem', timezone: 'Asia/Colombo' })
        .returning({ id: tenants.id })

      // Auth defaults per prd.md:304-310. Columns carry these as schema defaults;
      // stated explicitly here so the seeded values are visible and intentional.
      await tx.insert(tenantConfig).values({
        tenantId: tenant.id,
        restaurantName: 'Carpe Diem',
        authMode: 'session_short',
        sessionTimeoutMinutes: 5,
        financialActionReauth: true,
      })

      // A PIN is the entire credential — login carries no staff selector, so
      // two staff sharing a PIN means every action by the second is attributed
      // to the first, silently. Fixing PIN length at 4 digits made collisions
      // far likelier, so the fixtures must not model a state the real system
      // will forbid (see Story 10.2's PIN-uniqueness AC).
      //
      // Checked on the plaintext here because the seed has it. Story 10.2 has to
      // compare against every active hash with bcrypt instead, since it only
      // ever sees one candidate at a time.
      const seenPins = new Set<string>()
      for (const person of SEED_STAFF) {
        if (seenPins.has(person.pin)) {
          throw new Error(
            `[seed] Duplicate PIN for "${person.name}" — every staff member needs a distinct PIN, ` +
              'or sign-in attributes their actions to whoever the login loop matches first.',
          )
        }
        seenPins.add(person.pin)
      }

      for (const person of SEED_STAFF) {
        await tx.insert(staff).values({
          tenantId: tenant.id,
          name: person.name,
          role: person.role,
          pinHash: await bcrypt.hash(person.pin, BCRYPT_COST),
          isActive: true,
        })
      }

      for (const zoneSpec of SEED_ZONES) {
        const [zone] = await tx
          .insert(zones)
          .values({
            tenantId: tenant.id,
            name: zoneSpec.name,
            displayOrder: zoneSpec.displayOrder,
            isActive: true,
          })
          .returning({ id: zones.id })

        for (const [index, tableSpec] of zoneSpec.tables.entries()) {
          await tx.insert(tables).values({
            tenantId: tenant.id,
            zoneId: zone.id,
            label: tableSpec.label,
            status: tableSpec.status,
            capacity: tableSpec.capacity,
            // Only unavailable tables carry one, and they must — the CHECK
            // constraint added in 0006 rejects either half of the mismatch.
            unavailableReason: 'reason' in tableSpec ? tableSpec.reason : null,
            displayOrder: index + 1,
          })
          tableCount += 1
        }
      }

      // The menu. Inside the SAME transaction as everything else — a seed that
      // leaves a tenant with tables and no menu looks seeded and cannot take an
      // order, which is the half-seeded state the all-or-nothing guard exists
      // to prevent.
      for (const [categoryIndex, group] of SEED_MENU.entries()) {
        const [category] = await tx
          .insert(menuCategories)
          .values({
            tenantId: tenant.id,
            name: group.category,
            displayOrder: categoryIndex,
          })
          .returning({ id: menuCategories.id })

        for (const [itemIndex, item] of group.items.entries()) {
          await tx.insert(menuItems).values({
            tenantId: tenant.id,
            categoryId: category.id,
            name: item.name,
            pricePaisa: item.pricePaisa,
            productionDestination: item.destination,
            isAvailable: item.available ?? true,
            portionCount: item.portionCount ?? null,
            displayOrder: itemIndex,
          })
          menuItemCount += 1
        }
      }
    })

    console.log(
      `[seed] Created tenant "Carpe Diem" with config, 3 staff, ${SEED_ZONES.length} zones, ` +
        `${tableCount} tables, ${SEED_MENU.length} menu categories and ${menuItemCount} items.\n`,
    )
    console.log('  Name   Role     PIN')
    console.log('  ─────  ───────  ────')
    for (const person of SEED_STAFF) {
      console.log(`  ${person.name.padEnd(5)}  ${person.role.padEnd(7)}  ${person.pin}`)
    }
    console.log('\n[seed] Development credentials only. Never seed these into a real deployment.')
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('[seed] Failed:', error)
  process.exit(1)
})
