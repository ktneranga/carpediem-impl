import { redirect } from 'next/navigation'

/** End of day moved into the Dashboard (2026-11-14); old links land on the same day there. */
export default async function ManageEndOfDayPage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const { date } = await searchParams
  redirect(typeof date === 'string' ? `/manage/dashboard?date=${encodeURIComponent(date)}` : '/manage/dashboard')
}
