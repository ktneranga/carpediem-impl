'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

export function Providers({ children }: { children: ReactNode }) {
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

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
