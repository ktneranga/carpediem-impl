import { redirect } from 'next/navigation'

/** `/manage` opens on the first section. */
export default function ManageHome() {
  redirect('/manage/menu')
}
