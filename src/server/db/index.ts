import 'server-only'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

// P3: Fail fast at startup rather than silently misconfiguring the pool
if (!process.env.DATABASE_URL) {
  throw new Error('[db] DATABASE_URL is not set — check your .env.local file')
}

// P5: Guard against NaN if DATABASE_POOL_MAX is set to a non-numeric value
const poolMax = parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isNaN(poolMax) ? 10 : poolMax,
})

// P4: Prevent idle-client errors from becoming unhandled Node.js 'error' events that crash the process
pool.on('error', (err) => {
  console.error('[db] Unexpected pool client error:', err)
})

export const db = drizzle(pool)
