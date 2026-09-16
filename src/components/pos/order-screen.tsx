'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MenuBrowser } from '@/components/pos/menu-browser'
import { OrderHeader } from '@/components/pos/order-header'
import { OrderSummary } from '@/components/pos/order-summary'
import {
  OrderActionStrip,
  type OrderActionStripState,
} from '@/components/pos/order-action-strip'
import { SeatSelector, type SeatSlot } from '@/components/pos/seat-selector'
import { ModifierSheet } from '@/components/pos/modifier-sheet'
import { RoundHistory } from '@/components/pos/round-history'
import {
  StagedRoundList,
  type StagedLineProblem,
} from '@/components/pos/staged-round-list'
import { useStagedRound } from '@/components/pos/use-staged-round'
import type { MenuItemRow } from '@/app/api/menu/route'
import type { MenuCategoryRow } from '@/app/api/menu/route'
import type { SubmittedRoundRow } from '@/app/api/sessions/[sessionId]/orders/route'
import { MENU_QUERY_KEY } from '@/components/pos/menu-browser'
import { elapsedMinutesFrom, useMinuteTick } from '@/hooks/use-minute-tick'
import { signOut } from '@/lib/auth-client'
import { clockTime, elapsed } from '@/lib/format'
import { cn } from '@/lib/utils'

export type OrderScreenProps = {
  /**
   * The session — the identity this screen is built on since Story 3.9.
   *
   * It used to be keyed on `tableId`, which made a counter sale unreachable by
   * construction: FR64's order has no table to put in the URL.
   */
  sessionId: string
  restaurantName: string
  staffName: string
  /**
   * Null for a counter sale (FR64) — it sits in no zone and at no table.
   * Everything else on this screen behaves identically.
   */
  zoneName: string | null
  tableLabel: string | null
  capacity: number | null
  coverCount: number
  /** ISO timestamp from PostgreSQL. Elapsed time is derived client-side. */
  openedAt: string
  /** Decides which close reason applies. Zero until Epic 4 adds order entry. */
  itemCount: number
  /**
   * The session's seats, from the page's own server query (FR10).
   *
   * Every session opened since migration 0011 has at least one — both open paths
   * create Seat 1 in the same transaction that creates the session.
   *
   * It is NOT unconditionally non-empty, which this comment used to claim.
   * Sessions that were already open when 0011 ran got no seats: the migration
   * created the table and backfilled nothing. Migration 0013 backfills them, so
   * the gap is closed for this deployment — but the screen still renders an
   * empty row honestly rather than assuming, because the next migration that
   * adds a per-session row will make the same mistake available again.
   */
  seats: SeatSlot[]
  /**
   * Rounds already submitted on this session, from the page's server query.
   *
   * Seeded the same way the seats are, for the same reason: AC-6 wants the
   * history present in the first paint, not filled in a moment later under the
   * staging area the waiter is already looking at.
   */
  submittedRounds: SubmittedRoundRow[]
  /**
   * `tenant_config.tax_rate_percent`. Zero by default, in which case the
   * summary shows no tax row at all. There is no service-charge column — see
   * `OrderSummary`.
   */
  taxRatePercent: number
}

/** FR9's destinations as a waiter says them, for the bottom bar. */
const DESTINATION_NAME = {
  kitchen: 'Kitchen',
  pizza_kitchen: 'Pizza',
  bar: 'Bar',
} as const

/**
 * A memory aid, not a description.
 *
 * Must match `MAX_SEAT_NOTE` in both seat routes — nothing checks that it does.
 * The input's `maxLength` is the only thing standing between a waiter and a 400
 * from PATCH, so if the server's cap moves and this does not, the field will
 * accept text the save then rejects.
 */
const MAX_SEAT_NOTE = 40

/** Thrown when the session is gone. Signing in again fixes it. */
class SessionExpiredError extends Error {}

/**
 * Thrown when the session is valid but the ROLE is not permitted.
 *
 * Kept distinct from SessionExpiredError. Conflating the two is what produced a
 * sign-out loop for kitchen users in Story 3.3's review: re-authenticating
 * cannot change your role, so redirecting to the PIN pad on a 403 loops forever.
 */
class ForbiddenError extends Error {}

/** Thrown when another device closed this session first. An ordinary outcome. */
class SessionGoneError extends Error {}

/**
 * A RETRYABLE 409 from a seat route, carrying the server's own words.
 *
 * The seat conflicts are the ones a waiter has to act on — "this is the only
 * seat on the order", "this seat has 4 items on it" — and only the server can
 * count. A generic "could not remove the seat" would leave them tapping it
 * again, which is why the message travels rather than the status alone.
 *
 * `SESSION_ALREADY_CLOSED` is explicitly NOT one of these. It arrives as a 409
 * too, but it is terminal: the order was closed on another device and no amount
 * of tapping will change that. It used to land here and render as a dismissible
 * pink notice on a screen still showing the table, the timer and the menu.
 */
class SeatConflictError extends Error {}

/**
 * The seat this screen is holding no longer exists — removed on another device.
 *
 * Distinct because the fix is a refetch, not a retry. Every non-409 error used
 * to collapse into the caller's fallback string, so a 404 produced "Could not
 * save the note. Try again." forever against a phantom chip that nothing
 * refreshed.
 */
class SeatGoneError extends Error {}

/** Shared transport for the four seat calls. Same auth handling as `closeTable`. */
async function seatRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const body = await response.json().catch(() => null)

  if (response.status === 404) {
    throw new SeatGoneError(body?.error?.message ?? 'That seat is no longer on this order.')
  }
  if (response.status === 409) {
    // Read the CODE, not just the status. Two different outcomes share it.
    if (body?.error?.code === 'SESSION_ALREADY_CLOSED') {
      throw new SessionGoneError('Already closed')
    }
    throw new SeatConflictError(body?.error?.message ?? 'That seat cannot change right now.')
  }
  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? 'Request failed')
  }

  return body.data as T
}

async function closeTable(input: { sessionId: string; reason: 'abandoned' | 'walkout' }) {
  // Session-addressed. The table-addressed close still exists and still works,
  // but it finds the session by walking from a table — which a counter sale does
  // not have.
  const response = await fetch(`/api/sessions/${input.sessionId}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: input.reason }),
  })

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')
  if (response.status === 409) throw new SessionGoneError('Already closed')

  const body = await response.json().catch(() => null)

  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? 'Could not close the table')
  }

  return body.data as { sessionId: string }
}

/**
 * Order entry — menu on the left, the order on the right, one bar at the foot.
 *
 * ── Layout, from Teran's 2026-09-16 design ───────────────────────────────────
 * The first version stacked a header, a facts card, a seat chip row, search,
 * category chips, the menu, the staged round and the close controls in one
 * column. On a tablet a waiter saw perhaps six dishes and had to scroll past
 * the whole menu to check what they had just added.
 *
 * Now the screen is two fixed columns that scroll independently, with the
 * header and the bar pinned. The order column owns everything about WHO and
 * WHAT: seats at the top, the unsent lines in the middle, the total at the
 * foot. The menu owns everything about WHICH DISH. Nothing about the order
 * moves when the menu scrolls, which is the property the old layout lacked.
 */
export function OrderScreen({
  sessionId,
  restaurantName,
  staffName,
  zoneName,
  taxRatePercent,
  tableLabel,
  capacity,
  coverCount,
  openedAt,
  itemCount,
  seats: initialSeats,
  submittedRounds: initialRounds,
}: OrderScreenProps) {
  // A counter sale has no table, so it is named for what it is. Everything else
  // on this screen — rounds, items, closing — is identical either way, which is
  // the point of keying the screen on the session rather than on a table.
  const displayLabel = tableLabel ?? 'Counter'
  const router = useRouter()
  const queryClient = useQueryClient()
  const minuteTick = useMinuteTick()
  const elapsedMinutes = elapsedMinutesFrom(openedAt, minuteTick)

  const [isNavigating, setIsNavigating] = useState(false)
  const [confirmingWalkout, setConfirmingWalkout] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // ── Seats ─────────────────────────────────────────────────────────────────
  // Seeded from the server render, so the first paint already has the party
  // (AC-5). `staleTime` keeps this from refetching on mount — the cache is
  // already the truth. The GET exists so the three mutations below can put the
  // list back in sync without a full page load.
  const seatsQueryKey = ['seats', sessionId]
  const { data: seats, error: seatsError } = useQuery({
    queryKey: seatsQueryKey,
    queryFn: () => seatRequest<SeatSlot[]>(`/api/sessions/${sessionId}/seats`),
    initialData: initialSeats,
    staleTime: 30_000,
    // Seats have no socket event yet — deferred to Story 4.4, which has to put
    // staged items on the wire anyway and will carry seats with them. This is
    // the cheap half of that: picking up the other tablet refetches, which
    // covers the realistic second-device case without inventing a payload
    // before anything consumes it. The provider disables this globally.
    refetchOnWindowFocus: true,
  })

  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null)
  const [editingSeatId, setEditingSeatId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [confirmingSeatRemoval, setConfirmingSeatRemoval] = useState(false)
  const [seatNotice, setSeatNotice] = useState<string | null>(null)

  // DERIVED, not synced in an effect. A selection that no longer exists — the
  // seat was removed here, or on the other tablet — falls back to the first
  // seat instead of leaving the row with nothing active. Story 4.2's review
  // replaced the same shape on the category chips for the same reason: an
  // effect that writes state after render is a frame of wrong UI.
  const activeSeatId = seats.some((seat) => seat.id === selectedSeatId)
    ? selectedSeatId
    : (seats[0]?.id ?? null)
  const activeSeat = seats.find((seat) => seat.id === activeSeatId) ?? null

  // Selecting a different chip closes the panel by construction — no effect,
  // and no stale editor pointing at a seat the waiter has moved on from.
  const isEditingSeat = editingSeatId !== null && editingSeatId === activeSeatId

  function openSeatEditor(seat: SeatSlot) {
    setEditingSeatId(seat.id)
    setNoteDraft(seat.seatNote ?? '')
    setConfirmingSeatRemoval(false)
    setSeatNotice(null)
  }

  function closeSeatEditor() {
    setEditingSeatId(null)
    setConfirmingSeatRemoval(false)
  }

  function handleSeatError(fallback: string) {
    return (error: unknown) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      // Never redirect on a 403 — re-authenticating cannot change your role.
      if (error instanceof ForbiddenError) {
        setSeatNotice('Your role cannot change seats.')
        return
      }
      // Terminal. Someone closed the order on another device, so this screen is
      // showing a table that is no longer sat at. Leave, exactly as the close
      // flow does — a notice here would be a dismissible message on a dead page.
      if (error instanceof SessionGoneError) {
        setIsNavigating(true)
        void queryClient.invalidateQueries({ queryKey: ['tables'] })
        router.push('/')
        return
      }
      // The seat is gone, so retrying cannot work. Refetch instead, which makes
      // the phantom chip disappear and the message true rather than a loop.
      if (error instanceof SeatGoneError) {
        setSeatNotice(error.message)
        void queryClient.invalidateQueries({ queryKey: seatsQueryKey })
        return
      }
      if (error instanceof SeatConflictError) {
        setSeatNotice(error.message)
        return
      }
      setSeatNotice(fallback)
    }
  }

  const addSeatMutation = useMutation({
    // A refetch already in flight would resolve AFTER the optimistic append and
    // overwrite it with a list that predates the new seat. `activeSeatId` then
    // derives back to seats[0], `isEditingSeat` flips false, and the note panel
    // unmounts with the waiter's half-typed draft inside it.
    onMutate: () => queryClient.cancelQueries({ queryKey: seatsQueryKey }),
    mutationFn: () =>
      seatRequest<SeatSlot>(`/api/sessions/${sessionId}/seats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No label and no note. The label is derived server-side — a client
        // that proposes one produces two "Seat 2"s the moment two tablets add
        // at once — and the note is never required: Add Seat is one tap.
        body: JSON.stringify({}),
      }),
    onSuccess: (seat) => {
      setSeatNotice(null)
      // Append immediately so the new chip is there before the refetch lands,
      // then invalidate so the server has the last word.
      queryClient.setQueryData<SeatSlot[]>(seatsQueryKey, (current) => [
        ...(current ?? []),
        seat,
      ])
      void queryClient.invalidateQueries({ queryKey: seatsQueryKey })
      // Select it and open the note field: the note gets typed while the waiter
      // is still looking at the person, and is skipped by ignoring it.
      setSelectedSeatId(seat.id)
      openSeatEditor(seat)
    },
    onError: handleSeatError('Could not add a seat. Try again.'),
  })

  const updateNoteMutation = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: seatsQueryKey }),
    mutationFn: (input: { seatId: string; seatNote: string }) =>
      seatRequest<SeatSlot>(`/api/sessions/${sessionId}/seats/${input.seatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatNote: input.seatNote }),
      }),
    onSuccess: (seat) => {
      setSeatNotice(null)
      queryClient.setQueryData<SeatSlot[]>(seatsQueryKey, (current) =>
        (current ?? []).map((existing) => (existing.id === seat.id ? seat : existing)),
      )
      void queryClient.invalidateQueries({ queryKey: seatsQueryKey })
      closeSeatEditor()
    },
    onError: handleSeatError('Could not save the note. Try again.'),
  })

  const removeSeatMutation = useMutation({
    onMutate: () => queryClient.cancelQueries({ queryKey: seatsQueryKey }),
    mutationFn: (seatId: string) =>
      seatRequest<{ seatId: string }>(`/api/sessions/${sessionId}/seats/${seatId}`, {
        method: 'DELETE',
      }),
    onSuccess: (removed) => {
      setSeatNotice(null)
      queryClient.setQueryData<SeatSlot[]>(seatsQueryKey, (current) =>
        (current ?? []).filter((seat) => seat.id !== removed.seatId),
      )
      void queryClient.invalidateQueries({ queryKey: seatsQueryKey })
      // Clear the selection rather than picking a neighbour — the derived
      // fallback above lands on the first seat, which is somewhere real.
      setSelectedSeatId(null)
      closeSeatEditor()
    },
    onError: handleSeatError('Could not remove the seat. Try again.'),
  })

  const seatBusy =
    addSeatMutation.isPending || updateNoteMutation.isPending || removeSeatMutation.isPending

  // ── The staged round ──────────────────────────────────────────────────────
  // Client-only by AC-5. Nothing below writes to the database; Story 4.5's
  // submit is the commit point.
  const { lines, addLine, removeLine, setQuantity, reassignLine, clear } =
    useStagedRound(sessionId)

  // The item whose modifier sheet is open, or null. Holding the ROW rather than
  // an id means the sheet renders the price the waiter tapped even if the menu
  // refetches underneath it.
  const [sheetItem, setSheetItem] = useState<MenuItemRow | null>(null)

  /**
   * The waiter tapped "Add More Items" on a session whose rounds are all sent.
   *
   * Purely presentational: it moves the strip off `submitted` and opens an empty
   * staging area. Nothing is written, and the round NUMBER is not decided here —
   * that happens inside Story 4.5's submit transaction, because a number chosen
   * on the client is a number two tablets can choose identically.
   */
  const [addingMore, setAddingMore] = useState(false)

  const { data: submittedRounds } = useQuery({
    queryKey: ['orders', sessionId],
    queryFn: () => seatRequest<SubmittedRoundRow[]>(`/api/sessions/${sessionId}/orders`),
    initialData: initialRounds,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  // Read, never fetched here: the menu is MenuBrowser's query and this only
  // needs to know what is still available. A second fetch would be a second
  // source of truth for what is on the menu right now.
  const menu = queryClient.getQueryData<MenuCategoryRow[]>(MENU_QUERY_KEY)

  /**
   * Why each staged line cannot be submitted, or nothing for the healthy ones.
   *
   * DERIVED on every render from the live seats and the live menu — not
   * recorded when the line was staged. The entire point is to notice a change
   * that happens afterwards, and both now happen in ordinary use: Story 4.3
   * added seat deletion and its review turned on `refetchOnWindowFocus`, so the
   * other tablet's removals arrive when this one is picked back up.
   *
   * Left unchecked, a stale `seat_slot_id` reaches Story 4.5's insert and the
   * foreign key rejects the whole round with a 500.
   */
  const stagedProblems = new Map<string, StagedLineProblem>()
  for (const line of lines) {
    if (!seats.some((seat) => seat.id === line.seatSlotId)) {
      stagedProblems.set(line.lineId, { kind: 'seat-gone' })
      continue
    }
    // `menu === undefined` means the menu has not loaded yet, which is not the
    // same as "the item is gone" — do not flag on absence of knowledge.
    if (menu) {
      const known = menu
        .flatMap((category) => category.items)
        .find((item) => item.id === line.menuItemId)
      if (known && !known.available) {
        stagedProblems.set(line.lineId, { kind: 'item-unavailable' })
      }
    }
  }

  function stageItem(item: MenuItemRow, options?: { quantity?: number; modifierText?: string }) {
    // Cannot happen through the UI — every session has a seat and the chip row
    // always has one active — but staging against a null seat would produce a
    // line Story 4.5 could not write, so it is refused here rather than there.
    if (!activeSeatId) {
      setSeatNotice('Add a seat before ordering.')
      return
    }
    addLine(item, { seatSlotId: activeSeatId, ...options })
  }

  // Three facts, not one. Something staged beats everything; nothing staged with
  // history is a sent order awaiting its next round; nothing at all is empty —
  // and so is a round the waiter has deliberately opened but not filled.
  const stripState: OrderActionStripState =
    lines.length > 0
      ? 'items-added'
      : submittedRounds.length > 0 && !addingMore
        ? 'submitted'
        : 'empty'

  // With items on the table, leaving is a walkout — money is owed and nobody
  // paid it. With nothing ordered, it is an abandonment. The server enforces
  // this too; the screen only decides which control to show.
  const isWalkout = itemCount > 0

  const closeMutation = useMutation({
    mutationFn: closeTable,
    onSuccess: () => {
      setIsNavigating(true)
      // Invalidate AND navigate. TableGrid also refetches on mount, but doing it
      // explicitly means a correct grid does not depend on that setting staying
      // configured somewhere else.
      void queryClient.invalidateQueries({ queryKey: ['tables'] })
      router.push('/')
    },
    onError: (error) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      // Never redirect on a 403 — the session is fine, the role is not
      // permitted, and the PIN pad cannot fix that.
      if (error instanceof ForbiddenError) {
        setNotice('Your role cannot close tables.')
        return
      }
      // Someone else already closed it. The table is released either way, so
      // send them back to a grid that reflects reality rather than erroring.
      if (error instanceof SessionGoneError) {
        setIsNavigating(true)
        void queryClient.invalidateQueries({ queryKey: ['tables'] })
        router.push('/')
        return
      }
      setNotice('Could not close the table. Try again.')
    },
  })

  const busy = closeMutation.isPending || isNavigating

  // ── Derived for the new layout ────────────────────────────────────────────
  // All counted from the staged LINES, by quantity — "Devilled Cashew × 2" is
  // two dishes on the badge and two on the seat card, not one line.
  const stagedCountBySeat = new Map<string, number>()
  const stagedCountByItem = new Map<string, number>()
  for (const line of lines) {
    stagedCountBySeat.set(
      line.seatSlotId,
      (stagedCountBySeat.get(line.seatSlotId) ?? 0) + line.quantity,
    )
    stagedCountByItem.set(
      line.menuItemId,
      (stagedCountByItem.get(line.menuItemId) ?? 0) + line.quantity,
    )
  }
  const stagedItemCount = lines.reduce((total, line) => total + line.quantity, 0)
  const subtotalPaisa = lines.reduce((total, line) => total + line.pricePaisa * line.quantity, 0)

  // "Kitchen", "Kitchen & Bar", "Kitchen, Pizza & Bar" — in FR9's order, so the
  // phrase is stable while items are added rather than reshuffling.
  const destinations = (['kitchen', 'pizza_kitchen', 'bar'] as const)
    .filter((destination) => lines.some((line) => line.productionDestination === destination))
    .map((destination) => DESTINATION_NAME[destination])
  const destinationSummary =
    destinations.length === 0
      ? undefined
      : destinations.length === 1
        ? destinations[0]
        : `${destinations.slice(0, -1).join(', ')} & ${destinations[destinations.length - 1]}`

  const contextLine = [
    zoneName ?? 'Counter sale',
    `${seats.length} seat${seats.length === 1 ? '' : 's'}`,
    elapsedMinutes !== undefined ? `open ${elapsed(elapsedMinutes)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // `minuteTick` is 0 during SSR, so the clock renders empty on the server and
  // fills in on hydration rather than mismatching.
  const clock = minuteTick === 0 ? '' : clockTime(new Date(minuteTick).toISOString())

  // Flex column pinned to the viewport on tablet and up, so the header and the
  // bar stay put and each column scrolls inside itself. `sticky bottom-0` alone
  // cannot pin the bar — sticky only shifts an element toward its edge from its
  // static position. The floor screen hit that exact problem.
  return (
    // `slate-100` is the system's app background.
    <div className="flex min-h-dvh flex-col bg-slate-100 md:h-dvh">
      <OrderHeader
        tableLabel={displayLabel}
        contextLine={contextLine}
        activeSeatLabel={activeSeat ? (activeSeat.seatNote ?? activeSeat.seatLabel) : null}
        // The screen only renders for an OPEN session — the page redirects
        // otherwise — so it is occupied by construction, counter sales included.
        statusLabel="Occupied"
        staffName={staffName}
        clock={clock}
        onBack={() => router.push('/')}
        // Also the only way off this screen for a waiter ending a shift.
        onStaffTap={signOut}
      />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* ── The menu ─────────────────────────────────────────────────────── */}
        {/* 3 : 1 — the menu takes three parts of the width and the order
            column one (Teran, 2026-09-16). Flex growth with a zero basis, so
            the ratio holds at every width; `min-w-80` stops the order column
            being squeezed below what four seat buttons need on a small tablet. */}
        <main className="flex min-h-0 flex-1 flex-col p-sp-4 md:min-w-0 md:flex-[3_3_0%]">
          <MenuBrowser
            onAdd={(item) => stageItem(item)}
            onOpenModifiers={(item) => setSheetItem(item)}
            stagedCountByItem={stagedCountByItem}
          />
        </main>

        {/* ── The order ────────────────────────────────────────────────────── */}
        <aside
          aria-label="This order"
          className="flex min-h-0 flex-col border-t border-slate-200 bg-white md:min-w-80 md:flex-[1_1_0%] md:border-t-0 md:border-l"
        >
          {/* Seats, pinned at the top of the column: "who is this for?" is the
              question before every tap, so it must not scroll away. */}
          <section className="flex shrink-0 flex-col gap-sp-3 border-b border-slate-200 p-sp-4">
            <SeatSelector
              seats={seats}
              activeSeatId={activeSeatId}
              stagedCountBySeat={stagedCountBySeat}
              editingSeatId={isEditingSeat ? editingSeatId : null}
              adding={addSeatMutation.isPending}
              onSelect={(seatId) => {
                setSelectedSeatId(seatId)
                setSeatNotice(null)
              }}
              onEditSeat={(seatId) => {
                const seat = seats.find((candidate) => candidate.id === seatId)
                if (!seat) return
                if (isEditingSeat) closeSeatEditor()
                else openSeatEditor(seat)
              }}
              onAddSeat={() => addSeatMutation.mutate()}
            />

            {isEditingSeat && activeSeat ? (
              // A real form, so the tablet keyboard's Enter saves the note.
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (seatBusy) return
                  updateNoteMutation.mutate({ seatId: activeSeat.id, seatNote: noteDraft })
                }}
                className="flex flex-col gap-sp-2 rounded-waiter border border-slate-200 bg-slate-100 p-sp-3"
              >
                <label className="flex flex-col gap-sp-1">
                  <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                    Note for {activeSeat.seatLabel} — staff only
                  </span>
                  <input
                    type="text"
                    value={noteDraft}
                    maxLength={MAX_SEAT_NOTE}
                    placeholder="red shirt, curly hair…"
                    onChange={(event) => setNoteDraft(event.target.value)}
                    className={cn(
                      'h-12 rounded-control border border-slate-200 bg-white px-sp-3',
                      'text-fs-16 text-slate-900 placeholder:text-slate-400',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                    )}
                  />
                </label>

                {/* Said out loud, because the person typing it would otherwise
                    assume it prints. Epic 6 enforces it where the bill is built. */}
                <p className="text-fs-12 text-slate-600">
                  Shown to staff and on kitchen tickets. Never printed on a guest&apos;s bill.
                </p>

                {/* `seats.length > 1` gates BOTH branches, so a refetch that
                    drops the other seat cannot leave "Yes, remove" on screen. */}
                {confirmingSeatRemoval && seats.length > 1 ? (
                  <div className="flex flex-col gap-sp-2 rounded-control border-2 border-unavailable-edge bg-unavailable-body p-sp-3">
                    {/* Says what is true. `nextSeatLabel` is highest + 1, so
                        removing the LAST seat and re-adding returns the same
                        number; "a new one gets a new number" was false. */}
                    <p className="text-fs-14 font-bold text-unavailable-ink">
                      Remove {activeSeat.seatLabel}? This cannot be undone.
                    </p>
                    <div className="flex gap-sp-2">
                      <button
                        type="button"
                        disabled={seatBusy}
                        onClick={() => removeSeatMutation.mutate(activeSeat.id)}
                        className={cn(
                          'h-12 flex-1 rounded-control bg-unavailable-band text-fs-14 font-bold text-white',
                          'transition-transform duration-80 ease-standard active:scale-[0.97]',
                          'disabled:opacity-40 disabled:active:scale-100',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                        )}
                      >
                        {removeSeatMutation.isPending ? 'Removing…' : 'Yes, remove'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingSeatRemoval(false)}
                        className={cn(
                          'h-12 flex-1 rounded-control border border-slate-200 bg-white text-fs-14 font-semibold text-slate-600',
                          'transition-transform duration-80 ease-standard active:scale-[0.97]',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                        )}
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-sp-2">
                    <button
                      type="submit"
                      disabled={seatBusy}
                      className={cn(
                        'h-12 flex-1 rounded-control bg-brand-700 text-fs-14 font-bold text-white',
                        'transition-transform duration-80 ease-standard active:scale-[0.97]',
                        'disabled:opacity-40 disabled:active:scale-100',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      {updateNoteMutation.isPending ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={closeSeatEditor}
                      className={cn(
                        'h-12 flex-1 rounded-control border border-slate-200 bg-white text-fs-14 font-semibold text-slate-600',
                        'transition-transform duration-80 ease-standard active:scale-[0.97]',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      Done
                    </button>
                    {/* Only when there is another seat to fall back on. The
                        server refuses the last one either way. */}
                    {seats.length > 1 ? (
                      <button
                        type="button"
                        disabled={seatBusy}
                        onClick={() => setConfirmingSeatRemoval(true)}
                        className={cn(
                          'h-12 shrink-0 rounded-control border border-unavailable-edge bg-white px-sp-3',
                          'text-fs-14 font-semibold text-unavailable-ink',
                          'transition-transform duration-80 ease-standard active:scale-[0.97]',
                          'disabled:opacity-40 disabled:active:scale-100',
                          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                        )}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                )}
              </form>
            ) : null}

            {/* A failing background refetch is surfaced, derived from the query
                rather than pushed into state by an effect. */}
            {seatNotice || seatsError ? (
              <p
                role="status"
                className="rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
              >
                {seatNotice ?? 'Could not refresh the seats. Reopen the order to retry.'}
              </p>
            ) : null}
          </section>

          {/* The round. Scrolls on its own; the seats above and the total below
              stay put. History sits ABOVE the unsent lines (AC-6). */}
          <div className="flex min-h-0 flex-1 flex-col gap-sp-3 overflow-y-auto p-sp-4">
            <RoundHistory rounds={submittedRounds} />

            <StagedRoundList
              lines={lines}
              seats={seats}
              problems={stagedProblems}
              onRemove={removeLine}
              onSetQuantity={setQuantity}
              onReassign={reassignLine}
            />

            {notice ? (
              <p
                role="status"
                className="rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
              >
                {notice}
              </p>
            ) : null}

            {/* Releasing the table (Story 3.6). Kept, but pushed to the foot of
                the order column and styled as the quiet action it should be —
                the design has no place for it, and a wrong tap here is the one
                thing on this screen that ends the sitting. */}
            <div className="mt-auto pt-sp-4">
              {confirmingWalkout ? (
                <div
                  role="alertdialog"
                  aria-label="Confirm walkout"
                  className="flex flex-col gap-sp-2 rounded-card border-2 border-unavailable-edge bg-unavailable-body p-sp-3"
                >
                  <p className="text-fs-14 font-bold text-unavailable-ink">
                    Close {displayLabel} as a walkout?
                  </p>
                  <p className="text-fs-14 text-unavailable-ink">
                    {/* Every clause label-agnostic — a counter sale has no table
                        to release. */}
                    {tableLabel ? 'This table has' : 'This order has'} {itemCount} item
                    {itemCount === 1 ? '' : 's'} nobody has paid for. Closing records the loss
                    against your name{tableLabel ? ' and releases the table' : ''}. It cannot be
                    undone.
                  </p>
                  <div className="flex gap-sp-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => closeMutation.mutate({ sessionId, reason: 'walkout' })}
                      className={cn(
                        'h-12 flex-1 rounded-control bg-unavailable-band text-fs-14 font-bold text-white',
                        'transition-transform duration-80 ease-standard active:scale-[0.97]',
                        'disabled:opacity-40 disabled:active:scale-100',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      {busy ? 'Closing…' : 'Yes, walkout'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmingWalkout(false)}
                      className={cn(
                        'h-12 flex-1 rounded-control border border-slate-200 bg-white text-fs-14 font-semibold text-slate-600',
                        'transition-transform duration-80 ease-standard active:scale-[0.97]',
                        'disabled:opacity-40 disabled:active:scale-100',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      Keep it open
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    // No confirmation for an empty table: nothing is lost. A
                    // walkout is money owed, so that one asks.
                    if (isWalkout) setConfirmingWalkout(true)
                    else closeMutation.mutate({ sessionId, reason: 'abandoned' })
                  }}
                  className={cn(
                    'h-12 w-full rounded-control border border-slate-200 bg-white',
                    'text-fs-14 font-semibold text-slate-600',
                    'transition-transform duration-80 ease-standard active:scale-[0.98]',
                    'disabled:opacity-40 disabled:active:scale-100',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  )}
                >
                  {busy
                    ? 'Closing…'
                    : isWalkout
                      ? `Close ${tableLabel ? 'table' : 'order'} — walkout`
                      : `Close ${tableLabel ? 'table' : 'order'}`}
                </button>
              )}
            </div>
          </div>

          <OrderSummary
            lineCount={lines.length}
            subtotalPaisa={subtotalPaisa}
            taxRatePercent={taxRatePercent}
          />
        </aside>
      </div>

      {sheetItem && activeSeat ? (
        <ModifierSheet
          item={sheetItem}
          seatLabel={activeSeat.seatNote ?? activeSeat.seatLabel}
          onCancel={() => setSheetItem(null)}
          onAdd={({ quantity: lineQuantity, modifierText }) => {
            stageItem(sheetItem, { quantity: lineQuantity, modifierText })
            setSheetItem(null)
          }}
        />
      ) : null}

      {/* The bar. State is derived from three facts: something staged is
          `items-added`; nothing staged with rounds sent is `submitted`; nothing
          at all is `empty`.

          Hold, Bill & split and Send are in the design and NOT here yet —
          Teran's call on 2026-09-16. Send is Story 4.5, billing is Epic 6, and
          Hold has no requirement. `onSubmitOrder` and `onGenerateBill` stay
          undefined, and the strip renders no button for an undefined handler:
          both used to render enabled and dead. */}
      <OrderActionStrip
        state={stripState}
        stagedCount={stagedItemCount}
        destinationSummary={destinationSummary}
        onClear={lines.length > 0 ? clear : undefined}
        onAddMoreItems={
          // Opening a round writes nothing: the round NUMBER is decided inside
          // Story 4.5's submit transaction.
          submittedRounds.length > 0 && lines.length === 0 ? () => setAddingMore(true) : undefined
        }
      />
    </div>
  )
}
