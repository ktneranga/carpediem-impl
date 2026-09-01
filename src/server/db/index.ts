import 'server-only'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

// The pool is created lazily on first query, NOT at module load.
//
// Why: `next build` imports every route module while collecting page data. A
// top-level throw here made the build fail whenever DATABASE_URL was absent —
// which is exactly the case inside the Docker builder stage and in CI, where no
// database exists. Migrations run at container start (docker/scripts/migrate.sh),
// never at build time, so the build has no legitimate need for a connection.
//
// Fail-fast is preserved, just moved to first use. A missing DATABASE_URL at
// runtime throws on the first query, which /api/health catches and reports as
// 503 { status: "degraded", db: "error" }.

let cachedDb: NodePgDatabase | undefined

function getDb(): NodePgDatabase {
  if (cachedDb) return cachedDb

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('[db] DATABASE_URL is not set — check your .env.local file')
  }

  // P5: Guard against NaN if DATABASE_POOL_MAX is set to a non-numeric value
  const poolMax = parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10)

  const pool = new Pool({
    connectionString,
    max: Number.isNaN(poolMax) ? 10 : poolMax,
  })

  // P4: Prevent idle-client errors from becoming unhandled Node.js 'error' events that crash the process
  pool.on('error', (err) => {
    console.error('[db] Unexpected pool client error:', err)
  })

  cachedDb = drizzle(pool)
  return cachedDb
}

// Proxy keeps the existing `import { db } from '@/server/db'` call sites unchanged
// while deferring construction until a property is actually accessed.
export const db = new Proxy({} as NodePgDatabase, {
  get(_target, prop, receiver) {
    const real = getDb()
    const value = Reflect.get(real, prop, receiver)
    return typeof value === 'function' ? value.bind(real) : value
  },
})
