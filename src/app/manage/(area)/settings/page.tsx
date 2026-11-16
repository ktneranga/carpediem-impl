import { headers } from 'next/headers'
import { SettingsEditor } from '@/components/manage/settings-editor'

/** Manage → Settings (spec-restaurant-settings). Behind both Manage gates. */
export default async function ManageSettingsPage() {
  // The owner password card is the owner's alone, not for staff granted Settings.
  const owner = (await headers()).get('x-staff-role') === 'owner'
  return <SettingsEditor isOwner={owner} />
}
