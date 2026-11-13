'use client'

import { cn } from '@/lib/utils'

/**
 * Shared by the Manage editors (Menu — Story 10.4, Floor — Story 10.3): the
 * fetch wrapper, the control styles and the remove confirmation.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * One request to a `/api/manage/...` route. Throws `ApiError` with the server's
 * code and message; a 401 (the Manage or PIN session ended) sends the screen
 * back through the gate, returning to `returnTo`.
 */
export async function call(method: string, url: string, body: unknown, returnTo: string) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  if (!response.ok) {
    if (response.status === 401) {
      window.location.assign(`/manage/unlock?next=${encodeURIComponent(returnTo)}`)
    }
    throw new ApiError(json?.error?.code ?? 'ERROR', json?.error?.message ?? 'Could not save the change')
  }
  return json
}

export const input = cn(
  'h-11 rounded-control border border-slate-300 bg-white px-sp-3 text-fs-14 text-slate-900 night:border-night-hairline night:bg-night-sunken night:text-night-text',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500',
)
export const button = cn(
  'inline-flex h-11 shrink-0 items-center justify-center gap-sp-1 rounded-control px-sp-3 text-fs-14 font-bold',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50',
)
export const primary = cn(button, 'bg-brand-800 text-white night:bg-brand-700')
export const secondary = cn(button, 'border border-slate-200 bg-white text-slate-900 hover:bg-slate-50 night:border-night-hairline night:bg-night-card night:text-night-text night:hover:bg-night-raised')
export const icon = cn(
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-slate-600 hover:bg-slate-100 night:text-night-second night:hover:bg-night-raised',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-30',
)

/** Asks once before a remove (or another one-step action: `confirmLabel`). `note` says what happens. */
export function ConfirmDialog({
  text,
  note,
  busy,
  confirmLabel = 'Remove',
  onCancel,
  onConfirm,
}: {
  text: string
  note: string
  busy: boolean
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/50 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <h2 id="confirm-title" className="text-fs-20 font-extrabold text-slate-900 night:text-night-text">{text}</h2>
        <p className="text-fs-14 text-slate-600 night:text-night-second">{note}</p>
        <div className="flex gap-sp-3">
          <button type="button" autoFocus className={cn(secondary, 'flex-1')} onClick={onCancel}>Cancel</button>
          <button type="button" className={cn(primary, 'flex-1')} disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
