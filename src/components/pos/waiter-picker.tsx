'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ServerOption = { id: string; name: string }

/**
 * Who looks after this table (Teran, 2026-11-16). Starts as whoever opened the
 * order; tap to pick another from the staff list, with a search box. Printed
 * on the kitchen tickets and the bill.
 */
export function WaiterPicker({
  sessionId,
  servers,
  initialServerId,
}: {
  sessionId: string
  servers: ServerOption[]
  initialServerId: string | null
}) {
  const [serverId, setServerId] = useState(initialServerId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  const current = servers.find((server) => server.id === serverId) ?? null
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? servers : servers.filter((server) => server.name.toLowerCase().includes(q))
  }, [query, servers])

  // A tap outside closes the list.
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  async function pick(server: ServerOption) {
    setOpen(false)
    setQuery('')
    if (server.id === serverId) return
    const previous = serverId
    setServerId(server.id)
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/sessions/${sessionId}/served-by`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ staffId: server.id }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? 'Could not change the waiter')
      }
    } catch (caught) {
      setServerId(previous)
      setError(caught instanceof Error ? caught.message : 'Could not change the waiter')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={box} className="relative flex flex-col gap-sp-1">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={saving}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex h-11 w-full items-center gap-sp-2 rounded-control border border-slate-200 bg-white px-sp-3 text-left',
          'night:border-night-hairline night:bg-night-card disabled:opacity-60',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        <UserRound aria-hidden="true" className="size-5 shrink-0 text-slate-500 night:text-night-muted" />
        <span className="text-fs-14 text-slate-600 night:text-night-second">Waiter</span>
        <span className="min-w-0 flex-1 truncate text-fs-16 font-bold text-slate-900 night:text-night-text">
          {current?.name ?? 'Choose'}
        </span>
        <ChevronDown aria-hidden="true" className="size-5 shrink-0 text-slate-500 night:text-night-muted" />
      </button>
      {error ? (
        <p role="alert" className="text-fs-12 font-semibold text-unavailable-band night:text-red-400">
          {error}
        </p>
      ) : null}

      {open ? (
        <div className="absolute top-full right-0 left-0 z-40 mt-sp-1 flex max-h-80 flex-col rounded-control border border-slate-200 bg-white shadow-el-2 night:border-night-hairline night:bg-night-card">
          <label className="flex shrink-0 items-center gap-sp-2 border-b border-slate-200 px-sp-3 night:border-night-hairline">
            <Search aria-hidden="true" className="size-4 text-slate-500 night:text-night-muted" />
            <input
              autoFocus
              value={query}
              placeholder="Search staff"
              aria-label="Search staff"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setOpen(false)
                if (event.key === 'Enter' && matches.length === 1) void pick(matches[0]!)
              }}
              className="h-11 min-w-0 flex-1 bg-transparent text-fs-16 text-slate-900 outline-none night:text-night-text"
            />
          </label>
          <ul role="listbox" aria-label="Staff" className="min-h-0 flex-1 overflow-y-auto py-sp-1">
            {matches.length === 0 ? (
              <li className="px-sp-3 py-sp-2 text-fs-14 text-slate-500 night:text-night-muted">No one by that name</li>
            ) : (
              matches.map((server) => (
                <li key={server.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={server.id === serverId}
                    onClick={() => void pick(server)}
                    className={cn(
                      'flex min-h-11 w-full items-center px-sp-3 text-left text-fs-16',
                      server.id === serverId
                        ? 'bg-brand-050 font-bold text-brand-800 night:bg-night-raised night:text-brand-300'
                        : 'text-slate-900 hover:bg-slate-50 night:text-night-text night:hover:bg-night-raised',
                    )}
                  >
                    {server.name}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
