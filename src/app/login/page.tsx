'use client'

import { useCallback, useState } from 'react'
import { PINPad } from '@/components/pos/pin-pad'

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
          window.location.assign('/')
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
    <div className="flex min-h-screen bg-slate-100">
      {/*
        Brand panel. No logo was supplied with the design system, so the mark is
        the name set in Inter 800 with RMS tracked out beneath — the system's own
        documented substitute. A real mark drops into the same slot.

        Hidden below `md`: this is a tablet-landscape app, and on a phone-width
        viewport the panel would push the keypad off screen. The pad is the only
        thing on this route that must survive a narrow viewport.
      */}
      <aside className="hidden w-[430px] shrink-0 flex-col justify-between bg-brand-700 px-sp-7 py-sp-7 md:flex">
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

      <main className="flex flex-1 items-center justify-center p-sp-5">
        <div className="w-full max-w-105 rounded-panel bg-white px-sp-7 py-sp-7 shadow-el-4">
          <PINPad
            onSubmit={handleSubmit}
            error={error}
            disabled={isSubmitting}
            label="Enter your PIN"
            hint="Session ends after 5 minutes idle"
          />
        </div>
      </main>
    </div>
  )
}
