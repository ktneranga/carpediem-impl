/**
 * Standalone expired-session reaper.
 *
 * Deliberately does NOT import `@/server/db` or the session service. Those carry
 * `import 'server-only'`, which throws when pulled in from `server.ts` — a plain
 * Node process outside Next's module graph. `seed.ts` owns its pool for exactly
 * the same reason.
 *
 * One statement, one short-lived connection, no ORM. Housekeeping should not
 * hold a pool open for the life of the process.
 */
import { Pool } from 'pg'

let pool: Pool | undefined

function getPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error('[sessions] DATABASE_URL is not set')
  }

  // Tiny pool — this runs once every ten minutes.
  pool = new Pool({ connectionString, max: 1 })
  pool.on('error', (err) => {
    console.error('[sessions] Sweep pool error:', err)
  })

  return pool
}

/** Deletes sessions past their expiry. Returns how many were removed. */
export async function sweepExpiredSessions(): Promise<number> {
  const result = await getPool().query('DELETE FROM staff_sessions WHERE expires_at < now()')
  return result.rowCount ?? 0
}
