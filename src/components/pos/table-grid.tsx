'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ContextHeader } from '@/components/pos/context-header'
import { TableCard } from '@/components/pos/table-card'
import { ZoneChipBar, type Zone } from '@/components/pos/zone-chip-bar'
import { useSocketEvent, useSocketStatus } from '@/hooks/use-socket'
import { signOut } from '@/lib/auth-client'
import { elapsedMinutesFrom, useMinuteTick } from '@/hooks/use-minute-tick'
import type { TableGridRow } from '@/app/api/tables/route'

const TABLES_QUERY_KEY = ['tables'] as const

type TableStatusChangedPayload = {
  tableId: string
  status: 'open' | 'occupied' | 'unavailable'
  sessionId: string | null
  openedAt: string | null
  itemCount: number
}

/** Thrown when the session is gone. Signing in again fixes it. */
class SessionExpiredError extends Error {}

/**
 * Thrown when the session is valid but the ROLE is not permitted.
 *
 * Distinct from SessionExpiredError on purpose. Both used to redirect to
 * /login, which meant a kitchen user tapping a table — allowed to see the grid,
 * refused the write — was bounced to the PIN pad, signed in successfully,
 * landed back on the grid, tapped again, and bounced again, forever. Re-
 * authenticating cannot change your role, so sending someone to the PIN pad to
 * fix a 403 is a loop by construction.
 */
class ForbiddenError extends Error {}

/** Thrown when another device opened this table first. An ordinary outcome. */
class TableTakenError extends Error {}

/** Thrown when the table is out of service. The card should already be inert. */
class TableNotAvailableError extends Error {}

async function openSession(tableId: string): Promise<{ sessionId: string }> {
  const response = await fetch(`/api/tables/${tableId}/sessions`, { method: 'POST' })

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')
  if (response.status === 409) throw new TableTakenError('Table already taken')
  if (response.status === 422) throw new TableNotAvailableError('Table not in service')

  const body = await response.json().catch(() => null)

  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? 'Could not open the table')
  }

  return body.data as { sessionId: string }
}

async function fetchTables(): Promise<TableGridRow[]> {
  const response = await fetch('/api/tables')

  // Read the body before deciding. The API and proxy both return structured
  // error codes (UNAUTHENTICATED, FORBIDDEN, NOT_PROVISIONED, INTERNAL_ERROR)
  // and throwing on `!response.ok` first discarded all four unread, so an
  // expired session told the waiter to check the network.
  //
  // 401 and 403 are split here too. Unreachable on this route today — every
  // role may read the grid — but conflating them is what produced the sign-out
  // loop on the write path, and the same mistake should not sit here waiting.
  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const body = await response.json().catch(() => null)

  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? 'Failed to load tables')
  }

  return body.data as TableGridRow[]
}

export function TableGrid({
  restaurantName,
  staffName,
}: {
  restaurantName: string
  staffName: string
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  // Carries a nonce so two identical messages are distinct state values — see
  // the auto-dismiss effect below.
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null)
  const [isNavigating, setIsNavigating] = useState(false)

  const showNotice = useCallback((text: string) => {
    setNotice({ id: Date.now(), text })
  }, [])

  const minuteTick = useMinuteTick()

  const { data: tables, isPending, isError, error } = useQuery({
    queryKey: TABLES_QUERY_KEY,
    queryFn: fetchTables,
    // Always refetch on mount, overriding the 30s staleTime for this query.
    //
    // The socket is a module singleton that survives unmount, so returning from
    // an order screen does NOT reconnect and the `connect` resync above never
    // fires — while the listener WAS removed on unmount, so every event during
    // that window is lost. Without this, a waiter back on the grid inside 30s
    // sees a cached floor plan that silently missed everything.
    refetchOnMount: 'always',
  })

  // A session that expired mid-service is not a network problem and the waiter
  // cannot act on it here. Send them to the PIN pad rather than showing an error
  // they can only respond to by reloading.
  useEffect(() => {
    if (error instanceof SessionExpiredError) window.location.assign('/login')
  }, [error])

  // Patch the single affected row rather than invalidating.
  //
  // AC-4 forbids refetching the whole list on a socket event. `invalidateQueries`
  // is the reflex here and it is wrong — it triggers a full GET /api/tables.
  useSocketEvent<TableStatusChangedPayload>('table:status_changed', (payload) => {
    queryClient.setQueryData<TableGridRow[]>(TABLES_QUERY_KEY, (current) => {
      if (!current) {
        // The listener is live before the first fetch resolves, so an event can
        // land on an empty cache. Returning `current` unchanged dropped it, and
        // the in-flight (pre-change) response then committed over the top — a
        // real lost update that left the card wrong until a reload. Invalidate
        // so the fetch that is about to land is refetched with the new state.
        void queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
        return current
      }

      const index = current.findIndex((t) => t.id === payload.tableId)
      if (index === -1) {
        // A table this client has never seen — added by another device. A single
        // invalidation is the only way to learn about it, and it is rare.
        void queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
        return current
      }

      const next = [...current]
      next[index] = {
        ...next[index],
        status: payload.status,
        sessionId: payload.sessionId,
        openedAt: payload.openedAt,
        itemCount: payload.itemCount,
      }
      return next
    })
  })

  // Resync on reconnect.
  //
  // Every event emitted while the socket was down is gone — Socket.io does not
  // replay them — and nothing else ever refetches: staleTime only MARKS data
  // stale, refetchOnWindowFocus is off, there is no refetchInterval, and
  // refetchOnReconnect fires on the browser `online` event, not on socket
  // recovery. So a server restart or a Wi-Fi roam left the grid silently wrong
  // for the rest of the session. One invalidation on reconnect closes it.
  useSocketEvent('connect', () => {
    void queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
  })

  const socketConnected = useSocketStatus()

  // useMutation, not a bare fetch: `isPending` is what stops a second tap on the
  // same card firing a second POST while the first is still in flight.
  const openTable = useMutation({
    mutationFn: openSession,
    onSuccess: (_data, tableId) => {
      // Navigation is tracked so the in-flight guard stays armed across it.
      // isPending clears the instant onSuccess runs, but router.push then starts
      // an async RSC round trip during which the grid is still mounted and fully
      // tappable — long enough to open a second session on a different table
      // that nobody is being seated at.
      setIsNavigating(true)
      router.push(`/tables/${tableId}`)
    },
    onError: (error) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }

      // A 403 is NOT a reason to sign out. The session is fine; the role is not
      // permitted, and no amount of re-authenticating changes that.
      if (error instanceof ForbiddenError) {
        showNotice('Your role cannot open tables.')
        setSelectedTableId(null)
        return
      }

      // A 409 is ordinary restaurant life, not an error condition — someone else
      // reached the table first. Correct the grid and stay on it; a full-screen
      // error here would take away the rest of the floor plan mid-service.
      if (error instanceof TableTakenError) {
        showNotice('That table was just opened by someone else.')
      } else if (error instanceof TableNotAvailableError) {
        showNotice('That table is out of service.')
      } else {
        showNotice('Could not open the table. Try again.')
      }

      setSelectedTableId(null)
      void queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
    },
  })

  // Clear the notice once the grid changes underneath it — by then the card has
  // corrected itself and the message is describing something no longer on screen.
  //
  // Keyed on the nonce, not the text. Setting the same string twice is a React
  // state bail-out: the effect would not re-run, no fresh timer would start, and
  // the second banner would be cleared by the first one's timer — sometimes
  // within a fraction of a second. All three messages are fixed literals, so
  // repeats are the common case, not the rare one.
  const noticeId = notice?.id
  useEffect(() => {
    if (noticeId === undefined) return
    const timer = setTimeout(() => setNotice(null), 4_000)
    return () => clearTimeout(timer)
  }, [noticeId])

  // Shared with the order screen — see src/lib/auth-client.ts. Duplicating it
  // once already left that screen with a "Switch user" button that did nothing.

  // Zones carry their own open count — the number a waiter is actually scanning
  // the filter for. Derived here rather than fetched: the grid already holds
  // every table, and a second request would go stale against the socket feed.
  const zones: Zone[] = useMemo(() => {
    if (!tables) return []
    const seen = new Map<string, Zone>()
    for (const table of tables) {
      const entry = seen.get(table.zoneId) ?? { id: table.zoneId, name: table.zoneName, openCount: 0 }
      if (table.status === 'open') entry.openCount += 1
      seen.set(table.zoneId, entry)
    }
    return Array.from(seen.values())
  }, [tables])

  const totalOpenCount = useMemo(
    () => (tables ? tables.filter((table) => table.status === 'open').length : 0),
    [tables],
  )

  // Client-side filter. AC-2 forbids a network request on zone change.
  const visibleTables = useMemo(() => {
    if (!tables) return []
    return activeZoneId ? tables.filter((t) => t.zoneId === activeZoneId) : tables
  }, [tables, activeZoneId])

  const activeZoneName = zones.find((z) => z.id === activeZoneId)?.name ?? null
  const selectedTable = tables?.find((t) => t.id === selectedTableId) ?? null

  return (
    <div className="min-h-screen">
      <ContextHeader
        restaurantName={restaurantName}
        staffName={staffName}
        zoneName={activeZoneName}
        tableLabel={selectedTable?.label ?? null}
        onNavigate={(level) => {
          if (level === 'zones') {
            setActiveZoneId(null)
            setSelectedTableId(null)
          } else {
            setSelectedTableId(null)
          }
        }}
        // Sign-out was unreachable from the entire application: the placeholder
        // page carried the only LogoutButton and TableGrid replaced it, leaving
        // POST /api/auth/logout with no caller. On a shared tablet that means a
        // waiter cannot end a shift and the next person inherits their
        // x-staff-id, so every order is misattributed.
        //
        // Story 2.4 re-points this at the PIN-switch flow; until then the
        // header's staff control signs out, which also stops it being a 44px
        // button that announces "Switch user" and does nothing.
        onStaffTap={signOut}
      />

      <main className="flex flex-col gap-sp-4 p-sp-4">
        {/* Real-time is the only thing keeping this grid true. When it drops, a
            waiter must know the colours may be stale rather than trusting them —
            silence here is worse than an outage they can see. */}
        {!socketConnected ? (
          <p
            role="status"
            className="rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
          >
            Live updates disconnected — table status may be out of date.
          </p>
        ) : null}

        {/* Non-blocking: the floor plan stays visible and usable underneath.
            Losing a table to another waiter is a fact to report, not a failure
            to recover from. */}
        {notice ? (
          <p
            role="status"
            className="rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
          >
            {notice.text}
          </p>
        ) : null}

        <ZoneChipBar
          zones={zones}
          activeZoneId={activeZoneId}
          totalOpenCount={totalOpenCount}
          onZoneChange={(id) => {
            setActiveZoneId(id)
            setSelectedTableId(null)
          }}
        />

        {isPending ? (
          <p className="text-fs-16 text-slate-600">Loading tables…</p>
        ) : isError && !tables ? (
          // `isError && !tables`, not `isError` alone. In TanStack Query v5 the
          // status flips to 'error' even when cached data is still present, so
          // checking isError first replaced a whole populated floor plan with one
          // red sentence the moment any background refetch failed. Keep showing
          // the grid we have; the degraded banner above says it may be stale.
          <p role="alert" className="text-fs-16 font-semibold text-unavailable-ink">
            Cannot reach the restaurant server. Check the tablet is on the restaurant network.
          </p>
        ) : visibleTables.length === 0 ? (
          // Two distinct states. Telling a waiter to "pick another zone" when the
          // restaurant has no tables at all instructs a recovery the screen makes
          // impossible — there is no other zone, because the chip bar is derived
          // from the tables that do not exist.
          <p className="text-fs-16 text-slate-600">
            {activeZoneId
              ? 'No tables in this zone. Pick another zone above.'
              : 'No tables are set up yet. Add zones and tables in settings, or run the seed.'}
          </p>
        ) : (
          // The table grid is 5 columns with 12px gaps on tablet landscape, and
          // steps down on anything narrower. A wrapping flex row gave ragged
          // trailing rows, which reads as a list rather than a floor plan.
          <div className="grid grid-cols-2 gap-sp-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visibleTables.map((table) => (
              <TableCard
                key={table.id}
                label={table.label}
                zoneName={table.zoneName}
                status={table.status}
                capacity={table.capacity}
                elapsedMinutes={elapsedMinutesFrom(table.openedAt, minuteTick)}
                itemCount={table.sessionId ? table.itemCount : undefined}
                selected={table.id === selectedTableId}
                onSelect={() => {
                  // AC-6: an unavailable table is inert. Guarded here rather than
                  // only greyed — a card that looks disabled but still fires is
                  // worse than one with no styling at all. TableCard enforces
                  // this too; this is the guard that stops the request.
                  if (table.status === 'unavailable') return

                  // An occupied table already has a session — walk into it
                  // rather than trying to open a second one, which the database
                  // would reject anyway. Checked BEFORE the busy guard: this
                  // path issues no request, and blocking it while an unrelated
                  // POST was in flight made the tablet look frozen rather than
                  // busy.
                  if (table.status === 'occupied') {
                    setSelectedTableId(table.id)
                    setIsNavigating(true)
                    router.push(`/tables/${table.id}`)
                    return
                  }

                  // One request at a time. Without this, an impatient double-tap
                  // during service fires two POSTs and the second 409s against
                  // the session the first just created.
                  //
                  // isNavigating is part of the guard because isPending clears
                  // the moment onSuccess runs, leaving the grid interactive for
                  // the whole router.push round trip — long enough to open a
                  // second session on a table nobody is being seated at.
                  if (openTable.isPending || isNavigating) return

                  // Set before the push so the breadcrumb is correct during the
                  // transition. Deliberately NOT an optimistic cache patch — a
                  // 409 would have to unwind it, and the socket event delivers
                  // the true state within milliseconds of the commit anyway.
                  setSelectedTableId(table.id)
                  openTable.mutate(table.id)
                }}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
