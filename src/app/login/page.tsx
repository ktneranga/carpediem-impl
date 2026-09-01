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

        if (response.status === 401) {
          setError('Incorrect PIN')
        } else {
          setError('Unable to sign in. Try again.')
        }
      } catch {
        setError('Cannot reach the server')
      } finally {
        setIsSubmitting(false)
      }
    },
    [],
  )

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-space-8 p-space-6">
      <h1 className="text-h1 font-semibold text-neutral-900">Carpe Diem</h1>

      <div className="w-full max-w-xs">
        <PINPad
          onSubmit={handleSubmit}
          error={error}
          disabled={isSubmitting}
          label="Enter your PIN"
        />
      </div>
    </main>
  )
}
