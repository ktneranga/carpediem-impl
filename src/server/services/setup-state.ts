import { sql } from 'drizzle-orm'
import { db } from '@/server/db'

// NOTE: no `import 'server-only'` — src/proxy.ts imports this, like
// session.service.ts. `db` carries its own guard.

/**
 * Has this installation been set up — does a restaurant exist?
 * (spec-first-run-setup.) Cached once true: a tenant is never deleted, so after
 * the first restaurant exists this costs nothing per request.
 */
let provisioned = false

export async function isProvisioned({ fresh = false }: { fresh?: boolean } = {}): Promise<boolean> {
  // `fresh`: ask the database even if cached — the /setup page does, so a
  // database emptied under a running server never loops /setup ↔ /login.
  if (provisioned && !fresh) return true
  const result = await db.execute(sql`select exists (select 1 from tenants) as yes`)
  provisioned = Boolean((result.rows[0] as { yes?: boolean } | undefined)?.yes)
  return provisioned
}

/** After setup creates the restaurant. */
export function markProvisioned(): void {
  provisioned = true
}
