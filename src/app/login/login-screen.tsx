'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Users } from 'lucide-react'
import { PINPad } from '@/components/pos/pin-pad'
import { LAST_STAFF_KEY, safeReturnPath } from '@/lib/return-to'

/** What the floor is doing right now, read by the page on the server. */
export type FloorNow = {
  /** Every order not closed yet: tables (a merged group is one) and bar tabs. */
  ongoingOrders: number
}

export function LoginScreen({ floor }: { floor: FloorNow | null }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // The screen waits for hours between sign-ins: re-read the floor so the
  // figures stay current (Teran, 2026-11-16).
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 30_000)
    return () => window.clearInterval(timer)
  }, [router])

  const handleSubmit = useCallback(async (pin: string) => {
    // The PINPad has already wiped its own state by the time this runs. Nothing
    // here stores, logs, or re-renders the PIN — it exists only as this argument
    // and inside the request body (NFR-S1).
    setIsSubmitting(true)
    setError(null)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })

      if (response.ok) {
        // Full navigation, not router.push — the root layout reads the staff
        // role server-side to set [data-context], so the server must re-render.
        // Back to where the timeout interrupted them only for the SAME waiter
        // (Teran, 2026-11-01); `next` is checked, being in a URL anyone can craft.
        const payload = await response.json().catch(() => null)
        const staffId: string | null = payload?.data?.staffId ?? null
        let previous: string | null = null
        try {
          previous = window.localStorage.getItem(LAST_STAFF_KEY)
          if (staffId) window.localStorage.setItem(LAST_STAFF_KEY, staffId)
        } catch {
          // Storage blocked: no way to know who was here, so start fresh.
        }
        const next = new URLSearchParams(window.location.search).get('next')
        const sameWaiter = staffId !== null && staffId === previous
        window.location.assign(sameWaiter ? safeReturnPath(next) : '/')
        return
      }

      // Nothing is blamed on the user: "PIN not recognised", not "Invalid credentials".
      setError(response.status === 401 ? 'PIN not recognised — try again' : 'Could not sign in — try again')
    } catch {
      setError('Cannot reach the restaurant server')
    } finally {
      setIsSubmitting(false)
    }
  }, [])

  return (
    <div className="min-h-app flex bg-slate-100 night:bg-night-app">
      {/* Brand panel, 39% of the width (design 2026-10-31). Hidden below `md`,
          where it would push the keypad off screen. The descriptive lines went
          (Teran, 2026-11-16): the name, and what the floor is doing now. */}
      <aside className="hidden w-[39%] max-w-140 min-w-90 shrink-0 flex-col justify-between bg-brand-700 px-sp-7 py-sp-7 md:flex">
        <div className="flex flex-col gap-sp-1">
          <span className="text-fs-32 font-extrabold tracking-[-0.03em] text-white">Carpe Diem</span>
          <span className="text-fs-12 font-semibold tracking-micro text-brand-300 uppercase">RMS</span>
        </div>

        {floor ? <FloorChips floor={floor} /> : null}
        <span aria-hidden="true" />
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center gap-sp-5 p-sp-5">
        {/* On a narrow screen the panel is hidden, so the chips sit above the pad. */}
        {floor ? (
          <div className="md:hidden">
            <FloorChips floor={floor} />
          </div>
        ) : null}
        <PINPad onSubmit={handleSubmit} error={error} disabled={isSubmitting} label="Enter your PIN" />
      </main>
    </div>
  )
}

/**
 * Ongoing orders only (Teran, 2026-11-16): a free-table count mixed tables
 * with sun beds, bean bags and the rooftop.
 */
function FloorChips({ floor }: { floor: FloorNow }) {
  const n = floor.ongoingOrders
  return (
    <p className="flex w-fit items-center gap-sp-1 rounded-pill border border-occupied-edge bg-occupied-chip px-sp-3 py-sp-1 text-fs-14 font-bold tracking-micro text-occupied-ink uppercase">
      <Users aria-hidden="true" strokeWidth={2.5} className="size-4" />
      {n} ongoing order{n === 1 ? '' : 's'}
    </p>
  )
}
