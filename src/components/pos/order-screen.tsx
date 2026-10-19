'use client'

import { useEffect, useState } from 'react'
import { Receipt, Users } from 'lucide-react'
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
import {
  clearStagedRound,
  resetSendId,
  sendIdForRound,
  type StagedLine,
  useStagedRound,
} from '@/components/pos/use-staged-round'
import type { MenuItemRow } from '@/app/api/menu/route'
import type { BillDetail } from '@/types/bills'
import {
  MAX_LINE_QUANTITY,
  MAX_ROUND_LINES,
  type OrderConfirmedPayload,
  type SubmitRoundRequest,
  type SubmitRoundResponse,
  type SubmittedRoundRow,
} from '@/types/orders'
import { menuQueryOptions } from '@/components/pos/menu-browser'
import { COUNTER_QUERY_KEY } from '@/components/pos/table-grid'
import { elapsedMinutesFrom, useMinuteTick } from '@/hooks/use-minute-tick'
import { useSocketEvent, useSocketRoom } from '@/hooks/use-socket'
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
  staffName: string
  /**
   * Null for a counter sale (FR64) — it sits in no zone and at no table.
   * Everything else on this screen behaves identically.
   */
  zoneName: string | null
  tableLabel: string | null
  /** Seats at the table(s), summed across a merged group. Null for a counter sale. */
  capacity: number | null
  /** Guests the party was opened with. Shown in the header line. */
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
  /** Tax rate in BASIS POINTS, converted by the page from the integer percent. */
  taxBp: number
  /** Service rate in basis points. 1000 = 10.00%. */
  serviceChargeBp: number
  /** Whether the session has tables attached, which is what earns the charge. */
  hasTableService: boolean
  /**
   * Whether this order tracks PEOPLE (Teran, 2026-10-16).
   *
   * Replaces `zoneUsesSeats(zoneName)` as the rule. `one` is a NON-SEAT order:
   * the waiter sees no seat anywhere on this screen, and the kitchen ticket
   * carries none either.
   */
  initialBillMode: 'one' | 'separate'
  /**
   * The bills this session already has, read on the server.
   *
   * Seeds the `['bills', sessionId]` query so a billed order renders its real
   * state on the FIRST paint. Without it the screen flashes `submitted` — with
   * a live "Add More Items" — for the length of one fetch, which is exactly
   * the window Story 6.2's review found a waiter using.
   *
   * Plural since Story 6.4: one bill per billed seat, plus a consolidated
   * remainder if one was generated.
   */
  initialBills: BillDetail[]
  /**
   * Whether anything on this session is still unbilled.
   *
   * Computed on the SERVER, not derived here. "Is this table finished?" is
   * `no unbilled items`, and a client-side version of that question is what
   * the 6.2 review found broken.
   */
  initialHasUnbilled: boolean
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
    // The orders route answers 404 SESSION_NOT_FOUND for an order that does not
    // exist. That is the terminal case, not a missing seat.
    if (body?.error?.code === 'SESSION_NOT_FOUND') throw new SessionGoneError('No such order')
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

/**
 * A send the server refused for a reason the waiter can act on.
 *
 * Carries the code and the extra fields (which dish, which seat, the new
 * price) so the screen can point at the line, rather than showing one generic
 * "not sent".
 */
class SendRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** `POST /api/sessions/:id/orders` — Story 4.5. */
async function sendRound(sessionId: string, body: SubmitRoundRequest): Promise<SubmitRoundResponse> {
  const response = await fetch(`/api/sessions/${sessionId}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const payload = await response.json().catch(() => null)

  if (response.ok && payload?.success) return payload.data as SubmitRoundResponse

  const error = payload?.error ?? {}
  if (error.code === 'SESSION_ALREADY_CLOSED') throw new SessionGoneError('Already closed')
  if (typeof error.code === 'string' && response.status < 500) {
    throw new SendRefusedError(error.code, error.message ?? 'The round was not sent.', error)
  }
  // 500, a proxy error page, or no body at all: the round may or may not have
  // committed. Either way the retry is safe — it reuses the same send id.
  throw new Error('The round was not sent.')
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
 * A bill the server refused for a reason the waiter can act on.
 *
 * Carries the code and `billId` where the server sent one, so "this order
 * already has a bill" can eventually open that bill rather than only saying so.
 */
class BillRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly billId: string | null,
  ) {
    super(message)
  }
}

/** `PATCH /api/sessions/:id/bill-mode` — the One bill / Separate bills switch. */
async function setBillModeRequest(
  sessionId: string,
  mode: 'one' | 'separate',
): Promise<{ movedItems: number; removedSeats: number }> {
  const response = await fetch(`/api/sessions/${sessionId}/bill-mode`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const payload = await response.json().catch(() => null)
  if (response.ok && payload?.success) {
    return payload.data as { movedItems: number; removedSeats: number }
  }
  if (payload?.error?.code === 'SESSION_ALREADY_CLOSED') {
    throw new SessionGoneError('Already closed')
  }
  throw new Error(payload?.error?.message ?? 'Could not change how this order is billed.')
}

/** `POST /api/sessions/:id/seats/:seatId/bill` — Story 6.4. */
async function billSeat(sessionId: string, seatId: string): Promise<BillDetail> {
  const response = await fetch(`/api/sessions/${sessionId}/seats/${seatId}/bill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

  if (response.status === 401) {
    const challenge = await response.json().catch(() => null)
    if (challenge?.error?.code === 'REAUTH_REQUIRED' || challenge?.error?.code === 'REAUTH_FAILED') {
      throw new BillRefusedError(
        challenge.error.code,
        challenge.error.message ?? 'This bill needs a PIN.',
        null,
      )
    }
    throw new SessionExpiredError('Session expired')
  }
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const payload = await response.json().catch(() => null)
  if (response.ok && payload?.success) return payload.data as BillDetail

  const error = payload?.error ?? {}
  if (error.code === 'SESSION_ALREADY_CLOSED') throw new SessionGoneError('Already closed')
  if (typeof error.code === 'string' && response.status < 500) {
    throw new BillRefusedError(
      error.code,
      error.message ?? 'This seat was not billed.',
      typeof error.billId === 'string' && error.billId !== '' ? error.billId : null,
    )
  }
  throw new Error('This seat was not billed.')
}

/** `POST /api/sessions/:id/bills` — Story 6.2. */
async function generateBill(sessionId: string): Promise<BillDetail> {
  const response = await fetch(`/api/sessions/${sessionId}/bills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'consolidated' }),
  })

  if (response.status === 401) {
    // 401 means two different things on this route. An expired session is
    // fixed by signing in; a re-auth challenge is not, and redirecting to the
    // PIN pad for one would throw away the order screen to ask for a PIN the
    // screen itself should be asking for. Story 2.4 owns that prompt.
    const challenge = await response.json().catch(() => null)
    if (challenge?.error?.code === 'REAUTH_REQUIRED' || challenge?.error?.code === 'REAUTH_FAILED') {
      throw new BillRefusedError(
        challenge.error.code,
        challenge.error.message ?? 'This bill needs a PIN.',
        null,
      )
    }
    throw new SessionExpiredError('Session expired')
  }
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const payload = await response.json().catch(() => null)

  if (response.ok && payload?.success) return payload.data as BillDetail

  const error = payload?.error ?? {}
  if (error.code === 'SESSION_ALREADY_CLOSED') throw new SessionGoneError('Already closed')
  if (typeof error.code === 'string' && response.status < 500) {
    throw new BillRefusedError(
      error.code,
      error.message ?? 'The bill was not generated.',
      typeof error.billId === 'string' && error.billId !== '' ? error.billId : null,
    )
  }
  throw new Error('The bill was not generated.')
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
  staffName,
  zoneName,
  taxBp,
  serviceChargeBp,
  hasTableService,
  initialBillMode,
  initialBills,
  initialHasUnbilled,
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
  // Seats only in the Tables zone (Teran, 2026-09-16). Elsewhere every dish
  // goes to the order's automatic Seat 1 and the seat section is hidden.
  /**
   * Optimistic, because the switch must feel instant on a tablet: the seat
   * chips appear on tap and the request confirms behind them. A failure
   * rolls it back and says so, rather than leaving the screen in a state the
   * server never agreed to.
   */
  const [billMode, setBillMode] = useState<'one' | 'separate'>(initialBillMode)

  /**
   * Seats are shown when the order is TRACKING PEOPLE — not when the zone says
   * so (changed 2026-10-16).
   *
   * `zoneUsesSeats(zoneName)` used to decide this. It survives only as the
   * default a NEW session starts from, which the server applies; by the time
   * this screen renders the session has already recorded its own answer.
   *
   * `one` is a non-seat order in the full sense: no chips, no seat on a line,
   * no seat column in the history, no seat in the modifier sheet, and no seat
   * line on the ticket. See `billMode` in the schema.
   */
  const usesSeats = billMode === 'separate'

  /**
   * Has this seat had anything SENT to the kitchen?
   *
   * Matched on the seat LABEL, which is what `SubmittedItemRow` carries. Only
   * decides whether to OFFER the action — the server is the authority on
   * whether the seat has anything left to bill, and answers
   * `422 SEAT_HAS_NO_ITEMS` if not.
   */
  function seatHasSentItems(seatLabel: string): boolean {
    return submittedRounds.some((round) =>
      round.items.some((item) => item.seatLabel === seatLabel),
    )
  }
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
    // Seats have no socket event. Story 4.3's review deferred one to 4.4, and
    // 4.4 did not add one either: staged items never leave the device, so there
    // was nothing to carry seats alongside. It belongs with Story 4.5, which is
    // the first story to put an order on the wire. Until then, picking up the
    // other tablet refetches — the realistic second-device case. The provider
    // disables this globally.
    refetchOnWindowFocus: true,
  })

  const [selectedSeatId, setSelectedSeatId] = useState<string | null>(null)
  const [editingSeatId, setEditingSeatId] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [confirmingSeatRemoval, setConfirmingSeatRemoval] = useState(false)
  const [seatNotice, setSeatNotice] = useState<string | null>(null)
  /** Open while asking whether to throw away the per-person grouping. */
  const [collapseConfirm, setCollapseConfirm] = useState(false)

  // DERIVED, not synced in an effect. A selection that no longer exists — the
  // seat was removed here, or on the other tablet — falls back to the first
  // seat instead of leaving the row with nothing active. Story 4.2's review
  // replaced the same shape on the category chips for the same reason: an
  // effect that writes state after render is a frame of wrong UI.
  const billQueryKey = ['bills', sessionId] as const

  /**
   * The bill this session has, from the SERVER (code review 2026-10-13).
   *
   * This was two `useState` flags set by the generate mutation. Both died on a
   * page refresh and neither existed on a second tablet, so the screen
   * re-offered "Add More Items" on an order that was already billed — and the
   * round that followed could never be put on any bill, because a session gets
   * one. The server refuses such a round now, but a button that only fails
   * when pressed is not an answer; the screen has to know before it draws.
   *
   * Seeded from the server render so there is no flash of `submitted` on an
   * already-billed order, and refetched on window focus — the tablet a waiter
   * returns to is the one most likely to be stale.
   */
  const { data: billState, error: billStateError } = useQuery({
    queryKey: billQueryKey,
    queryFn: () =>
      seatRequest<{ bills: BillDetail[]; hasUnbilled: boolean }>(
        `/api/sessions/${sessionId}/bills`,
      ),
    initialData: { bills: initialBills, hasUnbilled: initialHasUnbilled },
    refetchOnWindowFocus: true,
  })

  const sessionBills = billState.bills
  /** Seat ids that already have a bill of their own — for the seat chips. */
  const billedSeatIds = new Set(
    sessionBills.map((b) => b.seatSlotId).filter((id): id is string => id !== null),
  )
  /** A consolidated bill sweeps everything, so it closes every seat at once. */
  const hasConsolidatedBill = sessionBills.some((b) => b.seatSlotId === null)

  /** Can anything still be added to this seat? */
  function seatIsBilled(seatId: string): boolean {
    return hasConsolidatedBill || billedSeatIds.has(seatId)
  }

  // The fallback skips BILLED seats. It used to take `seats[0]`, so reloading
  // a table whose Seat 1 had paid announced "SEAT 1 SELECTED - TAPS LAND HERE"
  // and every tap staged onto a seat the server would refuse — losing the
  // whole round, including the other seats' lines (code review 2026-10-13).
  const activeSeatId = seats.some((seat) => seat.id === selectedSeatId)
    ? selectedSeatId
    : (seats.find((seat) => !seatIsBilled(seat.id))?.id ?? seats[0]?.id ?? null)
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
  const {
    lines,
    addLine,
    removeLine,
    setQuantity,
    reassignLine,
    acceptPrice,
    clear,
    clearSentLines,
  } = useStagedRound(sessionId)

  /**
   * The modifier sheet: the dish, and the seat it was opened FOR.
   *
   * The seat is captured when the sheet opens. The sheet used to read the live
   * selection, so a focus refetch that removed the selected seat silently
   * retitled the open sheet to another guest — and "Add to Order" staged the
   * dish onto them. If the captured seat disappears now, the sheet closes,
   * because `sheetSeat` below is derived and becomes null.
   */
  const [sheet, setSheet] = useState<{ item: MenuItemRow; seatId: string } | null>(null)

  /** Clear asks first when there is more than one line to lose. */
  const [confirmingClear, setConfirmingClear] = useState(false)

  /**
   * The waiter tapped "Add More Items" on a session whose rounds are all sent.
   *
   * Purely presentational: it moves the strip off `submitted` and opens an empty
   * staging area. Nothing is written, and the round NUMBER is not decided here —
   * that happens inside Story 4.5's submit transaction, because a number chosen
   * on the client is a number two tablets can choose identically.
   */
  const [addingMore, setAddingMore] = useState(false)

  const { data: submittedRounds, error: ordersError } = useQuery({
    queryKey: ['orders', sessionId],
    queryFn: () => seatRequest<SubmittedRoundRow[]>(`/api/sessions/${sessionId}/orders`),
    initialData: initialRounds,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  // The SAME query as MenuBrowser — same key, same fetcher — so this is a second
  // observer of one cache entry, not a second fetch. It used to be
  // `queryClient.getQueryData(...)`, which is a one-off read with no
  // subscription: when a socket event 86'd a dish, MenuBrowser re-rendered and
  // this screen did not, so the staged line never showed its warning.
  const { data: menu } = useQuery(menuQueryOptions)

  // Join this order's room, so a round sent from the OTHER tablet appears here
  // at once instead of on the next focus refetch. The hook re-joins after every
  // reconnect. The server only lets a waiter or owner in.
  useSocketRoom('session:subscribe', { sessionId }, 'session:unsubscribe')
  useSocketEvent<OrderConfirmedPayload>('order:confirmed', (payload) => {
    if (payload.sessionId === sessionId) {
      void queryClient.invalidateQueries({ queryKey: ['orders', sessionId] })
      // A round landing changes whether anything is left to bill, and billing
      // emits no event of its own. Without this the bill state only refreshed
      // on window focus — and a POS tablet on a stand is never blurred, so a
      // seat billed on the other tablet never reached this one.
      void queryClient.invalidateQueries({ queryKey: billQueryKey })
    }
  })

  /** Set when a SEND learns the order was closed elsewhere — terminal, like the queries. */
  const [closedDuringSend, setClosedDuringSend] = useState(false)

  // Terminal states reached through a QUERY. The mutation handler below already
  // treats a closed session as terminal; the queries use the same transport and
  // refetch on focus, so the same fact can arrive here — and used to render as
  // "Could not refresh the seats" on a screen still showing a dead order.
  const sessionClosed =
    closedDuringSend ||
    seatsError instanceof SessionGoneError ||
    ordersError instanceof SessionGoneError
  const signedOut =
    seatsError instanceof SessionExpiredError || ordersError instanceof SessionExpiredError

  /**
   * Why each staged line cannot be submitted, or nothing for the healthy ones.
   *
   * DERIVED on every render from the live seats and the live menu — not
   * recorded when the line was staged. The entire point is to notice a change
   * that happens afterwards, and both now happen in ordinary use: Story 4.3
   * added seat deletion and its review turned on `refetchOnWindowFocus`, so the
   * other tablet's removals arrive when this one is picked back up.
   *
   * Left unchecked, a stale `seat_slot_id` — or a stale `menu_item_id`, which
   * has the same kind of foreign key — reaches Story 4.5's insert and the whole
   * round is rejected with a 500.
   */
  const menuItemsById = new Map(
    (menu ?? []).flatMap((category) => category.items).map((item) => [item.id, item]),
  )
  const stagedProblems = new Map<string, StagedLineProblem>()
  for (const line of lines) {
    const lineSeat = seats.find((seat) => seat.id === line.seatSlotId)
    if (!lineSeat) {
      stagedProblems.set(line.lineId, { kind: 'seat-gone' })
      continue
    }
    // Before the menu checks: a billed seat cannot take the line whatever the
    // dish's state, and the server refuses the entire round over it.
    if (seatIsBilled(lineSeat.id)) {
      stagedProblems.set(line.lineId, { kind: 'seat-billed', seatLabel: lineSeat.seatLabel })
      continue
    }
    // `menu === undefined` means the menu has not loaded yet, which is not the
    // same as "the item is gone" — nothing is flagged on absence of knowledge.
    // Once it HAS loaded, an item that is not in it was deleted or its category
    // was switched off, and either way it cannot be ordered.
    if (!menu) continue
    const known = menuItemsById.get(line.menuItemId)
    if (!known) stagedProblems.set(line.lineId, { kind: 'item-gone' })
    else if (!known.available) stagedProblems.set(line.lineId, { kind: 'item-unavailable' })
    // The server refuses a send whose quoted price differs from the menu's
    // (Story 4.5, AC-9). Showing it here, before the tap, turns a refusal into
    // a one-tap confirmation.
    else if (known.pricePaisa !== line.pricePaisa) {
      stagedProblems.set(line.lineId, {
        kind: 'price-changed',
        currentPricePaisa: known.pricePaisa,
      })
    }
  }

  function seatName(seat: SeatSlot): string {
    return seat.seatNote ?? seat.seatLabel
  }

  function stageItem(
    item: MenuItemRow,
    seat: SeatSlot | null,
    options?: { quantity?: number; modifierText?: string },
  ) {
    // Staging against no seat would produce a line Story 4.5 could not write.
    if (!seat) {
      setSeatNotice('Add a seat before ordering.')
      return
    }
    addLine(item, { seatSlotId: seat.id, seatLabel: seatName(seat), ...options })
    // A round is being built again, so "Add More Items" has done its job.
    setAddingMore(false)
  }

  function openModifiers(item: MenuItemRow) {
    // Same rule as Add. Without it, Opts silently did nothing on a session with
    // no seat while Add explained why.
    if (!activeSeat) {
      setSeatNotice('Add a seat before ordering.')
      return
    }
    setSheet({ item, seatId: activeSeat.id })
  }

  const sheetSeat = sheet ? (seats.find((seat) => seat.id === sheet.seatId) ?? null) : null

  /**
   * What the bar says about the last send, when it did not go.
   *
   * Held WITH the round it is about. The store replaces the array on every
   * change, so `forLines === lines` is false the moment the waiter stages,
   * removes or re-seats anything — and the note disappears by itself. It used
   * to persist, so "a price has changed" stayed over a round that no longer
   * contained the dish, and the waiter was left looking for a problem they had
   * already fixed. `forLines: null` is a note about no particular round.
   */
  const [sendNote, setSendNote] = useState<{ text: string; forLines: StagedLine[] | null } | null>(
    null,
  )
  const sendNoteText =
    sendNote && (sendNote.forLines === null || sendNote.forLines === lines) ? sendNote.text : null

  /** The dish a refusal points at, by name, when the round still holds it. */
  function refusedDishName(detail: Record<string, unknown>): string | null {
    const itemId = typeof detail.itemId === 'string' ? detail.itemId : null
    if (!itemId) return null
    return lines.find((line) => line.menuItemId === itemId)?.name ?? null
  }

  const sendMutation = useMutation({
    mutationFn: async () => {
      // The same id for every retry of this exact round, a new one once the
      // round changes (Trap 5). Taken at the moment of sending, not at render.
      const submissionId = sendIdForRound(sessionId)
      // The exact lines THIS request carries, captured before it leaves. A send
      // is a network round trip and the waiter keeps working through it; what
      // comes back can only speak for these.
      const sent = lines
      const response = await sendRound(sessionId, {
        submissionId,
        lines: sent.map((line) => ({
          menuItemId: line.menuItemId,
          seatSlotId: line.seatSlotId,
          quantity: line.quantity,
          modifierText: line.modifierText,
          quotedPricePaisa: line.pricePaisa,
        })),
      })
      return { response, sentLineIds: sent.map((line) => line.lineId) }
    },
    onMutate: () => setSendNote(null),
    onSuccess: async ({ response, sentLineIds }) => {
      // History first, THEN clear the round: otherwise the column shows
      // "nothing sent, nothing staged" for the length of a refetch, and the bar
      // flickers to `empty` before it settles on `submitted`.
      await queryClient.invalidateQueries({ queryKey: ['orders', sessionId] })
      // Only what the server committed. `clearStagedRound` emptied EVERYTHING,
      // so a dish tapped while the send was in flight was thrown away with no
      // error and no undo — the guest's food simply never reached the kitchen.
      // Anything staged meanwhile stays, as the next round.
      clearSentLines(sentLineIds)
      setAddingMore(false)
      if (response.replayed) {
        // 200, not 201: this round was already on the order. Said out loud,
        // because the history gains nothing and a silent Send reads as a
        // failure — the waiter's next move would be to send it again.
        setSendNote({ text: 'Already sent — this round was on the order already.', forLines: null })
      }
      void queryClient.invalidateQueries({ queryKey: ['tables'] })
      void queryClient.invalidateQueries({ queryKey: COUNTER_QUERY_KEY })
    },
    onError: (error) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      if (error instanceof ForbiddenError) {
        setSendNote({ text: 'Your role cannot send orders.', forLines: null })
        return
      }
      if (error instanceof SessionGoneError) {
        setClosedDuringSend(true)
        return
      }
      if (error instanceof SendRefusedError) {
        // Each refusal points at something the live queries can show: refetch
        // them, and the derived line problems above flag the exact line.
        // The server says WHICH dish or seat. Naming it saves the waiter
        // hunting a long round for the one line that is flagged.
        const dish = refusedDishName(error.detail)
        switch (error.code) {
          case 'SEAT_ALREADY_BILLED':
            // The server names the seat; say which one. Without this branch it
            // fell through to a generic "not sent" and the waiter had no idea
            // which of six seats was closed.
            void queryClient.invalidateQueries({ queryKey: billQueryKey })
            setSendNote({ text: error.message, forLines: lines })
            return
          case 'SESSION_ALREADY_BILLED':
            void queryClient.invalidateQueries({ queryKey: billQueryKey })
            setSendNote({
              text: 'This order has been billed. Nothing more can be added to it.',
              forLines: null,
            })
            return
          case 'ITEM_UNAVAILABLE':
            void queryClient.invalidateQueries({ queryKey: menuQueryOptions.queryKey })
            setSendNote({
              text: dish
                ? `Not sent — ${dish} is no longer available. Take it off and send again.`
                : 'Not sent — a dish is no longer available. Take it off and send again.',
              forLines: lines,
            })
            return
          case 'PRICE_CHANGED':
            void queryClient.invalidateQueries({ queryKey: menuQueryOptions.queryKey })
            setSendNote({
              text: dish
                ? `Not sent — the price of ${dish} has changed. Accept it and send again.`
                : 'Not sent — a price has changed. Accept the new price and send again.',
              forLines: lines,
            })
            return
          case 'SEAT_NOT_FOUND':
            void queryClient.invalidateQueries({ queryKey: seatsQueryKey })
            setSendNote({
              text: 'Not sent — a dish is on a seat that was removed. Move it and send again.',
              forLines: lines,
            })
            return
          case 'SUBMISSION_ID_REUSED':
            // This send id belongs to another order's round, so every retry
            // under it is refused identically. Throw it away and the next tap
            // goes under a fresh one — the round itself is untouched and has
            // not been sent anywhere.
            resetSendId(sessionId)
            setSendNote({ text: 'Not sent — tap Send again.', forLines: null })
            return
          case 'ROUND_CONFLICT':
            setSendNote({
              text: 'Not sent — another round was sent at the same moment. Tap Send again.',
              forLines: null,
            })
            return
          default:
            setSendNote({ text: `Not sent — ${error.message}`, forLines: lines })
            return
        }
      }
      // A network failure, or a 5xx. Deliberately NOT "nothing was saved": the
      // request may have committed and lost its response. The round stays, and
      // so does its send id, so tapping Send again either sends it or is
      // answered as a replay — never a second copy in the kitchen.
      setSendNote({
        text: 'Not sure it was sent — tap Send again; it cannot be ordered twice.',
        forLines: lines,
      })
    },
  })

  /**
   * Generate Bill (Story 6.2, AC-7).
   *
   * A refusal gets the same treatment as Send's: name what happened and leave
   * the screen usable. The one exception is BILL_ALREADY_OPEN — the order IS
   * billed, so the strip moves to `settling` anyway. Leaving it on `submitted`
   * would offer a button that can only fail again.
   */
  const billMutation = useMutation({
    mutationFn: () => generateBill(sessionId),
    onMutate: () => setSendNote(null),
    onSuccess: (generated) => {
      // Refetch rather than patching the cache by hand: a consolidated bill
      // changes BOTH the list and `hasUnbilled`, and the server already knows
      // both. Patching one and guessing the other is how a screen ends up
      // disagreeing with the database.
      void queryClient.invalidateQueries({ queryKey: billQueryKey })
      void generated
      // Nothing staged can be sent now; drop it rather than strand it.
      clearRound()
      // The round history is unchanged by billing, but the session's state is
      // not, and the next thing a waiter does is settle. Refetch so anything
      // derived from the order is current when they get there.
      void queryClient.invalidateQueries({ queryKey: ['orders', sessionId] })
      void queryClient.invalidateQueries({ queryKey: ['tables'] })
      void queryClient.invalidateQueries({ queryKey: COUNTER_QUERY_KEY })
    },
    onError: (error) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      if (error instanceof ForbiddenError) {
        setSendNote({ text: 'Your role cannot generate bills.', forLines: null })
        return
      }
      if (error instanceof SessionGoneError) {
        setClosedDuringSend(true)
        return
      }
      if (error instanceof BillRefusedError) {
        if (error.code === 'BILL_ALREADY_OPEN') {
          // The order IS billed — the outcome the waiter wanted — so settle.
          // Refetch rather than guessing: the 409 carries only an id, and the
          // query returns the whole document, which is what the strip and 6.4
          // both need. This also recovers the case where a 201 committed but
          // its response never arrived, where the retry lands here.
          //
          // The message no longer says "on another device". It is equally this
          // device double-tapping, or this device retrying an unparseable 201,
          // and naming the wrong cause during an end-of-night dispute is worse
          // than naming none.
          void queryClient.invalidateQueries({ queryKey: billQueryKey })
          clearRound()
          setSendNote({ text: 'This order already has a bill.', forLines: null })
          return
        }
        if (error.code === 'NOTHING_TO_BILL') {
          setSendNote({ text: 'Nothing has been ordered yet, so there is no bill.', forLines: null })
          return
        }
        setSendNote({ text: error.message, forLines: null })
        return
      }
      setSendNote({ text: 'Could not generate the bill. Try again.', forLines: null })
    },
  })

  /**
   * Bill This Seat (Story 6.4).
   *
   * Deliberately NOT merged with `billMutation`: the two refuse for different
   * reasons and say different things. A shared handler would have to branch on
   * every code anyway, and the 6.2 review's lesson was that collapsing two
   * causes into one message is how a waiter is told the wrong thing.
   */
  const seatBillMutation = useMutation({
    mutationFn: (seatId: string) => billSeat(sessionId, seatId),
    onMutate: () => setSeatNotice(null),
    onSuccess: () => {
      // Refetch: a seat bill changes the list AND possibly `hasUnbilled` (it
      // may have been the last unbilled seat). The server knows both.
      void queryClient.invalidateQueries({ queryKey: billQueryKey })
      void queryClient.invalidateQueries({ queryKey: ['orders', sessionId] })
      void queryClient.invalidateQueries({ queryKey: ['tables'] })
    },
    onError: (error) => {
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      if (error instanceof ForbiddenError) {
        setSeatNotice('Your role cannot generate bills.')
        return
      }
      if (error instanceof SessionGoneError) {
        setClosedDuringSend(true)
        return
      }
      if (error instanceof BillRefusedError) {
        if (error.code === 'SEAT_ALREADY_BILLED') {
          // Not a failure — the outcome the waiter wanted. Refetch so the
          // chip shows it.
          void queryClient.invalidateQueries({ queryKey: billQueryKey })
          setSeatNotice('This seat already has a bill.')
          return
        }
        // Every other refusal still means this screen's picture of the bills
        // may be wrong — 422 SEAT_HAS_NO_ITEMS usually means another tablet
        // swept this seat into a consolidated bill. Refetch, or the chip keeps
        // offering a button that can only fail the same way.
        void queryClient.invalidateQueries({ queryKey: billQueryKey })
        setSeatNotice(error.message)
        return
      }
      setSeatNotice('Could not bill this seat. Try again.')
    },
  })

  /**
   * The One bill / Separate bills switch.
   *
   * Optimistic: `billMode` flips first so the chips appear on tap, and a
   * failure rolls it back. A tablet that waits for a round trip before
   * redrawing feels broken.
   */
  const billModeMutation = useMutation({
    mutationFn: (mode: 'one' | 'separate') => setBillModeRequest(sessionId, mode),
    onMutate: (mode) => {
      const previous = billMode
      setBillMode(mode)
      setSeatNotice(null)
      return { previous }
    },
    onSuccess: (result, mode) => {
      // Collapsing rewrites seats, so the seat list and the round history are
      // both stale. Say what happened: the waiter has just lost grouping work
      // and should be told, not left to notice.
      void queryClient.invalidateQueries({ queryKey: seatsQueryKey })
      void queryClient.invalidateQueries({ queryKey: ['orders', sessionId] })
      if (mode === 'one' && result.removedSeats > 0) {
        setSeatNotice(
          `Everything is on one bill now — ${result.movedItems} item${
            result.movedItems === 1 ? '' : 's'
          } moved off ${result.removedSeats} person${result.removedSeats === 1 ? '' : 's'}.`,
        )
      }
    },
    onError: (error, _mode, context) => {
      // Roll the optimistic flip back. Leaving the chips showing after a
      // failed switch is worse than never having shown them: the waiter
      // assigns items to people the server does not believe exist.
      if (context) setBillMode(context.previous)
      if (error instanceof SessionExpiredError) {
        window.location.assign('/login')
        return
      }
      if (error instanceof ForbiddenError) {
        setSeatNotice('Your role cannot change how this order is billed.')
        return
      }
      if (error instanceof SessionGoneError) {
        setClosedDuringSend(true)
        return
      }
      setSeatNotice('Could not change how this order is billed. Try again.')
    },
  })

  /**
   * Switching to One bill THROWS AWAY the grouping, so it is confirmed first —
   * but only when there is something to lose.
   *
   * Teran chose collapse-over-refuse (2026-10-16) precisely so the waiter is
   * never stuck, which makes an accidental tap the remaining risk. One
   * confirmation when people exist; none at all on the common path.
   */
  function requestBillMode(mode: 'one' | 'separate') {
    if (billModeMutation.isPending || mode === billMode) return
    if (mode === 'one' && seats.length > 1) {
      setCollapseConfirm(true)
      return
    }
    billModeMutation.mutate(mode)
  }

  function clearRound() {
    clear()
    setConfirmingClear(false)
    setAddingMore(false)
  }

  // Four facts, in priority order. Something staged → `items-added`. Nothing
  // staged but rounds already sent → `submitted`, UNLESS the waiter tapped Add
  // More Items, which asks for an empty round → `empty`. Nothing at all →
  // `empty`. `addingMore` is cleared again by the next stage or by Clear, so
  // the strip can return to `submitted`; it used to be a one-way latch.
  //
  // ── `settling` means A CONSOLIDATED BILL EXISTS (Teran, 2026-10-15) ───────
  // One bill for the whole table means the table is done. One bill for one
  // seat means that SEAT is done, and the chips say so.
  //
  // This replaced `!hasUnbilled && bills.length > 0`, which looked right and
  // froze the screen in the ordinary case: seat 1 orders a drink and pays
  // while seats 2-4 are still deciding. Every event was then billed, so
  // `hasUnbilled` was false and the strip settled — no Send, no Clear, menu
  // still on screen, and `hasUnbilled` could only become true again by SENDING,
  // which the strip no longer offered. The only way out was closing the table.
  // Both review layers found it independently.
  //
  // Accepted consequence: when every seat has been billed separately the strip
  // stays on `submitted`. The waiter closes the table, which is what they would
  // do anyway, and a late extra drink is still possible.
  //
  // The staged-round clear hangs off the SAME predicate, so dishes tapped in
  // but not yet sent can no longer be destroyed while the table is still
  // ordering — only a whole-table bill clears them.
  // Anything staged when the bill appeared can never be sent — the server
  // refuses it — and `settling` draws no Clear, so the lines had no way out
  // and came back from localStorage after a reload, ready to be sent against
  // the next sitting at this table.
  //
  // This clears the MIRROR, not React state: calling the state setters from an
  // effect cascades a render, and the two places a bill actually appears
  // during a sitting (the mutation succeeding, and the 409) call `clearRound()`
  // in their handlers where it belongs. This covers the remaining case — the
  // screen LOADING against a session that was billed elsewhere — where there
  // is no event to hang it on.
  useEffect(() => {
    if (hasConsolidatedBill) clearStagedRound(sessionId)
  }, [hasConsolidatedBill, sessionId])

  const stripState: OrderActionStripState =
    hasConsolidatedBill
      ? 'settling'
      : lines.length > 0
        ? 'items-added'
        : submittedRounds.length > 0 && !addingMore
          ? 'submitted'
          : 'empty'

  // Bigger than one send may be. The server's schema refuses the round WHOLE —
  // every line of it — so the screen stops it here and says which limit was
  // reached, instead of a 400 that names nothing. A round this size is split by
  // sending part of it and staging the rest; quantities are already capped as
  // they are staged, so an over-cap one can only come from a mirror written
  // before that cap existed.
  const overLimit =
    lines.length > MAX_ROUND_LINES || lines.some((line) => line.quantity > MAX_LINE_QUANTITY)

  // With items on the table, leaving is a walkout — money is owed and nobody
  // paid it. With nothing ordered, it is an abandonment. The server enforces
  // this too; the screen only decides which control to show.
  const isWalkout = itemCount > 0

  const closeMutation = useMutation({
    mutationFn: closeTable,
    onSuccess: () => {
      // The table is gone, so its unsent round is too. Without this every
      // closed sitting left its mirror in storage on a shared tablet.
      clearStagedRound(sessionId)
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
  // Counted by QUANTITY — "Devilled Cashew × 2" is two dishes, not one line.
  /**
   * Dishes per seat, SENT AND UNSENT (fixed 2026-10-16).
   *
   * It counted staged lines only, so a seat whose three dishes were already
   * in the kitchen read "empty" — the exact opposite of what the chip is for.
   * The chip answers "who have I not served yet", and a guest whose food has
   * been sent has very much been served.
   *
   * Sent items are matched by seat LABEL, which is what `SubmittedItemRow`
   * carries; staged lines carry the seat id.
   */
  const sentCountBySeatLabel = new Map<string, number>()
  for (const round of submittedRounds) {
    for (const item of round.items) {
      if (!item.seatLabel) continue
      sentCountBySeatLabel.set(
        item.seatLabel,
        (sentCountBySeatLabel.get(item.seatLabel) ?? 0) + item.quantity,
      )
    }
  }

  const stagedCountBySeat = new Map<string, number>()
  for (const seat of seats) {
    const sent = sentCountBySeatLabel.get(seat.seatLabel) ?? 0
    if (sent > 0) stagedCountBySeat.set(seat.id, sent)
  }
  const stagedCountByItem = new Map<string, number>()
  for (const line of lines) {
    stagedCountBySeat.set(
      line.seatSlotId,
      (stagedCountBySeat.get(line.seatSlotId) ?? 0) + line.quantity,
    )
    // The card badge counts the SELECTED seat only (Teran, 2026-09-16). It
    // used to count the whole round, so with Seat 4 selected the fish read
    // "3 · Add another" because Seats 1–3 had it — which a waiter reads as
    // "this guest already has it", while the header says SEAT 4 SELECTED.
    // On a table ordering separately that is exactly the wrong signal.
    if (line.seatSlotId === activeSeatId) {
      stagedCountByItem.set(
        line.menuItemId,
        (stagedCountByItem.get(line.menuItemId) ?? 0) + line.quantity,
      )
    }
  }
  const stagedItemCount = lines.reduce((total, line) => total + line.quantity, 0)
  /**
   * The staged round — what has NOT been sent.
   *
   * This used to be the whole of the panel's "subtotal", which meant a waiter
   * reading the total to a guest after two rounds was reading the third
   * round's price. It is now one of two halves; see `sentPaisa`.
   */
  const unsentPaisa = lines.reduce((total, line) => total + line.pricePaisa * line.quantity, 0)

  /**
   * What is already in the kitchen, priced from the committed events.
   *
   * `unitPricePaisa` is the price AS QUOTED when the round was sent, which is
   * the same figure the bill will use — a mid-service re-price must not move
   * either of them.
   */
  const sentPaisa = submittedRounds.reduce(
    (roundTotal, round) =>
      roundTotal +
      round.items.reduce(
        (itemTotal, item) => itemTotal + (item.unitPricePaisa ?? 0) * item.quantity,
        0,
      ),
    0,
  )

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

  // Covers came back here: they were on the facts card the redesign removed,
  // and nothing else on the screen says how many guests the party is.
  const coverText =
    capacity != null
      ? `${coverCount} of ${capacity} covers`
      : `${coverCount} cover${coverCount === 1 ? '' : 's'}`
  const contextLine = [
    zoneName ?? 'Counter sale',
    coverText,
    elapsedMinutes !== undefined ? `open ${elapsed(elapsedMinutes)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // `minuteTick` is 0 during SSR, so the clock renders empty on the server and
  // fills in on hydration rather than mismatching.
  const clock = minuteTick === 0 ? '' : clockTime(new Date(minuteTick).toISOString())

  if (sessionClosed || signedOut) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-sp-4 bg-slate-100 p-sp-5 text-center">
        <p className="text-fs-24 font-extrabold tracking-title text-slate-900">
          {sessionClosed ? `${displayLabel} was closed on another device` : 'You were signed out'}
        </p>
        <p className="text-fs-16 text-slate-600">
          {sessionClosed
            ? 'Nothing on this screen can be sent. Anything not yet sent from this tablet was not saved to the order.'
            : 'Sign in again to carry on. Anything not yet sent is still on this tablet.'}
        </p>
        <button
          type="button"
          onClick={() => {
            if (sessionClosed) {
              clearStagedRound(sessionId)
              void queryClient.invalidateQueries({ queryKey: ['tables'] })
              router.push('/')
            } else {
              window.location.assign('/login')
            }
          }}
          className={cn(
            'h-touch-waiter rounded-waiter bg-brand-800 px-sp-6 text-fs-18 font-bold text-white shadow-el-2',
            'transition-transform duration-80 ease-standard active:scale-[0.97]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          )}
        >
          {sessionClosed ? 'Back to the floor plan' : 'Sign in'}
        </button>
      </div>
    )
  }

  // Flex column pinned to the viewport on tablet and up, so the header and the
  // bar stay put and each column scrolls inside itself. `sticky bottom-0` alone
  // cannot pin the bar — sticky only shifts an element toward its edge from its
  // static position. The floor screen hit that exact problem.
  return (
    // `slate-100` is the system's app background.
    <div className="flex min-h-dvh flex-col bg-slate-100 md:h-dvh">
      <OrderHeader
        zoneName={zoneName}
        tableLabel={displayLabel}
        contextLine={contextLine}
        // "SEAT 1 SELECTED — TAPS LAND HERE" only means something where the
        // waiter chooses the seat.
        activeSeatLabel={
          usesSeats && activeSeat ? (activeSeat.seatNote ?? activeSeat.seatLabel) : null
        }
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
        {/* 2 : 1 — the menu takes two thirds and the order column one third.
            Measured off the 2026-10-16 design: the right panel runs x=668 to
            x=1002 on a 1002px canvas, which is exactly a third. It was 3 : 1
            (Teran, 2026-09-16), and at that ratio the order column could not
            hold a line name, its price and a stepper without wrapping.

            Flex growth with a zero basis, so the ratio holds at every width;
            `min-w-80` stops the order column being squeezed below what four
            seat buttons need on a small tablet. */}
        <main className="flex min-h-0 flex-1 flex-col p-sp-4 md:min-w-0 md:flex-[2_2_0%]">
          <MenuBrowser
            onAdd={(item) => stageItem(item, activeSeat)}
            onOpenModifiers={openModifiers}
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
          {/* Capped at 45% of the column and scrollable. With eight seats, the
              note editor and a removal confirmation open, an uncapped section
              squeezed the round to zero height and pushed the total off-screen. */}
          {/* ── One bill / Separate bills (Teran, 2026-10-16) ───────────────
              The first question of the order, so it sits above everything the
              answer changes. It replaced `zoneUsesSeats` — the zone used to
              decide, and now the waiter does.

              Two real buttons rather than a toggle switch: a switch has an
              implied "off", and neither of these is off. The copy underneath
              says what the choice MEANS, because "One bill" and "Separate
              bills" both sound reasonable to someone who has not thought about
              it yet. */}
          <section className="flex shrink-0 flex-col gap-sp-2 border-b border-slate-200 p-sp-4">
            {/* ONE segmented control in a tinted trough, not two separate
                buttons: the design treats these as two states of a single
                choice, and the selected one is a raised white card inside the
                group. Two bordered buttons read as two independent actions. */}
            <div
              role="group"
              aria-label="How this order is billed"
              className="flex gap-sp-1 rounded-waiter bg-slate-100 p-sp-1"
            >
              {([
                { mode: 'one' as const, icon: Receipt, label: 'One bill' },
                { mode: 'separate' as const, icon: Users, label: 'Separate bills' },
              ]).map(({ mode, icon: Icon, label }) => {
                const active = billMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    disabled={billModeMutation.isPending}
                    onClick={() => requestBillMode(mode)}
                    className={cn(
                      'flex h-touch-kitchen flex-1 items-center justify-center gap-sp-2 rounded-control',
                      'text-fs-16 font-bold transition-[transform,box-shadow] duration-120 ease-standard',
                      'active:scale-[0.97] disabled:opacity-60',
                      'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500',
                      active
                        ? 'bg-white text-brand-800 shadow-el-1'
                        : 'text-slate-600',
                    )}
                  >
                    <Icon aria-hidden="true" strokeWidth={2.2} className="size-5 shrink-0" />
                    {label}
                  </button>
                )
              })}
            </div>
            <p className="text-fs-12 font-semibold text-slate-600">
              {billMode === 'one'
                ? 'Everything goes on one table bill. If guests later pay separately, split it on the bill screen.'
                : 'Each item is tagged to a person, and each person gets their own bill.'}
            </p>
          </section>

          {/* Shown only while the order is TRACKING PEOPLE — or when it somehow
              has no seat at all, which only a session from before migration
              0013 could have. Without that second case nothing could be staged
              and there would be no way to add the seat that fixes it. */}
          {usesSeats || seats.length === 0 ? (
          <>
          {/* Only the seat GRID lives in the height-capped, scrollable section.
              The note editor used to live in it too: opening the editor made
              the section scroll, the scrollbar (~15px on Windows) narrowed the
              auto-fill grid, it dropped a column, and every seat button jumped
              wider. Reserving the scrollbar space made them permanently wider
              instead. With the editor outside, a tap on the pencil never adds a
              scrollbar and the buttons keep their size. */}
          <section className="flex shrink-0 flex-col gap-sp-3 border-b border-slate-200 p-sp-4 md:max-h-[45%] md:overflow-y-auto">
            <SeatSelector
              seats={seats}
              activeSeatId={activeSeatId}
              // A consolidated bill sweeps every unbilled item, so it closes
              // every seat at once even though no seat has a bill of its own.
              billedSeatIds={
                hasConsolidatedBill ? new Set(seats.map((seat) => seat.id)) : billedSeatIds
              }
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

            {/* ── Bill This Seat (Story 6.4, AC-12) ──────────────────────────
                Only where seats MEAN something. Bean Bags, Sun Beds, Rooftop
                and counter sales hide the seat section entirely and every item
                lands on Seat 1, so "split by seat" there is a control that can
                only confuse — `deferred-work.md` assigns that call to this
                story by name.

                Hidden rather than disabled once the seat is billed: the action
                no longer applies, and a greyed button invites the waiter to
                wonder what would un-grey it (the rule the action strip follows
                for Submit). */}
            {usesSeats && activeSeat && !hasConsolidatedBill && !billedSeatIds.has(activeSeat.id)
              && seatHasSentItems(activeSeat.seatLabel) ? (
              <button
                type="button"
                disabled={seatBillMutation.isPending}
                onClick={() => seatBillMutation.mutate(activeSeat.id)}
                className={cn(
                  'h-touch-waiter w-full rounded-waiter border-2 border-brand-500 bg-white',
                  'text-fs-18 font-bold text-brand-700 shadow-el-1',
                  'transition-transform duration-80 ease-standard active:scale-[0.97]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  'disabled:opacity-60',
                )}
              >
                {seatBillMutation.isPending
                  ? 'Billing…'
                  : `Bill ${activeSeat.seatLabel}`}
              </button>
            ) : null}
          </section>

          {/* The note editor and seat notices, uncapped. `empty:hidden` drops
              the wrapper — and its border — when neither is showing. */}
          <div className="flex shrink-0 flex-col gap-sp-3 border-b border-slate-200 p-sp-4 empty:hidden">
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
                      'h-touch-kitchen rounded-control border border-slate-200 bg-white px-sp-3',
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
                          'h-touch-kitchen flex-1 rounded-control bg-unavailable-band text-fs-14 font-bold text-white',
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
                          'h-touch-kitchen flex-1 rounded-control border border-slate-200 bg-white text-fs-14 font-semibold text-slate-600',
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
                        'h-touch-kitchen flex-1 rounded-control bg-brand-800 text-fs-14 font-bold text-white',
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
                        'h-touch-kitchen flex-1 rounded-control border border-slate-200 bg-white text-fs-14 font-semibold text-slate-600',
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
                          'h-touch-kitchen shrink-0 rounded-control border border-unavailable-edge bg-white px-sp-3',
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
            {seatNotice || seatsError || ordersError || billStateError ? (
              <p
                role="status"
                className="rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
              >
                {seatNotice ??
                  (seatsError
                    ? 'Could not refresh the seats. Reopen the order to retry.'
                    : ordersError
                      ? 'Could not refresh what has been sent. Reopen the order to retry.'
                      : // The bills query failing used to be swallowed entirely:
                        // only `data` was destructured, so the screen ran on the
                        // server-rendered snapshot indefinitely and could keep
                        // showing a seat as unbilled after it had been paid.
                        'Could not refresh the bills. Reopen the order to retry.')}
              </p>
            ) : null}
          </div>
          </>
          ) : seatNotice ? (
            // With the seat section hidden, its notice still needs somewhere to go.
            <p
              role="status"
              className="m-sp-4 mb-0 rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
            >
              {seatNotice}
            </p>
          ) : null}

          {/* The round. Scrolls on its own; the seats above and the total below
              stay put. History sits ABOVE the unsent lines (AC-6). */}
          <div className="flex min-h-0 flex-1 flex-col gap-sp-3 overflow-y-auto p-sp-4">
            <RoundHistory rounds={submittedRounds} showSeats={usesSeats} />

            <StagedRoundList
              showSeats={usesSeats}
              lines={lines}
              seats={seats}
              problems={stagedProblems}
              onRemove={removeLine}
              onSetQuantity={setQuantity}
              onReassign={(lineId, seat) => reassignLine(lineId, seat.id, seatName(seat))}
              onAcceptPrice={acceptPrice}
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
                        'h-touch-kitchen flex-1 rounded-control bg-unavailable-band text-fs-14 font-bold text-white',
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
                        'h-touch-kitchen flex-1 rounded-control border border-slate-200 bg-white text-fs-14 font-semibold text-slate-600',
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
                    'h-touch-kitchen w-full rounded-control border border-slate-200 bg-white',
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

          {confirmingClear ? (
            <div
              role="alertdialog"
              aria-label="Confirm clearing the round"
              className="flex shrink-0 flex-col gap-sp-2 border-t-2 border-unavailable-edge bg-unavailable-body p-sp-4"
            >
              {/* Nothing staged is in the database, so nothing can bring these
                  back. One tap used to discard the whole round. */}
              <p className="text-fs-14 font-bold text-unavailable-ink">
                Clear all {stagedItemCount} unsent items? This cannot be undone.
              </p>
              <div className="flex gap-sp-2">
                <button
                  type="button"
                  onClick={clearRound}
                  className={cn(
                    'h-touch-kitchen flex-1 rounded-control bg-unavailable-band text-fs-14 font-bold text-white',
                    'transition-transform duration-80 ease-standard active:scale-[0.97]',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  )}
                >
                  Yes, clear
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingClear(false)}
                  className={cn(
                    'h-touch-kitchen flex-1 rounded-control border border-slate-200 bg-white text-fs-14 font-semibold text-slate-600',
                    'transition-transform duration-80 ease-standard active:scale-[0.97]',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  )}
                >
                  Keep them
                </button>
              </div>
            </div>
          ) : null}

          <OrderSummary
            sentPaisa={sentPaisa}
            unsentPaisa={unsentPaisa}
            serviceChargeBp={serviceChargeBp}
            taxBp={taxBp}
            hasTableService={hasTableService}
          />
        </aside>
      </div>

      {/* Switching to One bill destroys the per-person grouping (Teran chose
          collapse over refuse, 2026-10-16), so it is confirmed — but only when
          there is something to lose. */}
      {collapseConfirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="collapse-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
        >
          <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2">
            <h2 id="collapse-title" className="text-fs-20 font-extrabold text-slate-900">
              Put everything on one bill?
            </h2>
            <p className="text-fs-16 text-slate-600">
              {seats.length} people have items on this order. They will all move onto one bill, and
              who ordered what will be lost. Switching back will not bring it back.
            </p>
            <div className="flex gap-sp-3">
              <button
                type="button"
                onClick={() => setCollapseConfirm(false)}
                className={cn(
                  'h-touch-waiter flex-1 rounded-waiter border border-slate-200 bg-white',
                  'text-fs-18 font-bold text-slate-900 shadow-el-1 active:scale-[0.97]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                )}
              >
                Keep separate
              </button>
              <button
                type="button"
                onClick={() => {
                  setCollapseConfirm(false)
                  billModeMutation.mutate('one')
                }}
                className={cn(
                  'h-touch-waiter flex-1 rounded-waiter bg-brand-800 text-fs-18 font-bold text-white',
                  'shadow-el-2 active:scale-[0.97]',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                )}
              >
                One bill
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {sheet && sheetSeat ? (
        <ModifierSheet
          // Keyed so a different dish or seat is a fresh sheet, never a reused
          // one with the previous quantity and note still in it.
          key={`${sheet.item.id}:${sheetSeat.id}`}
          item={sheet.item}
          // Where the waiter never chose a seat, naming one is noise.
          seatLabel={usesSeats ? seatName(sheetSeat) : null}
          onCancel={() => setSheet(null)}
          onAdd={({ quantity: lineQuantity, modifierText }) => {
            stageItem(sheet.item, sheetSeat, { quantity: lineQuantity, modifierText })
            setSheet(null)
          }}
        />
      ) : null}

      {/* The bar. Its state is `stripState` above — four facts, including the
          Add More Items override.

          Send and Generate Bill are both live (Stories 4.5, 6.2). Split (6.1)
          and Hold (no requirement) are still absent, and the strip renders no
          button for an undefined handler.

          While any staged line has a problem the Send button stays but is
          disabled, and the bar says why — the server would refuse the round,
          and a Send that silently did nothing would be worse. */}
      <OrderActionStrip
        state={stripState}
        stagedCount={stagedItemCount}
        destinationSummary={destinationSummary}
        busy={sendMutation.isPending || billMutation.isPending}
        sendBlocked={stagedProblems.size > 0 || overLimit}
        note={
          stagedProblems.size > 0
            ? `Fix ${stagedProblems.size} item${stagedProblems.size === 1 ? '' : 's'} before sending.`
            : overLimit
              ? lines.length > MAX_ROUND_LINES
                ? `Too many items to send at once (${MAX_ROUND_LINES} maximum). Send some now and the rest after.`
                : `One line is over ${MAX_LINE_QUANTITY}. Lower it and send again.`
              : (sendNoteText ?? undefined)
        }
        onSubmitOrder={lines.length > 0 ? () => sendMutation.mutate() : undefined}
        onGenerateBill={() => billMutation.mutate()}
        // Clear left the main row for the More menu (2026-10-16 design): it
        // throws away a round the waiter has just typed and sat one tap from
        // Send at the same size.
        moreItems={[
          ...(lines.length > 0
            ? [
                {
                  label: `Clear ${stagedItemCount} unsent item${stagedItemCount === 1 ? '' : 's'}`,
                  onClick: () =>
                    lines.length === 1 ? clearRound() : setConfirmingClear(true),
                  danger: true,
                },
              ]
            : []),
          {
            label: isWalkout ? 'Close table — walkout' : 'Close table',
            onClick: () => setConfirmingWalkout(true),
            danger: true,
          },
        ]}
        onAddMoreItems={
          // Opening a round writes nothing: the round NUMBER is decided inside
          // Story 4.5's submit transaction.
          submittedRounds.length > 0 && lines.length === 0 ? () => setAddingMore(true) : undefined
        }
      />
    </div>
  )
}
