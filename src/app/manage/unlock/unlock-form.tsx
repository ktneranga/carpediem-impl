'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'

const MIN_BYTES = 8
const MAX_BYTES = 72

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function waitMessage(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return `Too many tries. Try again in ${minutes} min.`
}

/**
 * Set (first time) or enter the Manage password. The password lives only in
 * this component's state and the request body; it is cleared after every try.
 */
export function UnlockForm({
  mode: initialMode,
  next,
  lockedForSeconds,
}: {
  mode: 'set' | 'unlock'
  next: string
  lockedForSeconds: number
}) {
  const router = useRouter()
  const [mode, setMode] = useState(initialMode)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(
    lockedForSeconds > 0 ? waitMessage(lockedForSeconds) : null,
  )
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)

    if (mode === 'set') {
      const bytes = byteLength(password)
      if (bytes < MIN_BYTES || bytes > MAX_BYTES) {
        setError(`Use ${MIN_BYTES}–${MAX_BYTES} characters.`)
        return
      }
      if (password !== confirm) {
        setError('The two passwords are different.')
        return
      }
    }

    setBusy(true)
    try {
      const response = await fetch(mode === 'set' ? '/api/manage/password' : '/api/manage/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      setPassword('')
      setConfirm('')

      if (response.ok) {
        router.replace(next)
        router.refresh()
        return
      }

      const payload = await response.json().catch(() => null)
      const code: string | undefined = payload?.error?.code

      if (response.status === 401 && code === 'WRONG_PASSWORD') {
        const left = Number(payload.error.attemptsLeft)
        setError(`Wrong password — ${left} ${left === 1 ? 'try' : 'tries'} left`)
      } else if (response.status === 429) {
        setError(waitMessage(Number(payload?.error?.retryAfterSeconds ?? 300)))
      } else if (code === 'NOT_SET') {
        setMode('set')
        setError('No Manage password yet — choose one.')
      } else if (code === 'ALREADY_SET') {
        setMode('unlock')
        setError('A password is already set — enter it.')
      } else if (response.status === 400) {
        setError(`Use ${MIN_BYTES}–${MAX_BYTES} characters.`)
      } else if (response.status === 401) {
        // The PIN session ended: back to the PIN pad.
        window.location.assign('/login')
      } else {
        setError('Could not open Manage — try again.')
      }
    } catch {
      setError('Cannot reach the restaurant server.')
    } finally {
      setBusy(false)
    }
  }

  const inputClass = cn(
    'min-h-touch-standard w-full rounded-control border border-slate-200 bg-white px-sp-3',
    'text-fs-16 text-slate-900',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  return (
    <form
      onSubmit={submit}
      className="flex w-full max-w-sm flex-col gap-sp-4 rounded-panel bg-white p-sp-6 shadow-sm"
    >
      <div className="flex items-center gap-sp-3">
        <span className="flex size-10 items-center justify-center rounded-pill bg-brand-050 text-brand-800">
          <Lock aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h1 className="text-fs-18 font-extrabold text-slate-900">Manage</h1>
          <p className="text-fs-14 text-slate-600">
            {mode === 'set' ? 'Choose a password for Manage' : 'Enter the Manage password'}
          </p>
        </div>
      </div>

      <label className="flex flex-col gap-sp-1">
        <span className="text-fs-14 font-semibold text-slate-900">Password</span>
        <input
          type="password"
          autoComplete={mode === 'set' ? 'new-password' : 'current-password'}
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={inputClass}
        />
      </label>

      {mode === 'set' ? (
        <label className="flex flex-col gap-sp-1">
          <span className="text-fs-14 font-semibold text-slate-900">Type it again</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className={inputClass}
          />
          <span className="text-fs-12 text-slate-600">
            {MIN_BYTES}–{MAX_BYTES} characters. Forgotten later? It is reset on the server.
          </span>
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-fs-14 font-semibold text-unavailable-ink">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy || password.length === 0}
        className={cn(
          'min-h-touch-standard rounded-control bg-brand-800 px-sp-4 text-fs-16 font-bold text-white',
          'disabled:opacity-50',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        {mode === 'set' ? 'Set password and open' : 'Open Manage'}
      </button>

      <Link
        href="/"
        className="flex min-h-touch-standard items-center justify-center text-fs-14 font-semibold text-slate-600"
      >
        Back to floor
      </Link>
    </form>
  )
}
