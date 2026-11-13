import { ManageNav } from './manage-nav'

/**
 * The Manage area (Story 10.0, AC 5). Reached only through the proxy's Manage
 * gate. Laptop-first: sections on the left from `md:`, a top row below it.
 * Light theme; 44px targets kept, it is used on tablets too.
 */
export default function ManageAreaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-slate-100 md:flex-row">
      <ManageNav />
      <main className="min-w-0 flex-1 p-sp-4 md:p-sp-6">{children}</main>
    </div>
  )
}
