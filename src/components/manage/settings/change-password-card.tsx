'use client'

import { useState } from 'react'
import { PasswordInput } from '@/components/password-input'
import { input, primary } from '@/components/manage/manage-ui'
import { cn } from '@/lib/utils'

const MIN_BYTES = 8
const MAX_BYTES = 72
const byteLength = (text: string) => new TextEncoder().encode(text).length

/**
 * Change the Manage password (Teran, 2026-11-16). Owner only, its own button —
 * never part of the settings Save. The current password is checked with the
 * unlock screen's lockout; other devices are locked out of Manage after it.
 * A FORGOTTEN password is still cleared on the server.
 */
export function ChangePasswordCard() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  async function change() {
    setNote(null)
    const bytes = byteLength(next)
    if (bytes < MIN_BYTES || bytes > MAX_BYTES) {
      setNote({ ok: false, text: `The new password is ${MIN_BYTES}–${MAX_BYTES} characters.` })
      return
    }
    if (next !== confirm) {
      setNote({ ok: false, text: 'The two new passwords are different.' })
      return
    }
    if (next === current) {
      setNote({ ok: false, text: 'The new password is the same as the current one.' })
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/manage/password', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current, next }),
      })
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      if (!response.ok) {
        setNote({ ok: false, text: body?.error?.message ?? 'Could not change the password' })
        return
      }
      setCurrent('')
      setNext('')
      setConfirm('')
      setNote({ ok: true, text: 'Password changed. Other devices need the new one to open Manage.' })
    } catch {
      setNote({ ok: false, text: 'Could not reach the till. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const field = 'flex flex-col gap-sp-1'
  const label = 'text-fs-14 font-semibold text-slate-600 night:text-night-second'
  return (
    <section id="settings-password" aria-label="Owner password" className="flex max-w-3xl flex-col gap-sp-3 rounded-panel bg-white p-sp-4 night:bg-night-card">
      <div className="flex flex-col gap-sp-1">
        <h2 className="text-fs-16 font-extrabold text-slate-900 night:text-night-text">Owner password</h2>
        <p className="text-fs-12 text-slate-500 night:text-night-muted">The password that opens Manage. Only you see this.</p>
      </div>
      <form
        className="grid gap-sp-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault()
          void change()
        }}
      >
        <label className={field}>
          <span className={label}>Current password</span>
          <PasswordInput className={input} maxLength={72} autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>
        <label className={field}>
          <span className={label}>New password</span>
          <PasswordInput className={input} maxLength={72} autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
        </label>
        <label className={field}>
          <span className={label}>New password again</span>
          <PasswordInput className={input} maxLength={72} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </label>
        <div className="flex flex-wrap items-center gap-sp-3 sm:col-span-3">
          <button type="submit" className={cn(primary, 'disabled:opacity-50')} disabled={busy || !current || !next || !confirm}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
          {note ? (
            <span role={note.ok ? 'status' : 'alert'} className={cn('text-fs-14 font-semibold', note.ok ? 'text-slate-600 night:text-night-second' : 'text-red-700 night:text-red-400')}>
              {note.text}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  )
}
