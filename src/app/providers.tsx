'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PrinterAlertBanner } from '@/components/pos/printer-alert-banner'

export function Providers({
  children,
  signedIn = false,
}: {
  children: ReactNode
  /** Is there a live staff session? Anything that opens a socket waits for it. */
  signedIn?: boolean
}) {
  // Created inside useState, NOT at module scope.
  //
  // A module-level QueryClient is shared across every request on the server, so
  // one user's cached data can leak into another user's render. Per-component
  // instantiation gives each request its own cache.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Table status arrives by Socket.io, so aggressive polling is wasted
            // work — the socket is the freshness mechanism, not the cache timer.
            staleTime: 30_000,
            // A tablet in a restaurant gains and loses focus constantly. Refetching
            // on every focus change would mean near-continuous requests for data
            // the socket already keeps current.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      {/* Global on purpose (Story 5.2): a printer fails while someone is
          mid-order, and whichever screen they happen to be on should not decide
          whether they find out.

          Only once signed in, though — it opens the shared socket, and on
          /login the handshake is refused by design, which left a tablet at the
          PIN pad retrying for ever at a database query per attempt. */}
      {signedIn ? <PrinterAlertBanner /> : null}
      {children}
    </QueryClientProvider>
  )
}
