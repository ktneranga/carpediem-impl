import { Dashboard } from '@/components/manage/dashboard'

/** Manage → Dashboard (Story 9.1; End of day merged in 2026-11-14). Behind the Manage gate (Story 10.0). Opens first. `?date=YYYY-MM-DD` opens one day. */
export default async function ManageDashboardPage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const { date } = await searchParams
  return <Dashboard initialDate={typeof date === 'string' ? date : null} />
}
