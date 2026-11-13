import type { Metadata } from 'next'
import { headers } from 'next/headers'
import '@fontsource-variable/inter'
import './globals.css'
import { THEME_SCRIPT } from '@/components/theme/theme-script'
import { ThemeRoot } from '@/components/theme/theme-switch'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'Carpe Diem RMS',
  description: 'Restaurant management system for Carpe Diem Restaurant',
}

const STAFF_CONTEXTS = ['waiter', 'owner', 'kitchen'] as const
type StaffContext = (typeof STAFF_CONTEXTS)[number]

/**
 * Runtime whitelist, not a cast.
 *
 * The previous `as 'waiter' | 'owner' | 'kitchen' | null` was erased at compile
 * time, so any unexpected header value was written straight into `data-context`.
 * (Closes a deferred item from Story 1.2's code review.)
 */
function toStaffContext(value: string | null): StaffContext | null {
  return STAFF_CONTEXTS.includes(value as StaffContext) ? (value as StaffContext) : null
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const headersList = await headers()
  const role = toStaffContext(headersList.get('x-staff-role'))

  return (
    <html
      lang="en"
      {...(role ? { 'data-context': role } : {})}
      className="antialiased"
      // THEME_SCRIPT may set data-theme before React hydrates: expected, not a mismatch.
      suppressHydrationWarning
    >
      <head>
        {/* Light / dark before the first paint, so a dark device never flashes white (Teran, 2026-11-13). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      {/* Providers is the only client boundary here — this layout stays a Server
          Component so it can keep reading headers() for data-context. */}
      <body className="min-h-full">
        {/* `signedIn` gates everything in Providers that opens a socket. The
            printer banner was mounted unconditionally and so reached /login,
            where the handshake is refused by design — leaving every idle
            tablet at the PIN pad in a permanent retry loop, one database
            query per attempt. The proxy sets this header only for a live
            session, which is the same fact the socket authenticates on. */}
        <ThemeRoot />
        <Providers signedIn={role !== null}>{children}</Providers>
      </body>
    </html>
  )
}
