'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { TableGridRow } from '@/app/api/tables/route'

/**
 * Move this order to another free table, in any zone (Teran, 2026-11-16) —
 * the party walks from Table 3 to a sun bed and the order goes with them.
 * Free tables are listed by zone; one tap moves it.
 */
export function MoveTableDialog({
  sessionId,
  fromLabel,
  onCancel,
  onMoved,
}: {
  sessionId: string
  fromLabel: string
  onCancel: () => void
  onMoved: (tableLabel: string) => void
}) {
  const [free, setFree] = useState<TableGridRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/tables')
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: TableGridRow[] }) => {
        if (!alive) return
        if (!payload.success || !payload.data) throw new Error()
        setFree(payload.data.filter((table) => table.status === 'open'))
      })
      .catch(() => alive && setError('Could not load the tables. Try again.'))
    return () => {
      alive = false
    }
  }, [])

  async function move(table: TableGridRow) {
    setBusy(table.id)
    setError(null)
    try {
      const response = await fetch(`/api/sessions/${sessionId}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableId: table.id }),
      })
      if (response.ok) {
        onMoved(table.label)
        return
      }
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
      setError(body?.error?.message ?? 'Could not move the order')
      // Someone took it: show the tables as they are now.
      setFree((current) => current?.filter((row) => row.id !== table.id) ?? null)
    } catch {
      setError('Could not reach the till. Check the connection and try again.')
    }
    setBusy(null)
  }

  const zones = free
    ? [...new Set(free.map((table) => table.zoneName))].map((zone) => ({
        zone,
        tables: free
          .filter((table) => table.zoneName === zone)
          .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
      }))
    : []

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="move-table-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="flex max-h-[90%] w-full max-w-xl flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <h2 id="move-table-title" className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">
          Move {fromLabel} to…
        </h2>

        <div className="flex min-h-0 flex-1 flex-col gap-sp-4 overflow-y-auto">
          {free === null && !error ? (
            <p className="text-fs-14 text-slate-600 night:text-night-second">Loading tables…</p>
          ) : free && free.length === 0 ? (
            <p className="text-fs-14 text-slate-600 night:text-night-second">No table is free right now.</p>
          ) : (
            zones.map(({ zone, tables }) => (
              <section key={zone} className="flex flex-col gap-sp-2">
                <h3 className="text-fs-12 font-bold tracking-micro text-slate-500 uppercase night:text-night-muted">{zone}</h3>
                <div className="flex flex-wrap gap-sp-2">
                  {tables.map((table) => (
                    <button
                      key={table.id}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void move(table)}
                      className={cn(
                        'h-touch-waiter min-w-24 rounded-waiter border border-open-edge bg-open-chip px-sp-4 text-fs-16 font-bold text-open-ink',
                        'active:scale-[0.97] disabled:opacity-60',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      {busy === table.id ? 'Moving…' : table.label}
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {error ? (
          <p role="alert" className="text-fs-14 font-semibold text-unavailable-band night:text-red-400">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          onClick={onCancel}
          className={cn(
            'h-touch-waiter rounded-waiter border border-slate-200 bg-white text-fs-16 font-bold text-slate-900 night:border-night-hairline night:bg-night-card night:text-night-text',
            'active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
