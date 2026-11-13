import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db'
import { staff } from '@/server/db/schema'
import { getManagePasswordState } from '@/server/services/manage-password.service'
import { safeManagePath } from '@/lib/return-to'
import { UnlockForm } from './unlock-form'

/**
 * The Manage unlock screen (Story 10.0, AC 2, 3, 4). Outside the area layout,
 * and exempt from the proxy's Manage gate — it is how you get in. The proxy's
 * role check still makes it owner-only.
 */
export default async function ManageUnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const staffId = (await headers()).get('x-staff-id')
  const [owner] = staffId
    ? await db.select({ tenantId: staff.tenantId }).from(staff).where(eq(staff.id, staffId)).limit(1)
    : []
  const state = owner
    ? await getManagePasswordState(owner.tenantId)
    : { isSet: true, lockedForSeconds: 0 }

  const rawNext = (await searchParams).next
  const next = safeManagePath(Array.isArray(rawNext) ? rawNext[0] : rawNext)

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-sp-4 py-sp-6">
      <UnlockForm mode={state.isSet ? 'unlock' : 'set'} next={next} lockedForSeconds={state.lockedForSeconds} />
    </main>
  )
}
