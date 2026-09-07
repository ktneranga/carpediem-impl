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
import { staff, tables, tenantConfig, tenants, zones } from './schema'

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
      { label: 'S2', capacity: 2, status: 'unavailable' as const }, // AC-6 needs one
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
      { label: 'R3', capacity: 8, status: 'unavailable' as const },
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
            displayOrder: index + 1,
          })
          tableCount += 1
        }
      }
    })

    console.log(
      `[seed] Created tenant "Carpe Diem" with config, 3 staff, ${SEED_ZONES.length} zones and ${tableCount} tables.\n`,
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
