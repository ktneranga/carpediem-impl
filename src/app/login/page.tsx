'use client'

import { useCallback, useState } from 'react'
import { PINPad } from '@/components/pos/pin-pad'
import { LAST_STAFF_KEY, safeReturnPath } from '@/lib/return-to'

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = useCallback(
    async (pin: string) => {
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
          // Back to where the timeout interrupted them, if anywhere — checked,
          // because `next` is in a URL anyone can craft.
          //
          // Only for the SAME waiter (Teran, 2026-11-01): someone else signing
          // in on this tablet starts on the floor, not inside another waiter's
          // order or bill.
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

        // Nothing is blamed on the user: "PIN not recognised", not "Invalid
        // credentials". The copy rules are part of the system, not decoration.
        if (response.status === 401) {
          setError('PIN not recognised — try again')
        } else {
          setError('Could not sign in — try again')
        }
      } catch {
        setError('Cannot reach the restaurant server')
      } finally {
        setIsSubmitting(false)
      }
    },
    [],
  )

  return (
    <div className="min-h-app flex bg-slate-100">
      {/*
        Brand panel. No logo was supplied with the design system, so the mark is
        the name set in Inter 800 with RMS tracked out beneath — the system's own
        documented substitute. A real mark drops into the same slot.

        Hidden below `md`: this is a tablet-landscape app, and on a phone-width
        viewport the panel would push the keypad off screen. The pad is the only
        thing on this route that must survive a narrow viewport.
      */}
      {/* 39% of the width, measured off the login design (2026-10-31): a fixed
          430px was a narrower slice on a wide screen than the design draws. */}
      <aside className="hidden w-[39%] max-w-140 min-w-90 shrink-0 flex-col justify-between bg-brand-700 px-sp-7 py-sp-7 md:flex">
        <div className="flex flex-col gap-sp-1">
          <span className="text-fs-32 font-extrabold tracking-[-0.03em] text-white">
            Carpe Diem
          </span>
          <span className="text-fs-12 font-semibold tracking-micro text-brand-300 uppercase">
            RMS
          </span>
        </div>

        {/* The promise the system actually makes. It is also the reason the
            sign-in screen exists at all: attribution. */}
        <p className="max-w-72 text-fs-16 leading-relaxed text-pretty text-brand-100">
          Every order recorded. Nothing edited, nothing deleted — a correction is a new record.
        </p>

        {/* Reassurance, not decoration: staff need to know the tablet is talking
            to the restaurant server before they trust an order to it. */}
        <div className="flex items-center gap-sp-2">
          <span aria-hidden="true" className="size-2 rounded-pill bg-open-edge" />
          <span className="text-fs-12 font-semibold tracking-micro text-brand-300 uppercase">
            Running on the restaurant network
          </span>
        </div>
      </aside>

      {/* The pad sits straight on the grey, as the design draws it — no white
          card around it (2026-10-31). The keys are the surfaces; a card behind
          them was a third layer saying nothing. */}
      <main className="flex flex-1 items-center justify-center p-sp-5">
        <PINPad
          onSubmit={handleSubmit}
          error={error}
          disabled={isSubmitting}
          label="Enter your PIN"
          hint="Session ends after 5 minutes idle"
        />
      </main>
    </div>
  )
}
