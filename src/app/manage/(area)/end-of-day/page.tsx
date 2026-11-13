import { EndOfDay } from '@/components/manage/end-of-day'

/** Manage → End of day (Story 9.5). Behind the Manage gate (Story 10.0). `?date=YYYY-MM-DD`, default today. */
export default async function ManageEndOfDayPage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const { date } = await searchParams
  return <EndOfDay initialDate={typeof date === 'string' ? date : null} />
}
