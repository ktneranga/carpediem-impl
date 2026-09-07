import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db'
import { staff, tenantConfig } from '@/server/db/schema'
import { TableGrid } from '@/components/pos/table-grid'

/**
 * The waiter's landing screen.
 *
 * Reaching this page means the proxy already validated a session — it is not a
 * public route, so an unauthenticated request never gets here (Story 2.3).
 *
 * Identity comes from the x-staff-id header the proxy sets, never from the
 * cookie. Story 2.3 AC-7 requires attribution to derive from the header alone.
 */
export default async function Home() {
  const headersList = await headers()
  const staffId = headersList.get('x-staff-id')

  const [staffRow] = staffId
    ? await db.select({ name: staff.name }).from(staff).where(eq(staff.id, staffId)).limit(1)
    : []

  const [config] = await db
    .select({ restaurantName: tenantConfig.restaurantName })
    .from(tenantConfig)
    .limit(1)

  return (
    <TableGrid
      restaurantName={config?.restaurantName ?? 'Restaurant'}
      staffName={staffRow?.name ?? 'Unknown'}
    />
  )
}
