'use client'

import { useState } from 'react'
import { Download, LogOut } from 'lucide-react'
import { input, primary, secondary } from '@/components/manage/manage-ui'
import { PasswordInput } from '@/components/password-input'
import { cn } from '@/lib/utils'

/**
 * Vendor sign-in and the one thing it allows: downloading the database
 * (spec-11-1-vendor-access-export). The download is a plain link, so the
 * browser streams it to disk; nothing is held in memory here.
 */
export function VendorPanel({ signedIn }: { signedIn: boolean }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function post(url: string, body?: unknown): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null)
      return { ok: Boolean(response.ok && payload?.success), message: payload?.error?.message as string | undefined }
    } catch {
      return { ok: false, message: 'Could not reach the server. Try again.' }
    }
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const result = await post('/api/vendor/login', { password })
    setBusy(false)
    if (!result.ok) {
      setError(result.message ?? 'Could not sign in')
      return
    }
    setPassword('')
    window.location.reload()
  }

  async function signOut() {
    const result = await post('/api/vendor/logout')
    if (!result.ok) {
      setError(result.message ?? 'Could not sign out')
      return
    }
    window.location.reload()
  }

  if (!signedIn) {
    return (
      <form onSubmit={(event) => void signIn(event)} className="flex flex-col gap-sp-3">
        <label className="flex flex-col gap-sp-1">
          <span className="text-fs-14 font-semibold text-slate-600 night:text-night-second">Vendor password</span>
          <PasswordInput
            autoFocus
            autoComplete="current-password"
            className={input}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy || password.length === 0} className={cn(primary, 'disabled:opacity-50')}>
          Sign in
        </button>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-sp-3">
      <p className="text-fs-14 text-slate-600 night:text-night-second">
        A full copy of the database (pg_dump, custom format). It holds every sale, staff names and password
        hashes: keep it in a private folder. The owner sees in Manage when it was taken.
      </p>
      {error ? (
        <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">
          {error}
        </p>
      ) : null}
      <a href="/api/vendor/export" className={cn(primary, 'justify-center')}>
        <Download className="size-4" aria-hidden="true" /> Download database
      </a>
      <button type="button" onClick={() => void signOut()} className={secondary}>
        <LogOut className="size-4" aria-hidden="true" /> Sign out
      </button>
    </div>
  )
}
