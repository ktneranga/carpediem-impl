/**
 * The Manage sections (Story 10.0, AC 5). Each page is a placeholder until its
 * own story replaces it. `waiter: true` marks the ones a waiter may open (Story
 * 8.3) — the nav shows a waiter only those; `ROUTE_ROLES` is what enforces it.
 */
export const MANAGE_SECTIONS = [
  {
    href: '/manage/dashboard',
    title: 'Dashboard',
    story: '9.1',
    what: "Takings by day, week or month, the cash check, what needs attention, and the end-of-day slip.",
  },
  {
    href: '/manage/menu',
    title: 'Menu',
    story: '10.4',
    what: 'Add, edit and price dishes and drinks, their options, and where each one prints.',
  },
  {
    href: '/manage/floor',
    title: 'Floor',
    story: '10.3',
    what: 'Add, rename, reorder and remove the zones and their tables.',
  },
  {
    href: '/manage/sold-out',
    title: 'Availability',
    story: '8.3',
    what: "Switch dishes and options off when they can't be served, and back on. Waiters can do this too, without the password.",
    waiter: true,
  },
  {
    href: '/manage/staff',
    title: 'Staff',
    story: '10.2',
    what: 'Add staff, set their jobs and PINs, and deactivate someone who has left.',
  },
  {
    href: '/manage/orders',
    title: 'Orders',
    story: '7.7',
    what: 'Every order of a day — table, waiter, total, how it ended — and the whole story of each.',
  },
  {
    href: '/manage/audit',
    title: 'Audit',
    story: '7.6',
    what: 'Who did what and when, and the whole story of any order.',
  },
  {
    href: '/manage/settings',
    title: 'Settings',
    story: 'settings',
    what: 'What the bill prints (name, header, footer, logo, review QR), service charge, tax and the business day.',
  },
] as const

export function ComingSoon({ href }: { href: (typeof MANAGE_SECTIONS)[number]['href'] }) {
  const section = MANAGE_SECTIONS.find((s) => s.href === href)!
  return (
    <section className="max-w-2xl rounded-panel bg-white p-sp-6 night:bg-night-card">
      <h1 className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">{section.title}</h1>
      <p className="mt-sp-2 text-fs-16 text-slate-600 night:text-night-second">{section.what}</p>
      <p className="mt-sp-4 text-fs-14 font-semibold text-slate-600 night:text-night-second">Coming with Story {section.story}.</p>
    </section>
  )
}
