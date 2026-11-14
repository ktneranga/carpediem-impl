import { cookies } from 'next/headers'
import { validateVendorSession, VENDOR_COOKIE_NAME, vendorConfigured } from '@/server/services/vendor.service'
import { VendorPanel } from './vendor-panel'

/**
 * `/vendor` (spec-11-1-vendor-access-export): the developer's way in, outside
 * the staff PIN login. Public in the proxy; the password is the credential.
 */
export const dynamic = 'force-dynamic'

export default async function VendorPage() {
  const configured = vendorConfigured()
  const session = configured
    ? await validateVendorSession((await cookies()).get(VENDOR_COOKIE_NAME)?.value).catch(() => null)
    : null

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-sp-4 night:bg-night-app">
      <section className="flex w-full max-w-sm flex-col gap-sp-4 rounded-panel bg-white p-sp-6 night:bg-night-card">
        <h1 className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">Vendor access</h1>
        {configured ? (
          <VendorPanel signedIn={!!session} />
        ) : (
          <p className="text-fs-14 text-slate-600 night:text-night-second">
            Vendor access is off on this installation. Set VENDOR_SECRET (16 characters or more) in .env and
            restart.
          </p>
        )}
      </section>
    </main>
  )
}
