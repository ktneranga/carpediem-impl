/**
 * Development seed. Creates one tenant, its config, and three staff accounts.
 *
 * Run with:  pnpm db:seed   (DATABASE_URL must be set)
 *
 * This is a DEVELOPER TOOL, not application code. It is the only place in the
 * repository permitted to print a plaintext PIN, and it refuses to run in
 * production. Nothing under src/app or src/server/services may do the same.
 */
// No dotenv — it is not a project dependency and adding one was not in scope.
// Pass DATABASE_URL explicitly:
//   DATABASE_URL="postgres://postgres:changeme@localhost:5432/cdrms" pnpm db:seed
import bcrypt from 'bcryptjs'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { staff, tenantConfig, tenants } from './schema'

const BCRYPT_COST = 10 // architecture.md:205 — not 8, not 12

const SEED_STAFF = [
  { name: 'Nina',  role: 'waiter'  as const, pin: '1234' },
  { name: 'Aruna', role: 'owner'   as const, pin: '5678' },
  { name: 'Kumar', role: 'kitchen' as const, pin: '4321' },
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

    const [tenant] = await db
      .insert(tenants)
      .values({ name: 'Carpe Diem', timezone: 'Asia/Colombo' })
      .returning({ id: tenants.id })

    // Auth defaults per prd.md:304-310. Columns carry these as schema defaults;
    // stated explicitly here so the seeded values are visible and intentional.
    await db.insert(tenantConfig).values({
      tenantId: tenant.id,
      restaurantName: 'Carpe Diem',
      authMode: 'session_short',
      sessionTimeoutMinutes: 5,
      financialActionReauth: true,
    })

    for (const person of SEED_STAFF) {
      await db.insert(staff).values({
        tenantId: tenant.id,
        name: person.name,
        role: person.role,
        pinHash: await bcrypt.hash(person.pin, BCRYPT_COST),
        isActive: true,
      })
    }

    console.log('[seed] Created tenant "Carpe Diem" with config and 3 staff.\n')
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
