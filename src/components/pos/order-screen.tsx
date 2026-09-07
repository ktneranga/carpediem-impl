'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ContextHeader } from '@/components/pos/context-header'
import { elapsedMinutesFrom, useMinuteTick } from '@/hooks/use-minute-tick'
import { signOut } from '@/lib/auth-client'
import { elapsed } from '@/lib/format'
import { cn } from '@/lib/utils'

export type OrderScreenProps = {
  tableId: string
  restaurantName: string
  staffName: string
  zoneName: string
  tableLabel: string
  capacity: number | null
  coverCount: number
  /** ISO timestamp from PostgreSQL. Elapsed time is derived client-side. */
  openedAt: string
  /** Decides which close reason applies. Zero until Epic 4 adds order entry. */
  itemCount: number
}

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

async function closeTable(input: { tableId: string; reason: 'abandoned' | 'walkout' }) {
  const response = await fetch(`/api/tables/${input.tableId}/sessions/close`, {
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
  tableId,
  restaurantName,
  staffName,
  zoneName,
  tableLabel,
  capacity,
  coverCount,
  openedAt,
  itemCount,
}: OrderScreenProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const minuteTick = useMinuteTick()
  const elapsedMinutes = elapsedMinutesFrom(openedAt, minuteTick)

  const [isNavigating, setIsNavigating] = useState(false)
  const [confirmingWalkout, setConfirmingWalkout] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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

  return (
    <div className="min-h-screen">
      <ContextHeader
        restaurantName={restaurantName}
        staffName={staffName}
        zoneName={zoneName}
        tableLabel={tableLabel}
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

      <main className="flex flex-col gap-sp-4 p-sp-4">
        <section className="flex flex-col gap-sp-3 rounded-card border border-slate-200 bg-white p-sp-4 shadow-el-1">
          <h1 className="text-fs-24 font-extrabold tracking-title text-slate-900">
            {tableLabel}
          </h1>

          <dl className="flex flex-wrap gap-sp-5">
            <div className="flex flex-col gap-sp-1">
              <dt className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
                Zone
              </dt>
              <dd className="text-fs-16 font-semibold text-slate-900">{zoneName}</dd>
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

        <section
          className="rounded-card border border-dashed border-slate-200 bg-slate-100 p-sp-5"
          aria-label="Order entry placeholder"
        >
          <p className="text-fs-16 font-semibold text-slate-900">
            The table is open and the session is recorded.
          </p>
          <p className="mt-sp-2 text-fs-14 text-slate-600">
            Order entry — menu browsing, seat slots, modifiers and the action strip — is built in
            Epic 4. Everything ordered here will attach to this session.
          </p>
        </section>

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
                Close {tableLabel} as a walkout?
              </p>
              <p className="text-fs-14 text-unavailable-ink">
                This table has {itemCount} item{itemCount === 1 ? '' : 's'} on it that nobody has
                paid for. Closing records the loss against your name and releases the table. It
                cannot be undone.
              </p>
              <div className="flex gap-sp-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => closeMutation.mutate({ tableId, reason: 'walkout' })}
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
                else closeMutation.mutate({ tableId, reason: 'abandoned' })
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
              {busy ? 'Closing…' : isWalkout ? 'Close table — walkout' : 'Close table'}
            </button>
          )}
        </section>
      </main>
    </div>
  )
}
