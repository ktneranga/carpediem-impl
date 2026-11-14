import { redirect } from 'next/navigation'
import { isProvisioned } from '@/server/services/setup-state'
import { SetupForm } from './setup-form'

/**
 * `/setup` (spec-first-run-setup): the one-time screen on an empty install.
 * Once a restaurant exists it only sends you to sign in.
 */
export const dynamic = 'force-dynamic'

export default async function SetupPage() {
  let provisioned: boolean
  try {
    provisioned = await isProvisioned({ fresh: true })
  } catch (error) {
    console.error('[setup] Could not check the install:', error)
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-100 p-sp-4 night:bg-night-app">
        <p role="alert" className="max-w-md rounded-panel bg-white p-sp-6 text-fs-16 font-semibold text-red-700 night:bg-night-card night:text-red-400">
          The database is not reachable. Check that the database container is running, then reload this page.
        </p>
      </main>
    )
  }
  if (provisioned) redirect('/login')
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-sp-4 night:bg-night-app">
      <section className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-6 night:bg-night-card">
        <div>
          <h1 className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">Set up the restaurant</h1>
          <p className="mt-sp-1 text-fs-14 text-slate-600 night:text-night-second">
            Once, on a new install. The menu, tables and staff are added in Manage afterwards.
          </p>
        </div>
        <SetupForm />
      </section>
    </main>
  )
}
