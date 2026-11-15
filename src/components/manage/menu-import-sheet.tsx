'use client'

import { useRef, useState } from 'react'
import { CheckCircle2, Download, FileSpreadsheet, X } from 'lucide-react'
import { icon, primary, secondary } from '@/components/manage/manage-ui'
import { cn } from '@/lib/utils'
import type { ImportSummary } from '@/server/services/menu-import.service'

/**
 * Manage → Menu → Bulk upload (spec-menu-bulk-upload-excel): download the
 * menu as a sheet, fill it in, upload it. The upload is CHECKED first — the
 * owner sees "12 new, 3 updated" or the rows to fix — and nothing is saved
 * until Import.
 */

/** The bytes as checked: Import sends these, even if the file on disk changes meanwhile. */
type Checked = { name: string; bytes: Blob; summary: ImportSummary }

const URL_IMPORT = '/api/manage/menu/import'

async function send(file: Blob, name: string, apply: boolean): Promise<{ ok: boolean; summary: ImportSummary | null; message: string }> {
  const body = new FormData()
  body.append('file', file, name)
  const response = await fetch(`${URL_IMPORT}${apply ? '?apply=1' : ''}`, { method: 'POST', body })
  if (response.status === 401) {
    window.location.assign(`/manage/unlock?next=${encodeURIComponent('/manage/menu')}`)
    return { ok: false, summary: null, message: 'Manage is locked. Unlock it and choose the file again.' }
  }
  const json = (await response.json().catch(() => null)) as {
    data?: ImportSummary
    error?: { message?: string }
  } | null
  return { ok: response.ok, summary: json?.data ?? null, message: json?.error?.message ?? 'Could not read the file' }
}

function counts(summary: ImportSummary): string[] {
  const line = (label: string, c: { new: number; updated: number }) =>
    c.new + c.updated === 0 ? null : `${label}: ${[c.new ? `${c.new} new` : '', c.updated ? `${c.updated} updated` : ''].filter(Boolean).join(', ')}`
  return [
    line('Categories', summary.categories),
    line('Dishes', summary.dishes),
    line('Option groups', summary.groups),
    line('Options', summary.options),
  ].filter((entry): entry is string => entry !== null)
}

export function MenuImportSheet({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [problem, setProblem] = useState<{ message: string; summary: ImportSummary | null } | null>(null)
  const [done, setDone] = useState<string[] | null>(null)

  async function check(file: File | undefined) {
    if (input.current) input.current.value = '' // the same file can be chosen again after a fix
    if (!file) return
    setBusy(true)
    setChecked(null)
    setProblem(null)
    setDone(null)
    try {
      const bytes = new Blob([await file.arrayBuffer()])
      const result = await send(bytes, file.name, false)
      if (result.ok && result.summary) setChecked({ name: file.name, bytes, summary: result.summary })
      else setProblem({ message: result.message, summary: result.summary })
    } catch {
      setProblem({ message: 'Could not reach the POS. Try again.', summary: null })
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!checked) return
    setBusy(true)
    try {
      const result = await send(checked.bytes, checked.name, true)
      if (result.ok && result.summary) {
        setDone(counts(result.summary))
        setChecked(null)
        onImported()
      } else {
        setProblem({ message: result.message, summary: result.summary })
        setChecked(null)
      }
    } catch {
      setProblem({ message: 'Could not reach the POS. Nothing was imported.', summary: null })
    } finally {
      setBusy(false)
    }
  }

  const changes = checked ? counts(checked.summary) : []

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-sheet-title"
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose()
      }}
    >
      <div className="flex h-full w-full max-w-xl flex-col gap-sp-4 overflow-y-auto bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex items-center justify-between">
          <h2 id="import-sheet-title" className="text-fs-20 font-extrabold text-slate-900 night:text-night-text">
            Bulk upload
          </h2>
          <button type="button" aria-label="Close" className={icon} disabled={busy} onClick={onClose}>
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        <ol className="flex flex-col gap-sp-4 text-fs-14 text-slate-700 night:text-night-second">
          <li className="flex flex-col gap-sp-2">
            <span className="font-bold text-slate-900 night:text-night-text">1. Download the menu sheet</span>
            <span>An Excel file of the menu as it is now (empty on a new POS). Its &ldquo;How to&rdquo; tab explains each column.</span>
            <a href={URL_IMPORT} download className={cn(secondary, 'self-start')}>
              <Download className="size-4" aria-hidden="true" /> Download sheet
            </a>
          </li>
          <li className="flex flex-col gap-sp-2">
            <span className="font-bold text-slate-900 night:text-night-text">2. Fill it in and upload it</span>
            <span>It is checked first. Nothing is saved until you press Import.</span>
            <input
              ref={input}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={(event) => void check(event.target.files?.[0])}
            />
            <button type="button" className={cn(secondary, 'self-start')} disabled={busy} onClick={() => input.current?.click()}>
              <FileSpreadsheet className="size-4" aria-hidden="true" /> {busy && !checked ? 'Checking…' : 'Choose file'}
            </button>
          </li>
        </ol>

        {problem ? (
          <div role="alert" className="flex flex-col gap-sp-2 rounded-control bg-amber-50 px-sp-4 py-sp-3 text-fs-14 text-amber-900 night:bg-amber-500/10 night:text-amber-300">
            <p className="font-bold">{problem.message}</p>
            {problem.summary && problem.summary.errors.length > 0 ? (
              <ul className="flex max-h-72 flex-col gap-sp-1 overflow-y-auto">
                {problem.summary.errors.map((error, index) => (
                  <li key={index}>
                    {error.sheet ? <span className="font-semibold">{error.sheet} row {error.row}: </span> : null}
                    {error.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {checked ? (
          <div className="flex flex-col gap-sp-3 rounded-control border border-slate-200 p-sp-4 night:border-night-hairline">
            <p className="text-fs-14 font-bold text-slate-900 night:text-night-text">{checked.name} is ready</p>
            {changes.length === 0 ? (
              <p className="text-fs-14 text-slate-600 night:text-night-second">Nothing to change: the menu already matches this sheet.</p>
            ) : (
              <ul className="flex flex-col gap-sp-1 text-fs-14 text-slate-700 night:text-night-second">
                {changes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <button type="button" className={cn(primary, 'self-start disabled:opacity-50')} disabled={busy || changes.length === 0} onClick={() => void runImport()}>
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        ) : null}

        {done ? (
          <div role="status" className="flex items-start gap-sp-2 rounded-control bg-emerald-50 px-sp-4 py-sp-3 text-fs-14 text-emerald-900 night:bg-emerald-500/10 night:text-emerald-300">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div className="flex flex-col gap-sp-1">
              <p className="font-bold">Imported. The tablets have the new menu.</p>
              {done.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
