import { headers } from 'next/headers'
import { StaffEditor } from '@/components/manage/staff-editor'

/** Manage → Staff (Story 10.2). Behind the Manage gate (Story 10.0). The signed-in owner's row says "You". */
export default async function ManageStaffPage() {
  const meId = (await headers()).get('x-staff-id')
  return <StaffEditor meId={meId} />
}
