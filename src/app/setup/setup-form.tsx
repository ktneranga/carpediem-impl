'use client'

import { useState } from 'react'
import { input, primary } from '@/components/manage/manage-ui'
import { PasswordInput } from '@/components/password-input'
import { cn } from '@/lib/utils'

/** Zones a restaurant here is likely in; Asia/Colombo first (Carpe Diem). */
const TIME_ZONES = [
  'Asia/Colombo',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Bangkok',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'UTC',
]

type Field = 'restaurantName' | 'timeZone' | 'ownerName' | 'pin' | 'managePassword'

/**
 * The five things setup needs (spec-first-run-setup). PIN and password are
 * typed twice and compared here; the server checks every rule again.
 */
export function SetupForm() {
  const [values, setValues] = useState({
    restaurantName: '',
    timeZone: 'Asia/Colombo',
    ownerName: '',
    pin: '',
    pinAgain: '',
    managePassword: '',
    managePasswordAgain: '',
  })
  const [error, setError] = useState<{ field: Field | 'pinAgain' | 'managePasswordAgain' | null; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const set = (key: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    if (!/^\d{4}$/.test(values.pin)) return setError({ field: 'pin', message: 'The PIN is exactly 4 digits' })
    if (values.pin !== values.pinAgain) return setError({ field: 'pinAgain', message: 'The two PINs are different' })
    const passwordBytes = new TextEncoder().encode(values.managePassword).length
    if (passwordBytes < 8 || passwordBytes > 72) {
      return setError({ field: 'managePassword', message: 'The Manage password is 8 to 72 characters (fewer with non-English letters)' })
    }
    if (values.managePassword !== values.managePasswordAgain) {
      return setError({ field: 'managePasswordAgain', message: 'The two passwords are different' })
    }
    setBusy(true)
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantName: values.restaurantName,
          timeZone: values.timeZone,
          ownerName: values.ownerName,
          pin: values.pin,
          managePassword: values.managePassword,
        }),
      })
      const payload = await response.json().catch(() => null)
      if (response.ok && payload?.success) {
        setDone(true)
        return
      }
      if (payload?.error?.code === 'ALREADY_SET_UP') {
        window.location.assign('/login')
        return
      }
      setError({ field: payload?.error?.field ?? null, message: payload?.error?.message ?? 'Could not set up the restaurant' })
    } catch {
      setError({ field: null, message: 'Could not reach the server. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-sp-3">
        <p role="status" className="text-fs-16 font-semibold text-slate-900 night:text-night-text">
          The restaurant is set up. Sign in with your PIN, then open Manage with the password you chose to add the
          menu, tables and staff.
        </p>
        <a href="/login" className={cn(primary, 'justify-center')}>
          Go to sign-in
        </a>
      </div>
    )
  }

  const row = (label: string, field: Field | 'pinAgain' | 'managePasswordAgain', control: React.ReactNode, hint?: string) => (
    <label className="flex flex-col gap-sp-1">
      <span className="text-fs-14 font-semibold text-slate-600 night:text-night-second">{label}</span>
      {control}
      {error?.field === field ? (
        <span role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">
          {error.message}
        </span>
      ) : hint ? (
        <span className="text-fs-12 text-slate-500 night:text-night-muted">{hint}</span>
      ) : null}
    </label>
  )

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-sp-3">
      {row('Restaurant name', 'restaurantName', <input className={input} autoFocus maxLength={60} value={values.restaurantName} onChange={set('restaurantName')} />)}
      {row(
        'Time zone',
        'timeZone',
        <select className={input} value={values.timeZone} onChange={set('timeZone')}>
          {TIME_ZONES.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>,
        'Used for the business day, receipts and the end-of-day figures.',
      )}
      {row('Owner name', 'ownerName', <input className={input} maxLength={40} value={values.ownerName} onChange={set('ownerName')} />)}
      {row(
        'Owner PIN',
        'pin',
        <PasswordInput what="PIN" className={input} inputMode="numeric" autoComplete="off" maxLength={4} value={values.pin} onChange={set('pin')} />,
        '4 digits. This is how the owner signs in on the PIN pad.',
      )}
      {row('Owner PIN again', 'pinAgain', <PasswordInput what="PIN" className={input} inputMode="numeric" autoComplete="off" maxLength={4} value={values.pinAgain} onChange={set('pinAgain')} />)}
      {row(
        'Manage password',
        'managePassword',
        <PasswordInput className={input} autoComplete="new-password" maxLength={72} value={values.managePassword} onChange={set('managePassword')} />,
        '8 characters or more. Opens Manage (menu, staff, money).',
      )}
      {row('Manage password again', 'managePasswordAgain', <PasswordInput className={input} autoComplete="new-password" maxLength={72} value={values.managePasswordAgain} onChange={set('managePasswordAgain')} />)}
      {error && error.field === null ? (
        <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">
          {error.message}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy || !values.restaurantName.trim() || !values.ownerName.trim() || !values.pin || !values.managePassword}
        className={cn(primary, 'disabled:opacity-50')}
      >
        {busy ? 'Setting up…' : 'Set up'}
      </button>
    </form>
  )
}
