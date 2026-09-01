import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db'
import { staff } from '@/server/db/schema'
import { LogoutButton } from '@/components/pos/logout-button'

/**
 * PLACEHOLDER home screen.
 *
 * Epic 3 replaces this with the zone/table grid a waiter actually lands on.
 * Kept deliberately small so replacing it is trivial. Its only job today is to
 * prove that proxy.ts injected a verified identity.
 *
 * Reaching this page at all means the proxy validated a session — it is not
 * public, so an unauthenticated request never gets here.
 */
export default async function Home() {
  const headersList = await headers()
  const staffId = headersList.get('x-staff-id')
  const role = headersList.get('x-staff-role')

  let staffName: string | null = null
  if (staffId) {
    const [row] = await db
      .select({ name: staff.name })
      .from(staff)
      .where(eq(staff.id, staffId))
      .limit(1)
    staffName = row?.name ?? null
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-space-8 p-space-6">
      <div className="flex flex-col items-center gap-space-2">
        <p className="text-small text-neutral-600">Signed in as</p>
        <h1 className="text-display font-semibold text-neutral-900">{staffName ?? 'Unknown'}</h1>
        <span className="rounded-full bg-brand-100 px-space-4 py-space-1 text-small font-medium text-brand-700">
          {role ?? 'no role'}
        </span>
      </div>

      <LogoutButton />

      <p className="max-w-sm text-center text-micro text-neutral-600">
        Placeholder screen. The zone and table grid arrives in Epic 3.
      </p>
    </main>
  )
}
