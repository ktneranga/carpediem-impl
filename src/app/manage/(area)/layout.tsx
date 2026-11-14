import { headers } from 'next/headers'
import { installationTenant, lastVendorAccess, vendorWhen } from '@/server/services/vendor.service'
import { ManageNav } from './manage-nav'

/**
 * The Manage area (Story 10.0, AC 5). Reached only through the proxy's Manage
 * gate — except Sold out, which owner and waiters open without the password
 * (Story 8.3). Laptop-first: sections on the left from `md:`, a top row below
 * it. Light theme; 44px targets kept, it is used on tablets too.
 *
 * The role comes from the proxy's `x-staff-role` header (set from the
 * validated session only); the nav shows a waiter just the sections they may
 * open, and the owner the rest of Manage only once it is unlocked — on
 * Availability without the password they see "Open Manage" instead. The proxy
 * still decides access — this only hides links.
 */
export default async function ManageAreaLayout({ children }: { children: React.ReactNode }) {
  const list = await headers()
  const owner = list.get('x-staff-role') === 'owner'
  // The proxy sets this only after checking the Manage session itself.
  const unlocked = owner && list.get('x-manage-unlocked') === '1'
  // The owner sees when the vendor last signed in or exported the database
  // (spec-11-1-vendor-access-export). A failed read hides the line, never the page.
  // Formatted HERE, in the restaurant's zone, so every device shows the same
  // time as the export's file name.
  let vendorLastUsed: string | undefined
  if (unlocked) {
    try {
      const tenant = await installationTenant()
      if (tenant) {
        const last = await lastVendorAccess(tenant.id)
        vendorLastUsed = !last.signIn && !last.export
          ? 'never'
          : [
              last.signIn ? `signed in ${vendorWhen(last.signIn, tenant.timeZone)}` : null,
              last.export ? `last export ${vendorWhen(last.export, tenant.timeZone)}` : null,
            ].filter(Boolean).join(' · ')
      }
    } catch (error) {
      console.error('[manage] Could not read vendor access:', error)
    }
  }
  return (
    <div className="flex min-h-screen flex-col bg-slate-100 night:bg-night-app md:flex-row">
      <ManageNav owner={owner} unlocked={unlocked} vendorLastUsed={vendorLastUsed} />
      <main className="min-w-0 flex-1 p-sp-4 md:p-sp-6">{children}</main>
    </div>
  )
}
