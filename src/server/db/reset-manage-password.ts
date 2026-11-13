/**
 * `pnpm manage:reset-password` — for an owner locked out of their own
 * restaurant (Story 10.0, AC 9).
 *
 * Clears the Manage password and the lockout and ends every Manage session, so
 * the next owner entry sets a new password. Refuses nothing: whoever can run a
 * command on the server already has the restaurant.
 *
 * Owns its pool, like seed.ts and sweep-sessions.ts: `@/server/db` carries
 * `server-only`, which throws outside Next.
 */
import { Pool } from 'pg'

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('[manage] DATABASE_URL is not set')

  const pool = new Pool({ connectionString, max: 1 })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tenants = await client.query(
      `UPDATE tenants
          SET manage_password_hash = NULL,
              manage_failed_attempts = 0,
              manage_locked_until = NULL`,
    )
    const sessions = await client.query('DELETE FROM manage_sessions')
    await client.query('COMMIT')
    console.log(
      `[manage] Password cleared (${tenants.rowCount ?? 0} restaurant), ` +
        `${sessions.rowCount ?? 0} Manage session(s) ended. The next owner entry sets a new one.`,
    )
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error('[manage] Reset failed:', error)
  process.exit(1)
})
