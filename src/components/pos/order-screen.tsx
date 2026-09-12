'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ContextHeader } from '@/components/pos/context-header'
import { MenuBrowser } from '@/components/pos/menu-browser'
import { OrderActionStrip } from '@/components/pos/order-action-strip'
import { SeatChipRow, type SeatSlot } from '@/components/pos/seat-chip-row'
import { elapsedMinutesFrom, useMinuteTick } from '@/hooks/use-minute-tick'
import { signOut } from '@/lib/auth-client'
import { elapsed } from '@/lib/format'
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
   * Every session has at least one — both open paths create Seat 1 in the same
   * transaction that creates the session — so this is never empty for a live
   * session, and the screen has no "no seats" state to design around.
   */
  seats: SeatSlot[]
}

/** A memory aid, not a description. Matches the routes' cap. */
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
 * A 409 from a seat route, carrying the server's own words.
 *
 * The seat conflicts are the two a waiter has to act on — "this is the only
 * seat on the order" and "this seat has 4 items on it" — and only the server
 * can count. A generic "could not remove the seat" would leave them tapping it
 * again, which is why the message travels rather than the status alone.
 */
class SeatConflictError extends Error {}

/** Shared transport for the three seat calls. Same auth handling as `closeTable`. */
async function seatRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)

  if (response.status === 401) throw new SessionExpiredError('Session expired')
  if (response.status === 403) throw new ForbiddenError('Role not permitted')

  const body = await response.json().catch(() => null)

  if (response.status === 409) {
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
 * Order entry screen — placeholder body, real chrome.
 *
 * Epic 4 replaces everything below the header with the menu browser, seat slots
 * and OrderActionStrip. What is real here is the navigation target, the
 * breadcrumb, and the session facts — enough that Story 3.3's session has
 * somewhere coherent to land, and enough to verify the session was actually
 * created with the right attribution.
 */
export function OrderScreen({
  sessionId,
  restaurantName,
  staffName,
  zoneName,
  tableLabel,
  capacity,
  coverCount,
  openedAt,
  itemCount,
  seats: initialSeats,
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
  const { data: seats } = useQuery({
    queryKey: seatsQueryKey,
    queryFn: () => seatRequest<SeatSlot[]>(`/api/sessions/${sessionId}/seats`),
    initialData: initialSeats,
    staleTime: 30_000,
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
      if (error instanceof SeatConflictError) {
        setSeatNotice(error.message)
        return
      }
      setSeatNotice(fallback)
    }
  }

  const addSeatMutation = useMutation({
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

  // Flex column with a flex-1 main, so the strip sits at the BOTTOM of the
  // viewport on a short screen. `sticky bottom-0` alone cannot do it — sticky
  // only shifts an element toward its edge from its static position, it never
  // pushes it down to fill min-h-screen. The floor screen hit this exact problem
  // and the fix is the same one.
  return (
    <div className="flex min-h-screen flex-col">
      <ContextHeader
        restaurantName={restaurantName}
        staffName={staffName}
        zoneName={zoneName}
        tableLabel={displayLabel}
        // Both levels lead back to the floor plan for now. Story 3.4's zone view
        // is what gives 'zone' a distinct destination; until it exists, sending
        // a waiter to a route that does not exist would be worse than sending
        // them somewhere useful.
        onNavigate={() => router.push('/')}
        // Without this the header draws a 44px control announced as "Switch
        // user" that does nothing — the exact defect the grid's review caught
        // and this screen reintroduced one file over. It is also the only way
        // off this screen for a waiter ending a shift.
        onStaffTap={signOut}
      />

      <main className="flex flex-1 flex-col gap-sp-4 p-sp-4">
        <section className="flex flex-col gap-sp-3 rounded-card border border-slate-200 bg-white p-sp-4 shadow-el-1">
          <h1 className="text-fs-24 font-extrabold tracking-title text-slate-900">
            {displayLabel}
          </h1>

          <dl className="flex flex-wrap gap-sp-5">
            <div className="flex flex-col gap-sp-1">
              {/* The LABEL changes too. Making only the value null-safe produced
                  "Zone: No table", which is not an answer to the question asked
                  — and the heading one section up already says "Counter". */}
              <dt className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
                {zoneName ? 'Zone' : 'Type'}
              </dt>
              <dd className="text-fs-16 font-semibold text-slate-900">
                {zoneName ?? 'Counter sale'}
              </dd>
            </div>

            <div className="flex flex-col gap-sp-1">
              <dt className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
                Open for
              </dt>
              <dd className="text-fs-16 font-semibold tabular-nums text-slate-900">
                {elapsedMinutes !== undefined ? elapsed(elapsedMinutes) : '—'}
              </dd>
            </div>

            <div className="flex flex-col gap-sp-1">
              <dt className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
                Covers
              </dt>
              <dd className="text-fs-16 font-semibold tabular-nums text-slate-900">
                {coverCount}
                {capacity != null ? (
                  <span className="text-fs-12 text-slate-600"> of {capacity} seats</span>
                ) : null}
              </dd>
            </div>
          </dl>
        </section>

        {/* The party (FR10). Above the menu because it is the question that
            precedes every tap on it — "who is this for?" — and because a chip
            row that scrolled away with the dishes would send items to whichever
            seat happened to be active twenty rows ago.

            `shrink-0` so the row keeps its height when the menu below it is
            long. Without it the flex parent steals from here first and the
            chips collapse to a sliver. */}
        <section className="flex shrink-0 flex-col gap-sp-2" aria-label="Seats">
          <SeatChipRow
            seats={seats}
            activeSeatId={activeSeatId}
            busy={seatBusy}
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
            <div className="flex flex-col gap-sp-3 rounded-card border border-slate-200 bg-white p-sp-3 shadow-el-1">
              <label className="flex flex-col gap-sp-1">
                <span className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
                  Note for {activeSeat.seatLabel} — staff only
                </span>
                <input
                  type="text"
                  value={noteDraft}
                  maxLength={MAX_SEAT_NOTE}
                  placeholder="red shirt, curly hair, bald man…"
                  onChange={(event) => setNoteDraft(event.target.value)}
                  className={cn(
                    'h-touch-waiter rounded-control border border-slate-200 bg-white px-sp-3',
                    'text-fs-16 text-slate-900 placeholder:text-slate-600',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  )}
                />
              </label>

              {/* Said out loud, because the person who types it is the person
                  who would otherwise assume it prints. Epic 6 enforces it where
                  the bill is built; this is the promise, not the mechanism. */}
              <p className="text-fs-12 text-slate-600">
                Shown to staff and on kitchen tickets so the runner finds the right person. Never
                printed on a guest&apos;s bill.
              </p>

              {confirmingSeatRemoval ? (
                <div className="flex flex-col gap-sp-2 rounded-control border-2 border-unavailable-edge bg-unavailable-body p-sp-3">
                  <p className="text-fs-14 font-bold text-unavailable-ink">
                    Remove {activeSeat.seatLabel}? A seat cannot be brought back — a new one gets a
                    new number.
                  </p>
                  <div className="flex gap-sp-3">
                    <button
                      type="button"
                      disabled={seatBusy}
                      onClick={() => removeSeatMutation.mutate(activeSeat.id)}
                      className={cn(
                        'h-touch-waiter flex-1 rounded-waiter text-fs-16 font-bold tracking-title',
                        'bg-unavailable-band text-white shadow-el-2 inset-shadow-top',
                        'transition-[transform,box-shadow] duration-80 ease-standard',
                        'active:scale-[0.97] active:shadow-pressed',
                        'disabled:opacity-40 disabled:active:scale-100',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      {removeSeatMutation.isPending ? 'Removing…' : 'Yes, remove'}
                    </button>
                    <button
                      type="button"
                      disabled={seatBusy}
                      onClick={() => setConfirmingSeatRemoval(false)}
                      className={cn(
                        'h-touch-waiter flex-1 rounded-waiter text-fs-16 font-semibold',
                        'border border-slate-200 bg-white text-slate-600 shadow-el-1',
                        'transition-[transform,box-shadow] duration-80 ease-standard',
                        'active:scale-[0.97] active:shadow-pressed',
                        'disabled:opacity-40 disabled:active:scale-100',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-sp-3">
                  <button
                    type="button"
                    disabled={seatBusy}
                    onClick={() =>
                      updateNoteMutation.mutate({ seatId: activeSeat.id, seatNote: noteDraft })
                    }
                    className={cn(
                      'h-touch-waiter flex-1 rounded-waiter text-fs-16 font-bold tracking-title',
                      'bg-brand-700 text-white shadow-el-2 inset-shadow-top',
                      'transition-[transform,box-shadow] duration-80 ease-standard',
                      'active:scale-[0.97] active:shadow-pressed',
                      'disabled:opacity-40 disabled:active:scale-100',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                    )}
                  >
                    {updateNoteMutation.isPending ? 'Saving…' : 'Save note'}
                  </button>
                  <button
                    type="button"
                    disabled={seatBusy}
                    onClick={closeSeatEditor}
                    className={cn(
                      'h-touch-waiter flex-1 rounded-waiter text-fs-16 font-semibold',
                      'border border-slate-200 bg-white text-slate-600 shadow-el-1',
                      'transition-[transform,box-shadow] duration-80 ease-standard',
                      'active:scale-[0.97] active:shadow-pressed',
                      'disabled:opacity-40 disabled:active:scale-100',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                    )}
                  >
                    Done
                  </button>
                  {/* Only offered when there is another seat to fall back on.
                      The server refuses the last one either way (AC-6) — this
                      just stops the waiter finding that out by being told no. */}
                  {seats.length > 1 ? (
                    <button
                      type="button"
                      disabled={seatBusy}
                      onClick={() => setConfirmingSeatRemoval(true)}
                      className={cn(
                        'h-touch-waiter shrink-0 rounded-waiter px-sp-4 text-fs-16 font-semibold',
                        'border border-unavailable-edge bg-white text-unavailable-ink shadow-el-1',
                        'transition-[transform,box-shadow] duration-80 ease-standard',
                        'active:scale-[0.97] active:shadow-pressed',
                        'disabled:opacity-40 disabled:active:scale-100',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      Remove seat
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {seatNotice ? (
            <p
              role="status"
              className="rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
            >
              {seatNotice}
            </p>
          ) : null}
        </section>

        {/* Replaced the Epic 4 placeholder. Seat slots (4.3), modifiers and
            staging (4.4) and submission (4.5) still land above and below this;
            the menu itself is the part FR7 covers.

            `flex-1 min-h-0` so the MENU scrolls inside itself rather than the
            page growing with it. Two things broke when it did: the search field
            — which the design calls the primary navigation path — scrolled off
            the top after about two rows, and "Close table" ended up beneath every
            dish on a 100+ item menu. `min-h-0` is what lets a flex child actually
            shrink below its content. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <MenuBrowser />
        </div>

        {notice ? (
          <p
            role="status"
            className="rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
          >
            {notice}
          </p>
        ) : null}

        {/* Releasing the table. Until this existed a wrong tap was permanent —
            the only close in the plan was a side effect of full payment, which
            a table with no orders can never reach. */}
        <section className="flex flex-col gap-sp-3">
          {confirmingWalkout ? (
            <div
              role="alertdialog"
              aria-label="Confirm walkout"
              className="flex flex-col gap-sp-3 rounded-card border-2 border-unavailable-edge bg-unavailable-body p-sp-4"
            >
              <p className="text-fs-16 font-bold text-unavailable-ink">
                Close {displayLabel} as a walkout?
              </p>
              <p className="text-fs-14 text-unavailable-ink">
                {/* Every clause, not just the first. The heading and this
                    sentence's opening were made label-agnostic in the counter
                    sale story; "releases the table" one line later was not, so
                    the irreversible, money-recorded confirmation told a waiter
                    it would do something a counter sale cannot. */}
                {tableLabel ? 'This table has' : 'This order has'} {itemCount} item
                {itemCount === 1 ? '' : 's'} on it that nobody has paid for. Closing records the
                loss against your name{tableLabel ? ' and releases the table' : ''}. It cannot be
                undone.
              </p>
              <div className="flex gap-sp-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => closeMutation.mutate({ sessionId, reason: 'walkout' })}
                  className={cn(
                    'h-touch-waiter flex-1 rounded-waiter text-fs-16 font-bold tracking-title',
                    'bg-unavailable-band text-white shadow-el-2 inset-shadow-top',
                    'transition-[transform,box-shadow] duration-80 ease-standard',
                    'active:scale-[0.97] active:shadow-pressed',
                    'disabled:opacity-40 disabled:active:scale-100',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  )}
                >
                  {busy ? 'Closing…' : 'Yes, close as walkout'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingWalkout(false)}
                  className={cn(
                    'h-touch-waiter flex-1 rounded-waiter text-fs-16 font-semibold',
                    'border border-slate-200 bg-white text-slate-600 shadow-el-1',
                    'transition-[transform,box-shadow] duration-80 ease-standard',
                    'active:scale-[0.97] active:shadow-pressed',
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
                // No confirmation for an empty table: nothing is lost, and the
                // whole point is that a wrong tap is cheap to undo. A walkout
                // is money owed, so that one asks.
                if (isWalkout) setConfirmingWalkout(true)
                else closeMutation.mutate({ sessionId, reason: 'abandoned' })
              }}
              className={cn(
                'h-touch-waiter w-full rounded-waiter text-fs-16 font-semibold',
                'border border-slate-200 bg-white text-slate-600 shadow-el-1',
                'transition-[transform,box-shadow] duration-80 ease-standard',
                'active:scale-[0.97] active:shadow-pressed',
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
        </section>
      </main>

      {/* Driven by whether the session HAS items, not hardcoded.
          `state="empty"` was a constant, so a session with four items rendered
          "This order has 4 items on it that nobody has paid for" directly above
          a strip announcing "Nothing staged yet" — inside an `aria-live` region,
          so a screen-reader user heard the false one.

          `stagedCount` stays 0: these are SUBMITTED items, not a staged round.
          Story 4.4 owns staging and will pass the real count. Until then
          `items-added` with nothing staged renders "Nothing staged yet" with an
          inert commit, which is true of both facts at once.

          "Close table" deliberately stays in the body above this. It belongs to
          Story 3.6's flow with its walkout confirmation, and moving it into the
          strip would put it in a fight with Epic 6's settlement states for the
          same space. Revisit in 6.5. */}
      <OrderActionStrip state={itemCount > 0 ? 'items-added' : 'empty'} />
    </div>
  )
}
