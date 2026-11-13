'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Eye, EyeOff, Plus, Trash2, X } from 'lucide-react'
import { ApiError, call as callApi, ConfirmDialog, icon, input, primary, secondary } from '@/components/manage/manage-ui'
import { accessOf, isStaffJob, jobLabel, STAFF_JOBS, type StaffJob } from '@/lib/staff-jobs'
import type { ManageStaff, StaffRole } from '@/server/services/staff-admin.service'
import { cn } from '@/lib/utils'

/**
 * Manage → Staff (Story 10.2): add people, set names, roles and PINs,
 * deactivate and reactivate.
 *
 * Like the other Manage editors, every save carries the version the screen
 * loaded and rows are keyed on `id + version`. Errors stay inside the sheet
 * with what was typed — except the PIN, which is cleared after every save
 * attempt and never kept in the query cache.
 */

const call = (method: string, url: string, body?: unknown) => callApi(method, url, body, '/manage/staff')

/** What each access level (set by the job) can open, and its badge colour. */
const ROLES: { role: StaffRole; access: string; badge: string }[] = [
  { role: 'waiter', access: 'Orders & bills', badge: 'bg-slate-100 text-slate-700 night:bg-night-raised night:text-night-second' },
  { role: 'kitchen', access: 'Kitchen screen only', badge: 'bg-amber-50 text-amber-900 night:bg-amber-500/10 night:text-amber-300' },
  { role: 'owner', access: 'Everything, incl. Manage', badge: 'bg-brand-050 text-brand-800 night:bg-night-raised night:text-brand-300' },
]
const roleOf = (role: StaffRole) => ROLES.find((r) => r.role === role)!

type Result = { ok: true } | { ok: false; code: string; message: string }
type Save = (method: string, url: string, body: unknown) => Promise<Result>
type Sheet = { mode: 'new' } | { mode: 'edit'; person: ManageStaff } | { mode: 'reactivate'; person: ManageStaff }

export function StaffEditor({ meId }: { meId: string | null }) {
  const queryClient = useQueryClient()
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [busy, setBusy] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['manage-staff'] as const,
    queryFn: async () => ((await call('GET', '/api/manage/staff')) as { data: ManageStaff[] }).data,
  })
  const active = (data ?? []).filter((person) => person.isActive)
  const inactive = (data ?? []).filter((person) => !person.isActive)

  /** Runs a save; reloads on success (and on STALE, so the next try has the new version). */
  const save: Save = async (method, url, body) => {
    setBusy(true)
    try {
      await call(method, url, body)
      await queryClient.invalidateQueries({ queryKey: ['manage-staff'] })
      return { ok: true }
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : 'ERROR'
      if (code === 'STALE') await queryClient.invalidateQueries({ queryKey: ['manage-staff'] })
      return { ok: false, code, message: failure instanceof Error ? failure.message : 'Could not save the change' }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <h1 className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">Staff</h1>
        <button type="button" className={primary} onClick={() => setSheet({ mode: 'new' })}>
          <Plus className="size-4" aria-hidden="true" /> Add staff
        </button>
      </header>

      {isLoading ? <p className="text-fs-14 text-slate-600 night:text-night-second">Loading the staff…</p> : null}
      {error ? <p role="alert" className="text-fs-14 font-semibold text-red-700 night:text-red-400">Could not load the staff.</p> : null}

      <section aria-label="Active staff" className="flex flex-col divide-y divide-slate-100 rounded-panel bg-white p-sp-2 night:divide-night-hairline night:bg-night-card">
        {active.map((person) => (
          <button
            key={`${person.id}-${person.version}`}
            type="button"
            className="flex min-h-14 items-center gap-sp-3 rounded-control px-sp-3 text-left hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-500 night:hover:bg-night-raised"
            onClick={() => setSheet({ mode: 'edit', person })}
          >
            <span className="min-w-0 flex-1 truncate text-fs-16 font-bold text-slate-900 night:text-night-text">{person.name}</span>
            {person.id === meId ? (
              <span className="rounded-pill border border-slate-300 px-sp-2 py-0.5 text-fs-12 font-semibold text-slate-600 night:border-night-hairline night:text-night-second">You</span>
            ) : null}
            <span className="hidden text-fs-12 text-slate-500 sm:inline night:text-night-muted">{roleOf(person.role).access}</span>
            <RoleBadge role={person.role} job={person.jobTitle} />
          </button>
        ))}
      </section>

      {inactive.length > 0 ? (
        <section aria-label="Deactivated staff" className="flex flex-col rounded-panel bg-white p-sp-2 night:bg-night-card">
          <button
            type="button"
            aria-expanded={showInactive}
            className="flex min-h-11 items-center gap-sp-2 rounded-control px-sp-3 text-fs-14 font-bold text-slate-600 hover:bg-slate-50 night:text-night-second night:hover:bg-night-raised"
            onClick={() => setShowInactive((open) => !open)}
          >
            <ChevronDown className={cn('size-4 transition-transform', showInactive ? '' : '-rotate-90')} aria-hidden="true" />
            Deactivated ({inactive.length})
          </button>
          {showInactive
            ? inactive.map((person) => (
                <div key={`${person.id}-${person.version}`} className="flex min-h-14 items-center gap-sp-3 border-t border-slate-100 px-sp-3 night:border-night-hairline">
                  <span className="min-w-0 flex-1 truncate text-fs-16 font-semibold text-slate-500 night:text-night-muted">{person.name}</span>
                  <RoleBadge role={person.role} job={person.jobTitle} />
                  <button type="button" className={secondary} disabled={busy} onClick={() => setSheet({ mode: 'reactivate', person })}>
                    Reactivate
                  </button>
                </div>
              ))
            : null}
        </section>
      ) : null}

      {sheet ? (
        <StaffSheet
          key={sheet.mode === 'new' ? 'new' : `${sheet.mode}-${sheet.person.id}`}
          sheet={sheet}
          isMe={sheet.mode !== 'new' && sheet.person.id === meId}
          busy={busy}
          save={save}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  )
}

/** The job title, coloured by access level. */
function RoleBadge({ role, job }: { role: StaffRole; job: string }) {
  return <span className={cn('rounded-pill px-sp-2 py-0.5 text-fs-12 font-semibold', roleOf(role).badge)}>{jobLabel(job)}</span>
}

function StaffSheet({
  sheet,
  isMe,
  busy,
  save,
  onClose,
}: {
  sheet: Sheet
  isMe: boolean
  busy: boolean
  save: Save
  onClose: () => void
}) {
  const person = sheet.mode === 'new' ? null : sheet.person
  const reactivating = sheet.mode === 'reactivate'
  const [name, setName] = useState(person?.name ?? '')
  const [job, setJob] = useState<StaffJob>(person && isStaffJob(person.jobTitle) ? person.jobTitle : 'waiter')
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<'deactivate' | 'delete' | null>(null)

  const pinNeeded = sheet.mode !== 'edit'
  const pinValid = pin === '' ? !pinNeeded : /^\d{4}$/.test(pin)
  const valid = (reactivating || name.trim() !== '') && pinValid

  async function finish(result: Result) {
    setPin('')
    if (result.ok) onClose()
    else setProblem(result.message)
  }

  async function submit() {
    if (!valid) return
    setProblem(null)
    if (sheet.mode === 'new') return finish(await save('POST', '/api/manage/staff', { name, jobTitle: job, pin }))
    if (sheet.mode === 'reactivate') {
      return finish(await save('PATCH', `/api/manage/staff/${sheet.person.id}`, { version: sheet.person.version, active: true, pin }))
    }
    const p = sheet.person
    const change = {
      version: p.version,
      ...(name.trim() !== p.name ? { name } : {}),
      ...(job !== p.jobTitle ? { jobTitle: job } : {}),
      ...(pin !== '' ? { pin } : {}),
    }
    if (Object.keys(change).length === 1) return onClose()
    return finish(await save('PATCH', `/api/manage/staff/${p.id}`, change))
  }

  async function deactivate() {
    if (!person) return
    setProblem(null)
    const result = await save('PATCH', `/api/manage/staff/${person.id}`, { version: person.version, active: false })
    setConfirming(null)
    await finish(result)
  }

  /** Only works for someone with no orders, bills or changes (added by mistake); the server says otherwise. */
  async function remove() {
    if (!person) return
    setProblem(null)
    const result = await save('DELETE', `/api/manage/staff/${person.id}?version=${person.version}`, undefined)
    setConfirming(null)
    await finish(result)
  }

  const title = sheet.mode === 'new' ? 'Add staff' : reactivating ? `Reactivate ${sheet.person.name}` : sheet.person.name

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-sheet-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && confirming === null) onClose()
      }}
    >
      <div className="flex max-h-full w-full max-w-md flex-col gap-sp-4 overflow-y-auto rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex items-center justify-between gap-sp-3">
          <h2 id="staff-sheet-title" className="min-w-0 truncate text-fs-20 font-extrabold text-slate-900 night:text-night-text">{title}</h2>
          <button type="button" aria-label="Close" className={icon} onClick={onClose}>
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        <form
          className="flex flex-col gap-sp-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          {reactivating ? (
            <p className="text-fs-14 text-slate-600 night:text-night-second">Choose a PIN for them. It can be their old one if no one else uses it.</p>
          ) : (
            <>
              <label className="flex flex-col gap-sp-1">
                <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Name</span>
                <input autoFocus maxLength={40} className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nimal" />
              </label>

              <fieldset className="flex flex-col gap-sp-1">
                <legend className="mb-sp-1 text-fs-14 font-semibold text-slate-700 night:text-night-second">Job</legend>
                <div className="grid grid-cols-3 gap-sp-2">
                  {STAFF_JOBS.map((choice) => (
                    <button
                      key={choice.job}
                      type="button"
                      aria-pressed={job === choice.job}
                      disabled={isMe}
                      className={choiceClass(job === choice.job)}
                      onClick={() => setJob(choice.job)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
                <span className="text-fs-12 text-slate-600 night:text-night-second">
                  Can use: {roleOf(accessOf(job)).access}
                  {isMe ? '. Another owner can change your job.' : null}
                </span>
              </fieldset>
            </>
          )}

          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">
              {sheet.mode === 'edit' ? 'Set a new PIN (leave empty to keep)' : 'PIN (4 digits)'}
            </span>
            <span className="flex gap-sp-1">
              <input
                autoFocus={reactivating}
                type={showPin ? 'text' : 'password'}
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                className={cn(input, 'min-w-0 flex-1 tracking-[0.4em]')}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              />
              <button
                type="button"
                aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                aria-pressed={showPin}
                className={icon}
                onClick={() => setShowPin((shown) => !shown)}
              >
                {showPin ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
              </button>
            </span>
          </label>

          {problem ? (
            <p role="alert" className="rounded-control bg-amber-50 px-sp-3 py-sp-2 text-fs-14 font-semibold text-amber-900 night:bg-amber-500/10 night:text-amber-300">{problem}</p>
          ) : null}

          <button type="submit" className={primary} disabled={busy || !valid}>
            {sheet.mode === 'new' ? 'Add staff' : reactivating ? 'Reactivate' : 'Save'}
          </button>
        </form>

        {person ? (
          <div className="flex flex-col gap-sp-1 border-t border-slate-100 pt-sp-3 night:border-night-hairline">
            <div className="flex gap-sp-2">
              {sheet.mode === 'edit' ? (
                <button
                  type="button"
                  className={cn(secondary, 'flex-1 text-red-700 night:text-red-400')}
                  disabled={busy || isMe}
                  onClick={() => setConfirming('deactivate')}
                >
                  Deactivate
                </button>
              ) : <span className="flex-1" />}
              <button
                type="button"
                aria-label={`Delete ${person.name}`}
                title="Delete (only someone with no orders or bills)"
                className={cn(icon, 'text-red-700 night:text-red-400')}
                disabled={busy || isMe}
                onClick={() => setConfirming('delete')}
              >
                <Trash2 className="size-5" aria-hidden="true" />
              </button>
            </div>
            {isMe ? <span className="text-fs-12 text-slate-600 night:text-night-second">Another owner can change this.</span> : null}
          </div>
        ) : null}
      </div>

      {confirming === 'deactivate' && person ? (
        <ConfirmDialog
          text={`Deactivate ${person.name}?`}
          note="They will be signed out on every tablet and can't sign in until reactivated."
          confirmLabel="Deactivate"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void deactivate()}
        />
      ) : null}
      {confirming === 'delete' && person ? (
        <ConfirmDialog
          text={`Delete ${person.name}?`}
          note="For someone added by mistake. If they have any orders or bills, they can't be deleted — deactivate them instead."
          confirmLabel="Delete"
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </div>
  )
}

/** A large choice button. */
function choiceClass(chosen: boolean) {
  return cn(
    'min-h-12 rounded-control border px-sp-2 text-fs-14 font-bold disabled:opacity-50',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
    chosen ? 'border-brand-800 bg-brand-800 text-white' : 'border-slate-200 bg-white text-slate-900 hover:bg-slate-50 night:border-night-hairline night:bg-night-card night:text-night-text night:hover:bg-night-raised',
  )
}
