import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { MANAGE_AREAS, parsePermissionsHeader } from '@/server/auth/permissions'

/**
 * `/manage` opens on the first section. Only the owner reaches it — the proxy
 * sends a waiter to `/` — but a waiter is sent to Sold out all the same, in
 * case that rule ever loosens (Story 8.3).
 */
export default async function ManageHome() {
  const list = await headers()
  const role = list.get('x-staff-role')
  if (role === 'owner') redirect('/manage/dashboard')
  // Someone granted Manage areas (Story 10.6): their first one.
  const permissions = parsePermissionsHeader(list.get('x-staff-permissions'))
  const first = MANAGE_AREAS.find((area) => permissions.includes(area.permission))
  redirect(first ? first.href : '/manage/sold-out')
}
