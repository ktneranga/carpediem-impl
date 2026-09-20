'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ContextHeader } from '@/components/pos/context-header'
import { TableCard } from '@/components/pos/table-card'
import { ZoneChipBar, type Zone } from '@/components/pos/zone-chip-bar'
import { FloorActionStrip } from '@/components/pos/floor-action-strip'
import { useSocketEvent, useSocketStatus } from '@/hooks/use-socket'
import { signOut } from '@/lib/auth-client'
import { elapsedMinutesFrom, useMinuteTick } from '@/hooks/use-minute-tick'
import { clockTime, elapsed, mergedTitle } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { TableGridRow } from '@/app/api/tables/route'
import type { StaffRole } from '@/server/auth/permissions'

const TABLES_QUERY_KEY = ['tables'] as const
/**
 * The open counter sales list. Exported so the order screen can refresh it after
 * a send — a second hand-typed copy of this array is how a refresh silently
 * targets a key that does not exist (it happened while wiring Story 4.5).
 */
export const COUNTER_QUERY_KEY = ['counter-sessions'] as const

/** An open counter sale — an order attached to no table (FR64). */
export type CounterSession = {
  sessionId: string
  openedAt: string
  itemCount: number
  openedByName: string
  /**
   * Its IDENTITY — position within today's counter sales, closed ones included.
   *
   * Assigned by the server from the full day's history so it is fixed when the
   * sale is created and never moves. Numbering the OPEN sales instead would
   * rename every later one each time an earlier one closed.
   */
  sequence: number
}

type TableStatusChangedPayload = {
  tableId: string
  status: 'open' | 'occupied' | 'unavailable'
  sessionId: string | null
  openedAt: string | null
  itemCount: number
  unavailableReason: string | null
  /** Every table on this session, in label order. Empty when there is none. */
  groupTableLabels: string[]
}

/**
 * One card on the grid: a single table, or a whole merged group.
 *
 * Story 3.8's amended AC-6. A party sitting at two tables is ONE party with one
 * order and one bill, so the floor screen shows it as one card. The alternative
 * that was built first — two ordinary occupied cards, each carrying a badge
 * explaining that the other one is the same order — put two identical timers and
 * two identical item counts side by side, which reads as two parties who sat
 * down in the same second. Collapsing removes the ambiguity instead of
 * annotating it.
 *
 * Purely a rendering concept. Nothing about it reaches the server: `sessionId`
 * and `groupTableLabels` are already on every row.
 */
type GridUnit = {
  /** Stable identity: the session id for a group, the table id for a single. */
  key: string
  /** Members, ordered by label. One entry for a single table. */
  tables: TableGridRow[]
  /** The row every action and every navigation goes through. */
  primary: TableGridRow
  isGroup: boolean
  /** SUMMED across a group — the number needed to place a party of seven. */
  capacity: number | null
  labels: string[]
}

function buildUnit(key: string, tables: TableGridRow[]): GridUnit {
  // `numeric` matters: without it "Table 10" sorts before "Table 2", and the
  // group title would name the tables in an order that matches nothing on the
  // floor.
  const ordered = [...tables].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }),
  )

  // Null only when NO member has a capacity. One table missing its seat count
  // should not erase the seats we do know about.
  const capacity = ordered.reduce<number | null>(
    (total, table) => (table.capacity == null ? total : (total ?? 0) + table.capacity),
    null,
  )

  return {
    key,
    tables: ordered,
    primary: ordered[0],
    // The SERVER's count, not the number of rows assembled here. If a member row
    // were ever missing from the filtered list the card must still say it is a
    // group rather than quietly presenting a party's second table as a single.
    isGroup: ordered[0].groupTableLabels.length > 1,
    capacity,
    labels: ordered.map((table) => table.label),
  }
}

/**
 * Collapses merged sessions into single units, preserving grid position.
 *
 * Safe over the ZONE-FILTERED list because a merge cannot span zones (AC-3), so
 * a group is never split across the filter. A group takes the position of its
 * first member, so collapsing shuffles nothing else in the zone.
 */
function toGridUnits(rows: TableGridRow[]): GridUnit[] {
  const units: GridUnit[] = []
  const groupAt = new Map<string, number>()

  for (const row of rows) {
    // Both conditions. `groupTableLabels` is empty when there is no session at
    // all, and length 1 is an ordinary unmerged sitting.
    if (!row.sessionId || row.groupTableLabels.length <= 1) {
      units.push(buildUnit(row.id, [row]))
      continue
    }

    const index = groupAt.get(row.sessionId)
    if (index === undefined) {
      groupAt.set(row.sessionId, units.length)
      units.push(buildUnit(row.sessionId, [row]))
    } else {
      units[index] = buildUnit(row.sessionId, [...units[index].tables, row])
    }
  }

  return units
}

/**
 * The non-blocking message bar above the grid.
 *
 * `action` is what makes it a recovery rather than an announcement, and `ttlMs`
 * is per-notice because an undo needs longer on screen than a warning does.
 */
type Notice = {
  id: number
  text: string
  ttlMs: number
  action?: { label: string; run: () => void }
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

/**
 * Thrown when the table is out of service.
 *
 * The card is NOT inert — Story 3.7 made every card selectable, including
 * unavailable ones, because selecting one is the only way an owner reaches
 * "Return to service". Reachable whenever the floor moved underneath the waiter
 * between render and tap.
 */
class TableNotAvailableError extends Error {}

async function openSession(input: {
  tableId: string
  /** Story 3.8 — seating one party across several tables in the same zone. */
  additionalTableIds?: string[]
}): Promise<{ sessionId: string }> {
  const response = await fetch(`/api/tables/${input.tableId}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ additionalTableIds: input.additionalTableIds ?? [] }),
  })

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

/**
 * Takes a table out of service, or returns it.
 *
 * Two URLs, deliberately. `/api/config` is owner-only via existing policy, which
 * is how "anyone can take out, only an owner restores" is enforced without a
 * single line of new permission code.
 */
async function setAvailability(input:
  | { tableId: string; direction: 'out'; reason: string }
  | { tableId: string; direction: 'in' }): Promise<void> {
  const response =
    input.direction === 'out'
      ? await fetch(`/api/tables/${input.tableId}/out-of-service`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: input.reason }),
        })
      : await fetch(`/api/config/tables/${input.tableId}/return-to-service`, { method: 'POST' })

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) {
    // Direction-aware. One mutation serves both endpoints, so a bare
    // ForbiddenError left onError guessing — and it guessed wrong, telling a
    // kitchen user who tried to take a table OUT that only an owner can return
    // one to service, which is a different rule for a different action.
    throw new ForbiddenError(
      input.direction === 'in'
        ? 'Only an owner can return a table to service.'
        : 'Your role cannot take tables out of service.',
    )
  }

  const body = await response.json().catch(() => null)

  if (response.status === 409) {
    // Read the body first. The server distinguishes three 409s with three
    // different instructions — TABLE_HAS_OPEN_SESSION in particular says "close
    // or settle the session first", which is the one the waiter needs. Throwing
    // on the status code alone discarded all of them for one generic sentence.
    throw new TableTakenError(body?.error?.message ?? 'That table changed before the update.')
  }

  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? 'Could not update the table')
  }
}

/** Reads the server's own wording out of an error response. */
async function throwFromResponse(response: Response, fallback: string): Promise<never> {
  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Your role cannot do that.')

  const body = await response.json().catch(() => null)

  // 409 and 422 both mean "the floor is not what you thought" and both carry a
  // specific, actionable message from the server.
  if (response.status === 409 || response.status === 422) {
    throw new TableTakenError(body?.error?.message ?? fallback)
  }
  throw new Error(body?.error?.message ?? fallback)
}

/**
 * Merges further tables into a session that is already open.
 *
 * `labels` rides along unused by the request — TanStack hands the variables back
 * to `onSuccess`, and the undo notice has to name the tables after the grid has
 * already been invalidated out from under the ids.
 */
async function mergeTables(input: {
  tableId: string
  tableIds: string[]
  labels: string[]
  /**
   * The session the anchor had when merge mode BEGAN, or null if it was free.
   *
   * Sent so the server can refuse if the anchor moved while the waiter staged —
   * see `mergeAnchor` in TableGrid.
   */
  expectedSessionId?: string | null
}): Promise<void> {
  const response = await fetch(`/api/tables/${input.tableId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tableIds: input.tableIds,
      expectedSessionId: input.expectedSessionId,
    }),
  })
  if (!response.ok) await throwFromResponse(response, 'Could not merge the tables')
}

/** Releases one table from a merged group. */
async function unmergeTable(tableId: string): Promise<void> {
  const response = await fetch(`/api/tables/${tableId}/unmerge`, { method: 'POST' })
  if (!response.ok) await throwFromResponse(response, 'Could not un-merge the table')
}

/**
 * Opens a counter sale and returns the session to navigate to.
 *
 * No table is involved, so this cannot be a 409 — see the route's note on why
 * counter sessions are deliberately unconstrained.
 */
async function startCounterSale(): Promise<{ sessionId: string }> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!response.ok) await throwFromResponse(response, 'Could not start the counter sale')
  const body = await response.json()
  return body.data as { sessionId: string }
}

/**
 * Attaches tables to an existing session — how a counter sale gets seated (AC-5).
 *
 * The order does not move; the TABLE joins it. Same session id, same items, same
 * bill, same audit trail.
 */
async function seatSession(input: { sessionId: string; tableIds: string[] }): Promise<void> {
  const response = await fetch(`/api/sessions/${input.sessionId}/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableIds: input.tableIds }),
  })
  if (!response.ok) await throwFromResponse(response, 'Could not seat the order')
}

/**
 * Open counter sales.
 *
 * Fetched rather than derived: a counter session appears on no table row, so
 * `/api/tables` cannot report it — and without this list a counter order the
 * waiter navigates away from is unreachable, un-closable and invisible, which is
 * the orphaned-session state Story 3.6 exists to eliminate.
 */
async function fetchCounterSessions(): Promise<CounterSession[]> {
  const response = await fetch('/api/sessions')

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? 'Failed to load counter orders')
  }
  return body.data as CounterSession[]
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
  role,
}: {
  restaurantName: string
  staffName: string
  /**
   * Read server-side from the validated session and passed down, never sniffed
   * from the `data-context` attribute on <html>. The attribute is for styling;
   * this decides which controls exist.
   */
  role: StaffRole | null
}) {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  // Carries a nonce so two identical messages are distinct state values — see
  // the auto-dismiss effect below.
  const [notice, setNotice] = useState<Notice | null>(null)
  const [isNavigating, setIsNavigating] = useState(false)
  /**
   * Tables staged for a merge; null when merge mode is off.
   *
   * Deliberately here rather than inside FloorActionStrip. The strip is keyed on
   * the selected table so its state is destroyed on every selection change —
   * that keying is what stopped the reason prompt retargeting in Story 3.7's
   * review. A merge set spans selections by definition, so it has to live above
   * the key.
   */
  const [mergeTableIds, setMergeTableIds] = useState<string[] | null>(null)

  /**
   * The anchor as it was when merge mode began — its id, and the session it had.
   *
   * Merge mode is built over several taps, and the anchor can be seated by
   * another device in between. Reading `selectedTable.status` at confirm time
   * meant the client silently switched strategy: an anchor that was free when
   * staging began but occupied by the time Done was tapped took the MERGE
   * branch and attached the staged tables to a stranger's order — two parties
   * on one bill, with the server unable to tell, because the request was
   * perfectly valid.
   *
   * Captured here, the branch is decided against what the waiter actually saw,
   * and `expectedSessionId` lets the server refuse the rest.
   */
  const [mergeAnchor, setMergeAnchor] = useState<{
    tableId: string
    sessionId: string | null
  } | null>(null)

  /**
   * The counter sale being seated, and the tables staged for it.
   *
   * Structurally merge mode with a counter session as the anchor. Kept separate
   * from `mergeTableIds` rather than overloaded: the two have different anchors
   * and different endpoints, and one flag meaning two things is how the merge
   * anchor bug happened in the first place.
   */
  const [seatingSessionId, setSeatingSessionId] = useState<string | null>(null)
  const [seatTableIds, setSeatTableIds] = useState<string[]>([])

  /**
   * Leaving every card-staging mode. All of it dies together, always.
   *
   * Story 3.8's review found merge mode surviving a zone change, leaving a strip
   * with no Cancel button while every tap still staged tables. Seating has the
   * same failure mode, so it is cleared by the same function rather than by a
   * parallel set of calls someone will forget to add the third time.
   */
  const endMergeMode = useCallback(() => {
    setMergeTableIds(null)
    setMergeAnchor(null)
  }, [])

  /**
   * Leaving seating mode. Deliberately NOT bundled with merge mode.
   *
   * Merge is anchored to a TABLE, so it cannot outlive a zone change — its
   * anchor leaves the filtered list and `selectedUnit` goes null. Seating is
   * anchored to a COUNTER SESSION, which sits in no zone at all, and finding the
   * table the guest moved to is precisely a matter of browsing zones. Clearing
   * it on every zone change made the flow work only from "All zones" — tap the
   * Tables pill mid-seating and the mode silently ended.
   */
  const endSeating = useCallback(() => {
    setSeatingSessionId(null)
    setSeatTableIds([])
  }, [])

  const showNotice = useCallback((text: string) => {
    setNotice({ id: Date.now(), text, ttlMs: 4_000 })
  }, [])

  /**
   * A notice that offers a way back.
   *
   * This is the confirmation, arriving after the fact instead of before it.
   * Merge and un-merge are reversible, and a dialog asking "are you sure?" on a
   * reversible action is the weakest error-prevention there is — staff merging
   * twenty times a shift stop reading it inside a week and tap through
   * reflexively, having paid a tap every single time. Undo costs nothing when
   * the action was right and recovers fully when it was not.
   *
   * Eight seconds rather than four: reading what happened, deciding it was wrong
   * and reaching the button is a slower sequence than noticing a warning.
   */
  const showUndoNotice = useCallback((text: string, run: () => void) => {
    setNotice({ id: Date.now(), text, ttlMs: 8_000, action: { label: 'Undo', run } })
  }, [])

  /**
   * Shared error handling for the table-action mutations.
   *
   * Every one of them can fail the same four ways, and the server already words
   * each case precisely — "Close or settle the session first", "That table
   * already has its own order". Surfacing `error.message` keeps the waiter's
   * instruction intact instead of flattening it to a generic sentence.
   */
  const handleTableActionError = useCallback(
    (error: unknown) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      if (error instanceof ForbiddenError || error instanceof TableTakenError) {
        showNotice(error.message)
        if (error instanceof TableTakenError) {
          void queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
        }
        return
      }
      // `throwFromResponse` is documented as "reads the server's own wording out
      // of an error response", but only Forbidden and TableTaken reached the
      // user — a 404 TABLE_NOT_FOUND ("One of the tables does not exist") was
      // parsed, carried all the way here, then flattened to the generic line.
      showNotice(
        error instanceof Error && error.message
          ? error.message
          : 'Could not update the table. Try again.',
      )
    },
    [queryClient, showNotice],
  )

  // Release the navigation latch if we are still mounted a moment later.
  //
  // `setIsNavigating(true)` used to have no counterpart anywhere. That was
  // survivable while it only blocked a second open-session tap, but it now feeds
  // `busy`, which disables every control in the action strip — so a router.push
  // that resolves WITHOUT unmounting this component (a kitchen user's /tables
  // redirect bouncing back to /) left the strip permanently dead with no notice
  // and no recovery but a page reload.
  //
  // On a successful navigation this component unmounts and the timer is cleaned
  // up before it fires, so the latch still does its job during the transition.
  useEffect(() => {
    if (!isNavigating) return
    const timer = setTimeout(() => setIsNavigating(false), 5_000)
    return () => clearTimeout(timer)
  }, [isNavigating])

  /**
   * Counter view — orders belonging to no table (FR64).
   *
   * A MODE, not a zone filter. While it is on, `activeZoneId` is ignored and the
   * grid shows counter orders instead of tables. They occupy no zone, so they
   * must never appear inside one or under "All zones".
   */
  const [counterMode, setCounterMode] = useState(false)
  /**
   * Counter orders have no `tableId`, so they cannot ride on `selectedTableId`.
   * Forcing them through it would mean inventing a fake table id — the exact
   * table-shaped assumption this story exists to remove.
   */
  const [selectedCounterId, setSelectedCounterId] = useState<string | null>(null)

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

  // Kitchen staff are refused this endpoint by policy, and they have no use for
  // it — so a 403 must not surface as an error banner on their landing screen.
  // Counter sales are owner + waiter, enforced by the `/api/sessions` policy.
  // Used for both the query and whether the pill exists at all.
  const canOpenCounterSales = role === 'owner' || role === 'waiter'

  const { data: counterSessions } = useQuery({
    queryKey: COUNTER_QUERY_KEY,
    queryFn: fetchCounterSessions,
    enabled: canOpenCounterSales,
    refetchOnMount: 'always',
  })

  const counterSale = useMutation({
    mutationFn: startCounterSale,
    onSuccess: (data) => {
      setIsNavigating(true)
      router.push(`/orders/${data.sessionId}`)
    },
    onError: (error) => handleTableActionError(error),
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
        // Patched, not left alone. Omitting it meant a device that did not make
        // the change kept whatever reason its row already held — null (showing
        // "No reason recorded") or, after a return-to-service, the PREVIOUS
        // outage's reason displayed against the next one.
        unavailableReason: payload.unavailableReason,
        // Patched, like unavailableReason and for the same reason. This array is
        // the SOLE input to the collapse decision in `toGridUnits`, so omitting
        // it meant a merge collapsed into one card only on the device that
        // performed it — everywhere else the party rendered as two occupied
        // cards with identical timers, the exact ambiguity collapsing exists to
        // remove. Un-merge was the mirror: survivors kept labels naming a table
        // already back on the floor as a free card in the same grid.
        groupTableLabels: payload.groupTableLabels,
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
    // The counter list needs the same resync — every `counter:changed` emitted
    // while the socket was down is gone, and nothing else refetches it.
    void queryClient.invalidateQueries({ queryKey: COUNTER_QUERY_KEY })
  })

  // Counter sales opened, closed or seated anywhere.
  //
  // Payload-free by design: this list is a query, not a set of patchable rows,
  // and its identities are server-assigned sequence numbers — reconstructing
  // those from incremental patches would mean recomputing every other row on the
  // client. Before this the list had no live channel at all, so a sale started
  // at the bar never appeared on a second tablet and one closed elsewhere stayed
  // tappable for the rest of the shift.
  useSocketEvent('counter:changed', () => {
    void queryClient.invalidateQueries({ queryKey: COUNTER_QUERY_KEY })
  })

  const socketConnected = useSocketStatus()

  // useMutation, not a bare fetch: `isPending` is what stops a second tap on the
  // same card firing a second POST while the first is still in flight.
  const openTable = useMutation({
    mutationFn: openSession,
    onSuccess: (data) => {
      // Merge mode is over either way — the group it staged is now a session.
      endMergeMode()
      // Navigation is tracked so the in-flight guard stays armed across it.
      // isPending clears the instant onSuccess runs, but router.push then starts
      // an async RSC round trip during which the grid is still mounted and fully
      // tappable — long enough to open a second session on a different table
      // that nobody is being seated at.
      setIsNavigating(true)
      // Straight to the canonical session URL. `/tables/:tableId` still resolves
      // — it redirects here — but the open response already carries the session
      // id, so going through it would cost a round trip for nothing.
      router.push(`/orders/${data.sessionId}`)
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

  // Availability. Two endpoints rather than one with a direction flag, because
  // they carry different permissions: any staff member can take a table out of
  // service, only an owner can return it. The namespace is what enforces that —
  // /api/config is owner-only — so a single route could not express it.
  const availability = useMutation({
    mutationFn: setAvailability,
    // RETURNED, not fired-and-forgotten. TanStack holds the mutation pending
    // until this settles, so `isPending` stays true across the refetch. Firing
    // it with `void` cleared isPending on the 200 while the grid still held the
    // pre-change row — long enough for a second tap on a button that should
    // already have been disabled.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY }),
    onError: (error) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      // Routed through the shared handler, which surfaces `error.message` on
      // every path rather than only on Forbidden and TableTaken. This branch used
      // to duplicate it and still end in the generic line, so a 404
      // TABLE_NOT_FOUND was parsed, carried here, and flattened — the precise
      // behaviour `handleTableActionError` was written to stop.
      handleTableActionError(error)
    },
  })

  /**
   * Undo a merge: release every table the merge attached.
   *
   * Deliberately NOT routed through `unmergeMutation` — that one posts its own
   * undo notice on success, and an undo that offers to undo itself is a loop the
   * waiter has to think their way out of mid-service.
   *
   * Only ever reachable for the merge-into-a-live-session path. The other path
   * (an open anchor, `additionalTableIds`) navigates to the order screen on
   * success, so this component is gone and there is no notice to act on.
   */
  const undoMerge = useCallback(
    (tableIds: string[]) => {
      void (async () => {
        try {
          // Sequential, not Promise.all. Each release is its own transaction and
          // the last-table guard is evaluated per request; firing them together
          // means the server decides the order anyway, and a partial failure
          // becomes impossible to describe.
          for (const tableId of tableIds) await unmergeTable(tableId)
          await queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
        } catch (error) {
          handleTableActionError(error)
        }
      })()
    },
    [queryClient, handleTableActionError],
  )

  /**
   * Undo an un-merge: attach the released table back to the same session.
   *
   * This one can legitimately fail. Releasing a table returns it to the floor,
   * where another waiter may seat it seconds later — and then there is nothing
   * to undo. Saying so is the whole point; a silent no-op would leave someone
   * believing the table came back.
   */
  const undoUnmerge = useCallback(
    (input: { tableId: string; anchorId: string; label: string; sessionId: string }) => {
      void (async () => {
        try {
          await mergeTables({
            tableId: input.anchorId,
            tableIds: [input.tableId],
            labels: [],
            // The same guard the forward path carries. This fires up to 8 seconds
            // later against a table whose session the server resolves fresh — so
            // if that party settles and a new one is seated inside the window,
            // without this the undo re-attaches the table to a DIFFERENT party's
            // order. Two parties, one bill: exactly what `mergeAnchor` exists to
            // prevent on the way in.
            expectedSessionId: input.sessionId,
          })
          await queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
        } catch (error) {
          if (error instanceof TableTakenError) {
            // The server's own wording, not one fixed sentence.
            //
            // `throwFromResponse` maps every 409 AND 422 to this class, so
            // SESSION_ALREADY_CLOSED, CROSS_ZONE_MERGE and TABLE_NOT_AVAILABLE
            // were all reported as "seated by someone else" — and the common
            // real path is the party settling inside the 8-second undo window,
            // which is a different fact entirely.
            showNotice(`Couldn't undo — ${error.message}`)
            void queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
            return
          }
          handleTableActionError(error)
        }
      })()
    },
    [queryClient, showNotice, handleTableActionError],
  )

  // Merging and un-merging. Both invalidate rather than patch: a merge changes
  // several rows at once and the acting device should not wait on N socket
  // events to see its own action land.
  const mergeMutation = useMutation({
    mutationFn: mergeTables,
    onSuccess: async (_data, variables) => {
      endMergeMode()
      // Awaited before the notice so the grid underneath already shows the
      // collapsed card by the time the waiter is offered a way back out of it.
      await queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
      showUndoNotice(`Merged ${variables.labels.join(' + ')}`, () =>
        undoMerge(variables.tableIds),
      )
    },
    onError: (error) => handleTableActionError(error),
  })

  const seatMutation = useMutation({
    mutationFn: seatSession,
    onSuccess: async (_data, variables) => {
      endSeating()
      setSelectedCounterId(null)
      // Both lists change: the sale leaves the counter list and the table
      // becomes occupied on the grid.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: COUNTER_QUERY_KEY }),
      ])
      // Show the table they were seated at, and make sure it is actually on
      // screen. Zone changes deliberately do not end seating, so the waiter can
      // stage in one zone and confirm from another — and selecting a table the
      // filter hides left the strip reading "No table selected" directly beneath
      // the notice saying the order had moved there.
      setActiveZoneId(null)
      setSelectedTableId(variables.tableIds[0])
      showNotice('Order moved to the table. Same bill.')
    },
    onError: (error) => {
      // Clear the staging. Leaving it meant the table that just 409'd was still
      // dashed-pending and still in the next confirm's payload, so the waiter
      // got the same refusal until they untapped it by hand.
      setSeatTableIds([])
      handleTableActionError(error)
    },
  })

  const unmergeMutation = useMutation({
    // `anchorId` and `label` are not sent anywhere — they exist so the undo can
    // put the table back on the right session and name it in the message.
    mutationFn: (input: {
      tableId: string
      anchorId: string
      label: string
      sessionId: string
    }) => unmergeTable(input.tableId),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: TABLES_QUERY_KEY })
      showUndoNotice(`${variables.label} released to the floor`, () => undoUnmerge(variables))
    },
    onError: (error) => handleTableActionError(error),
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
  const noticeTtl = notice?.ttlMs ?? 4_000
  useEffect(() => {
    if (noticeId === undefined) return
    const timer = setTimeout(() => setNotice(null), noticeTtl)
    return () => clearTimeout(timer)
  }, [noticeId, noticeTtl])

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

  // Merged sessions collapse to one card here, after the zone filter.
  const units = useMemo(() => toGridUnits(visibleTables), [visibleTables])

  const activeZoneName = zones.find((z) => z.id === activeZoneId)?.name ?? null

  /**
   * The selected unit — found by the table id, whether it is a single or a
   * member of a group.
   *
   * This is what makes selection survive a merge landing from ANOTHER device.
   * Nina has B3 selected; Aruna merges it into B2 from the other tablet; B3's
   * card stops existing. Looking the selection up by unit membership means it
   * simply becomes the group card, instead of going null and emptying the strip
   * out from under whatever Nina was in the middle of.
   */
  const selectedUnit = useMemo(
    () => units.find((unit) => unit.tables.some((table) => table.id === selectedTableId)) ?? null,
    [units, selectedTableId],
  )

  // Every action goes through the group's primary table. Any member resolves the
  // same session server-side — the routes all look up through the join table —
  // so this is a stable choice rather than a significant one.
  const selectedTable = selectedUnit?.primary ?? null

  const selectedUnitTitle = selectedUnit
    ? selectedUnit.isGroup
      ? mergedTitle(selectedUnit.labels)
      : selectedUnit.primary.label
    : null

  // Labels of the staged tables, in the order they were staged, so the commit
  // button can name them (AC-14).
  const mergeTableLabels = useMemo(() => {
    if (!mergeTableIds || !tables) return []
    return mergeTableIds.map((id) => tables.find((table) => table.id === id)?.label ?? '')
  }, [mergeTableIds, tables])

  /**
   * The selected counter order, resolved from the live list.
   *
   * Derived rather than stored so a counter sale closed on another device simply
   * stops being selected, instead of leaving the strip offering actions on an
   * order that no longer exists.
   */
  const selectedCounter = useMemo(() => {
    if (!counterMode || !selectedCounterId || !counterSessions) return null
    const index = counterSessions.findIndex((c) => c.sessionId === selectedCounterId)
    if (index === -1) return null
    const found = counterSessions[index]
    return {
      sessionId: found.sessionId,
      // Matches the list row exactly — same sequence, same time.
      label: `Counter #${found.sequence} · ${clockTime(found.openedAt)}`,
      elapsedMinutes: elapsedMinutesFrom(found.openedAt, minuteTick),
      itemCount: found.itemCount,
    }
  }, [counterMode, selectedCounterId, counterSessions, minuteTick])

  /**
   * The seating banner's contents — resolved from the live list, like selection.
   *
   * NOTE the `seatingResolved` flag below. Rendering the banner from this derived
   * value while card taps branch on the raw `seatingSessionId` is what let the
   * mode outlive its anchor: when the sale left the list mid-flow, the strip fell
   * through to the "No table selected" shell — which has no Cancel — while taps
   * kept staging tables. That is the identical defect Story 3.8's review found in
   * merge mode, reproduced by splitting one state across two sources.
   */
  const seating = useMemo(() => {
    if (!seatingSessionId || !counterSessions || !tables) return null
    const index = counterSessions.findIndex((c) => c.sessionId === seatingSessionId)
    if (index === -1) return null
    const found = counterSessions[index]
    return {
      sessionId: found.sessionId,
      label: `Counter #${found.sequence} · ${clockTime(found.openedAt)}`,
      tableLabels: seatTableIds.map(
        (id) => tables.find((table) => table.id === id)?.label ?? '',
      ),
    }
  }, [seatingSessionId, counterSessions, tables, seatTableIds])

  const selectedGroupTables = useMemo(
    () => selectedUnit?.tables.map((table) => ({ id: table.id, label: table.label })) ?? [],
    [selectedUnit],
  )

  // Flex column with a flex-1 main, so the strip sits at the BOTTOM of the
  // viewport on a short floor plan. `sticky bottom-0` alone could not do it —
  // sticky only shifts an element toward its edge from its static position, it
  // never pushes it down to fill min-h-screen, so with one zone of four tables
  // the strip rendered mid-screen with white space beneath it.
  return (
    <div className="flex min-h-screen flex-col">
      <ContextHeader
        restaurantName={restaurantName}
        staffName={staffName}
        zoneName={activeZoneName}
        tableLabel={selectedUnitTitle}
        onNavigate={(level) => {
          setCounterMode(false)
          setSelectedCounterId(null)
          // Seating survives — see endSeating. Only merge dies with the zone.
          // Merge mode dies with the selection.
          //
          // It used to survive: `mergeTableIds` stayed non-null while
          // `selectedUnit` went null, so the strip fell through to the "No table
          // selected" shell — which has NO Cancel button — while every card tap
          // still took the merge branch and staged tables invisibly. The
          // cross-zone guard is written `selectedTable && …`, so a null anchor
          // skipped it too. There was no way out but a page reload.
          endMergeMode()
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

      <main className="flex flex-1 flex-col gap-sp-4 p-sp-4">
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
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-sp-3 rounded-control bg-occupied-chip px-sp-3 py-sp-2"
          >
            <span className="text-fs-14 font-semibold text-occupied-ink">{notice.text}</span>
            {notice.action ? (
              // Full waiter-height touch target, not a text link. This is the
              // recovery path for an action taken on a shared tablet with wet
              // hands, and it is on screen for eight seconds — it cannot be a
              // 14px word someone has to aim at.
              <button
                type="button"
                onClick={() => {
                  const run = notice.action?.run
                  // Dismiss FIRST. Leaving it up meant a second tap during the
                  // request fired the undo twice.
                  setNotice(null)
                  run?.()
                }}
                className="h-touch-waiter rounded-waiter border border-occupied-ink/30 bg-white px-sp-4 text-fs-14 font-bold text-occupied-ink active:scale-[0.97]"
              >
                {notice.action.label}
              </button>
            ) : null}
          </div>
        ) : null}

        <ZoneChipBar
          zones={zones}
          activeZoneId={activeZoneId}
          totalOpenCount={totalOpenCount}
          onZoneChange={(id) => {
            // See the breadcrumb handler above — a merge cannot outlive the zone
            // it was staged in, and `selectedUnit` is derived from the
            // zone-filtered list.
            endMergeMode()
            setCounterMode(false)
            setSelectedCounterId(null)
            setActiveZoneId(id)
            setSelectedTableId(null)
          }}
          counterActive={counterMode}
          showCounter={canOpenCounterSales}
          onCounterSelect={() => {
            // Going back to the counter list abandons an in-progress seating —
            // unlike a zone change, this leaves the tables entirely.
            endMergeMode()
            endSeating()
            setSelectedTableId(null)
            setSelectedCounterId(null)
            setCounterMode(true)
          }}
        />

        {counterMode ? (
          // A LIST, not a grid.
          //
          // A grid implies space: a table card's position means that table is
          // over there, which is the whole reason the floor plan is a grid.
          // Counter sales have no location at all, so laying them out in one
          // promises a floor plan that does not exist — and the card size exists
          // to carry status colour readable from ten metres, which is pointless
          // for an order you are standing next to. A list is the honest form: a
          // queue, not a place. It also expresses oldest-first, which a grid
          // cannot.
          <div className="flex flex-col gap-sp-3">
            {/* Acts on tap, unlike a table card.

                Story 3.7 made a tap SELECT rather than act, because tapping a
                table used to seat a party. This is a labelled create affordance
                — the same thing a strip button is — and putting it behind
                select-then-confirm would be ceremony with nothing to protect. */}
            <button
              type="button"
              disabled={counterSale.isPending || isNavigating}
              onClick={() => {
                if (counterSale.isPending || isNavigating) return
                counterSale.mutate()
              }}
              className={cn(
                'flex h-touch-waiter items-center justify-center gap-sp-2 rounded-control',
                'border-2 border-dashed border-brand-500 bg-white text-brand-700',
                'text-fs-16 font-bold tracking-title',
                'transition-[transform,box-shadow] duration-120 ease-standard',
                'active:scale-[0.99] active:shadow-pressed disabled:opacity-40',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              <span aria-hidden className="text-fs-18 leading-none">
                +
              </span>
              {counterSale.isPending ? 'Starting…' : 'New counter sale'}
            </button>

            {(counterSessions ?? []).length === 0 ? (
              <p className="text-fs-16 text-slate-600">No counter sales. Tap + to start one.</p>
            ) : (
              <ul className="flex flex-col gap-sp-2">
                {(counterSessions ?? []).map((counter) => {
                  // Server-assigned day sequence, plus the start time.
                  //
                  // Neither alone is enough. A position in THIS list shifts as
                  // earlier sales close. A start time alone collides — two sales
                  // in the same minute read identically, which is ordinary at a
                  // busy bar. The sequence is fixed at creation from the full
                  // day's history, and the time is what staff say out loud.
                  const label = `Counter #${counter.sequence} · ${clockTime(counter.openedAt)}`
                  const minutes = elapsedMinutesFrom(counter.openedAt, minuteTick)
                  const isSelected = counter.sessionId === selectedCounterId

                  return (
                    <li key={counter.sessionId}>
                      <button
                        type="button"
                        onClick={() => setSelectedCounterId(counter.sessionId)}
                        aria-current={isSelected || undefined}
                        className={cn(
                          'flex w-full items-center justify-between gap-sp-4',
                          'min-h-touch-waiter rounded-control border-2 px-sp-4 py-sp-2 text-left',
                          'transition-[transform,box-shadow] duration-120 ease-standard',
                          'active:scale-[0.99] active:shadow-pressed',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                          isSelected
                            ? 'border-brand-500 bg-white shadow-selected'
                            : 'border-slate-200 bg-white shadow-el-1',
                        )}
                      >
                        <span className="truncate text-fs-16 font-bold tracking-title text-slate-900">
                          {label}
                        </span>

                        <span className="flex shrink-0 items-center gap-sp-3">
                          <span className="text-fs-14 tabular-nums text-slate-600">
                            {minutes !== undefined ? elapsed(minutes) : '—'} ·{' '}
                            {counter.itemCount > 0
                              ? `${counter.itemCount} item${counter.itemCount === 1 ? '' : 's'}`
                              : 'No items yet'}{' '}
                            · {counter.openedByName}
                          </span>
                          <span aria-hidden className="text-fs-18 text-slate-400">
                            ›
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ) : isPending ? (
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
            {units.map((unit) => {
              // Every action targets the group's primary row. For a single-table
              // unit that IS the table, so this collapses to the old behaviour.
              const table = unit.primary

              return (
                <TableCard
                  key={unit.key}
                  label={table.label}
                  // Only for a real group. Passing a one-entry array would make
                  // every ordinary card take the merged rendering path.
                  groupLabels={unit.isGroup ? unit.labels : undefined}
                  // The decision is passed, not re-derived. `buildUnit` sets
                  // `isGroup` from the SERVER's count while the card was
                  // recomputing it from the labels actually assembled — two
                  // sources of truth for one fact, and when they disagreed the
                  // card rendered as an ordinary single table spanning two grid
                  // columns.
                  merged={unit.isGroup}
                  wide={unit.isGroup}
                  zoneName={table.zoneName}
                  status={table.status}
                  capacity={unit.capacity}
                  elapsedMinutes={elapsedMinutesFrom(table.openedAt, minuteTick)}
                  itemCount={table.sessionId ? table.itemCount : undefined}
                  // Compared by UNIT, not by table id — otherwise selecting a
                  // group would light up only whichever member happened to be
                  // primary, on a card that represents all of them.
                  selected={unit.key === selectedUnit?.key}
                  // The same dashed "about to join" state serves both staging
                  // modes — to the waiter they are the same promise.
                  // The seating half is gated on the RESOLVED `seating`, so if
                  // the counter sale is closed or seated on another device the
                  // mode simply ends: no banner, no staged paint, and taps go
                  // back to selecting. Nothing is left armed and invisible —
                  // which is the whole failure this gating exists to prevent.
                  pendingMerge={
                    (mergeTableIds?.includes(table.id) ?? false) ||
                    (seating !== null && seatTableIds.includes(table.id))
                  }
                  // A tap SELECTS. It no longer acts.
                  //
                  // Story 3.3 opened a session on tap; Story 3.7 moves that behind
                  // the action strip's "Start order" (3.3 AC-1 amended). Three
                  // reasons: availability had no other entry point at all; Story
                  // 3.8's merge mode needs a strip; and the second tap is the
                  // confirmation that a table should not go occupied by accident.
                  //
                  // Every table is selectable, including `unavailable` — otherwise
                  // an owner could never select one to return it to service. That
                  // is why Story 3.2's `aria-disabled` on unavailable cards was
                  // REMOVED in 3.7: the button now genuinely does something, so
                  // marking it disabled would have been an ARIA lie. What the card
                  // no longer carries, the strip does — a waiter selecting an
                  // unavailable table is offered no action at all.
                  onSelect={() => {
                    // Seating a counter sale: a tap stages the table the guest
                    // moved to. Same rule as merge mode and same justification —
                    // the mode is explicit, named, and always shows Cancel.
                    // Gated on the RESOLVED seating, not the raw id.
                    //
                    // Branching on `seatingSessionId` while the banner rendered
                    // from the derived `seating` is what let the mode outlive its
                    // anchor: when the sale left the counter list mid-flow the
                    // strip fell through to a shell with no Cancel, while taps
                    // kept staging tables. One source of truth for one mode.
                    if (seating) {
                      if (table.status !== 'open') {
                        showNotice(
                          table.status === 'unavailable'
                            ? 'That table is out of service.'
                            : 'That table already has its own order.',
                        )
                        return
                      }
                      // Same-zone rule (FR62) — the server refuses cross-zone
                      // too, this just says so before the round trip.
                      const stagedZone = seatTableIds.length
                        ? tables?.find((t) => t.id === seatTableIds[0])?.zoneId
                        : undefined
                      if (stagedZone && table.zoneId !== stagedZone) {
                        showNotice('Tables can only be merged within one zone.')
                        return
                      }
                      setSeatTableIds((current) =>
                        current.includes(table.id)
                          ? current.filter((id) => id !== table.id)
                          : [...current, table.id],
                      )
                      return
                    }

                    // In merge mode a tap TOGGLES membership instead of changing
                    // the selection — the one place a tap changes meaning, which
                    // is why the mode is explicit and always shows Cancel/Done.
                    if (mergeTableIds) {
                      // The anchor is not togglable, and a table that already has
                      // its own order cannot join without deciding whose items are
                      // whose — Growth-tier, refused by the server too.
                      if (unit.key === selectedUnit?.key) return
                      if (table.status !== 'open') {
                        showNotice(
                          table.status === 'unavailable'
                            ? 'That table is out of service.'
                            : 'That table already has its own order.',
                        )
                        return
                      }
                      if (selectedTable && table.zoneId !== selectedTable.zoneId) {
                        showNotice('Tables can only be merged within one zone.')
                        return
                      }
                      setMergeTableIds((current) =>
                        current?.includes(table.id)
                          ? current.filter((id) => id !== table.id)
                          : [...(current ?? []), table.id],
                      )
                      return
                    }

                    setSelectedTableId(table.id)
                  }}
                />
              )
            })}
          </div>
        )}
      </main>

      {/* Sticky at the bottom, outside <main> so it does not scroll with the
          grid. Present in every state — including "nothing selected" — so the
          floor plan never reflows when a card is tapped. */}
      <FloorActionStrip
        // Keyed on the selection so the strip's own state — the reason prompt
        // and its typed text — cannot survive a change of table. Without this,
        // opening the prompt on one table and then tapping another retargeted
        // the prompt: a tap on "Broken" took out the table you looked at
        // second, carrying the reason you typed for the first.
        // Keyed on the UNIT **and its status**. A selected table becoming part
        // of a group is a change of context every bit as much as selecting a
        // different card, and any half-finished panel in the strip is
        // meaningless afterwards.
        //
        // Status is in the key because the reason prompt's own comment claimed
        // the parent unmounts the strip on success — which the unit key alone
        // never did, since a table id does not change when the table goes out of
        // service. Including status makes that claim true.
        key={
          seating
            ? `seating:${seating.sessionId}`
            : selectedCounter
              ? `counter:${selectedCounter.sessionId}`
              : `${selectedUnit?.key ?? 'none'}:${selectedTable?.status ?? 'none'}`
        }
        table={selectedTable}
        role={role}
        elapsedMinutes={
          selectedTable ? elapsedMinutesFrom(selectedTable.openedAt, minuteTick) : undefined
        }
        busy={
          openTable.isPending ||
          availability.isPending ||
          mergeMutation.isPending ||
          unmergeMutation.isPending ||
          counterSale.isPending ||
          seatMutation.isPending ||
          isNavigating
        }
        onStartOrder={(tableId) => {
          // Everything Story 3.3's review established still applies — it just
          // fires from the strip now instead of from the card.
          if (openTable.isPending || isNavigating) return
          openTable.mutate({ tableId })
        }}
        onOpenOrder={(tableId) => {
          if (isNavigating) return
          // The row already holds the session id, so navigate to the session
          // directly; fall back to the table route (which redirects) only if it
          // is somehow absent.
          const sessionId = selectedUnit?.tables.find((t) => t.id === tableId)?.sessionId
          setIsNavigating(true)
          router.push(sessionId ? `/orders/${sessionId}` : `/tables/${tableId}`)
        }}
        // Guarded like onStartOrder. These previously called mutate directly,
        // with the buttons' `disabled` as the only protection — which the reason
        // prompt's text input opted out of, so Enter could fire a POST while
        // every button around it was greyed out.
        onTakeOutOfService={(tableId, reason) => {
          if (availability.isPending || isNavigating) return
          availability.mutate({ tableId, direction: 'out', reason })
        }}
        onReturnToService={(tableId) => {
          if (availability.isPending || isNavigating) return
          availability.mutate({ tableId, direction: 'in' })
        }}
        mergeTableIds={mergeTableIds}
        mergeTableLabels={mergeTableLabels}
        groupTables={selectedGroupTables}
        onBeginMerge={() => {
          if (!selectedTable) return
          setMergeTableIds([])
          // Snapshot the anchor. Everything downstream decides against THIS,
          // not against whatever the floor looks like when Done is tapped.
          setMergeAnchor({ tableId: selectedTable.id, sessionId: selectedTable.sessionId })
        }}
        onCancelMerge={endMergeMode}
        onConfirmMerge={() => {
          if (!selectedTable || !selectedUnit || !mergeAnchor || !mergeTableIds?.length) return
          if (mergeMutation.isPending) return

          // Branch on the anchor AS STAGED, never on its current status.
          //
          // An anchor that already had a session needs those tables attached to
          // it; one that was free needs a session created with the whole group
          // at once. Reading the CURRENT status here is what let a free anchor
          // seated by another device mid-staging silently become a merge into
          // that other waiter's order. Deciding from the snapshot means the
          // stale case now takes the open path and gets a clean 409
          // TABLE_ALREADY_OCCUPIED instead.
          if (mergeAnchor.sessionId) {
            mergeMutation.mutate({
              tableId: mergeAnchor.tableId,
              tableIds: mergeTableIds,
              // The whole resulting party, not just the anchor's own label —
              // the anchor may already be a group, and the undo notice has to
              // name what actually happened.
              labels: [...selectedUnit.labels, ...mergeTableLabels],
              // The server refuses if the anchor's session moved underneath us.
              expectedSessionId: mergeAnchor.sessionId,
            })
          } else {
            openTable.mutate({
              tableId: mergeAnchor.tableId,
              additionalTableIds: mergeTableIds,
            })
          }
        }}
        counter={selectedCounter}
        onOpenCounter={(sessionId) => {
          if (isNavigating) return
          setIsNavigating(true)
          router.push(`/orders/${sessionId}`)
        }}
        seating={seating}
        onBeginSeating={(sessionId) => {
          setSeatingSessionId(sessionId)
          setSeatTableIds([])
          // Leave the Counter view — the waiter has to SEE the tables to pick
          // one. The staging banner is what keeps the counter sale in context
          // while they are looking at the floor.
          setCounterMode(false)
          setSelectedTableId(null)
        }}
        onCancelSeating={() => {
          endSeating()
          // Back to where they started, with the sale still selected.
          setCounterMode(true)
        }}
        onConfirmSeating={() => {
          if (!seating || seatTableIds.length === 0) return
          if (seatMutation.isPending) return
          seatMutation.mutate({ sessionId: seating.sessionId, tableIds: seatTableIds })
        }}
        onUnmerge={(tableId) => {
          if (unmergeMutation.isPending || isNavigating) return
          if (!selectedUnit) return

          // Where the table goes back to if the waiter undoes this. Any other
          // member of the group will do — they all resolve the same session.
          const anchor = selectedUnit.tables.find((table) => table.id !== tableId)
          // No anchor means this was the only table, which the server refuses
          // anyway (SESSION_NEEDS_A_TABLE). Nothing to release it from.
          if (!anchor) return

          unmergeMutation.mutate({
            tableId,
            anchorId: anchor.id,
            // The session the table is being released FROM — replayed on undo so
            // the server can refuse if that session is gone by then.
            sessionId: selectedUnit.key,
            label: selectedUnit.tables.find((table) => table.id === tableId)?.label ?? 'That table',
          })
        }}
      />
    </div>
  )
}
