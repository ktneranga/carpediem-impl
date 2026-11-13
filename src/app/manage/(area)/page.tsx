import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

/**
 * `/manage` opens on the first section. Only the owner reaches it — the proxy
 * sends a waiter to `/` — but a waiter is sent to Sold out all the same, in
 * case that rule ever loosens (Story 8.3).
 */
export default async function ManageHome() {
  const role = (await headers()).get('x-staff-role')
  redirect(role === 'owner' ? '/manage/dashboard' : '/manage/sold-out')
}
