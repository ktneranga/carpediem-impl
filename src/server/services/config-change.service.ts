import 'server-only'
import { db } from '@/server/db'
import { configChanges } from '@/server/db/schema'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Appends one configuration change to `config_changes` (Story 10.4, FR71).
 *
 * The ONLY writer of that table, called inside the same transaction as the
 * change itself, so a change and its log row commit or roll back together.
 * Nothing reads the log yet; the cloud sync (Epic 13) will. `payload` is the
 * row after the change, as the service returned it (camelCase).
 */
export async function recordConfigChange(
  tx: Tx,
  {
    tenantId,
    tableName,
    rowId,
    version,
    payload,
    staffId,
  }: { tenantId: string; tableName: string; rowId: string; version: number; payload: object; staffId: string },
): Promise<void> {
  await tx.insert(configChanges).values({ tenantId, tableName, rowId, version, payload, staffId, origin: 'local' })
}
