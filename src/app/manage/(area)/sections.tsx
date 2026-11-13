/**
 * The Manage sections (Story 10.0, AC 5). Each page is a placeholder until its
 * own story replaces it.
 */
export const MANAGE_SECTIONS = [
  {
    href: '/manage/menu',
    title: 'Menu',
    story: '10.4',
    what: 'Add, edit and price dishes and drinks, their options, and where each one prints.',
  },
  {
    href: '/manage/sold-out',
    title: 'Sold out',
    story: '8.3',
    what: "Today's dishes with a toggle each, to mark one sold out mid-service.",
  },
  {
    href: '/manage/staff',
    title: 'Staff',
    story: '10.2',
    what: 'Add staff, set their PINs and roles, and deactivate someone who has left.',
  },
  {
    href: '/manage/end-of-day',
    title: 'End of day',
    story: '9.5',
    what: "The day's takings by payment method, and what the cash drawer should hold.",
  },
] as const

export function ComingSoon({ href }: { href: (typeof MANAGE_SECTIONS)[number]['href'] }) {
  const section = MANAGE_SECTIONS.find((s) => s.href === href)!
  return (
    <section className="max-w-2xl rounded-panel bg-white p-sp-6">
      <h1 className="text-fs-24 font-extrabold text-slate-900">{section.title}</h1>
      <p className="mt-sp-2 text-fs-16 text-slate-600">{section.what}</p>
      <p className="mt-sp-4 text-fs-14 font-semibold text-slate-600">Coming with Story {section.story}.</p>
    </section>
  )
}
