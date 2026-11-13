'use client'

import { createElement, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2, Undo2, Users, X } from 'lucide-react'
import { SortableList } from '@/components/manage/sortable-list'
import {
  ApiError,
  call as callApi,
  ConfirmDialog,
  icon,
  input,
  primary,
  secondary,
} from '@/components/manage/manage-ui'
import type { ManageFloor, ManageTable, ManageZone } from '@/server/services/floor-admin.service'
import { zoneIcon } from '@/lib/design'
import { cn } from '@/lib/utils'

/**
 * Manage → Floor (Story 10.3 lite): the zones (the floor's pills) and their tables.
 *
 * Built like the menu editor: every save carries the version the screen loaded,
 * a stale one is refused (409 STALE) and the screen reloads; rows are keyed on
 * `id + version` so a save remounts them with the server's values. Each save
 * also broadcasts `floor:changed`, so every tablet's floor follows.
 */

const call = (method: string, url: string, body?: unknown) => callApi(method, url, body, '/manage/floor')

type Run = (method: string, url: string, body?: unknown) => Promise<unknown>

export function FloorEditor() {
  const queryClient = useQueryClient()
  const [showRemoved, setShowRemoved] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; tableId: string } | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; note: string; run: () => Promise<void> } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['manage-floor', showRemoved] as const,
    queryFn: async () =>
      ((await call('GET', `/api/manage/floor${showRemoved ? '?removed=1' : ''}`)) as { data: ManageFloor }).data,
  })
  const zones = data?.zones ?? []
  const removed = data?.removed ?? []

  const selected = zones.find((zone) => zone.id === selectedId) ?? zones[0] ?? null
  const editingTable =
    editing?.mode === 'edit' ? zones.flatMap((zone) => zone.tables).find((t) => t.id === editing.tableId) ?? null : null

  /** Runs a save; on success reloads the floor; on failure shows why (and reloads on STALE). */
  const run: Run = async (method, url, body) => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await call(method, url, body)
      await queryClient.invalidateQueries({ queryKey: ['manage-floor'] })
      return result
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the change')
      if (error instanceof ApiError && error.code === 'STALE') {
        await queryClient.invalidateQueries({ queryKey: ['manage-floor'] })
      }
      return null
    } finally {
      setBusy(false)
    }
  }

  const reorder = (kind: 'zone' | 'table', parentId: string | null, ids: string[]) =>
    run('POST', '/api/manage/floor/reorder', { kind, parentId, ids })

  /** A removed table goes back to its own zone, or — if that zone is gone too — to the one on screen. */
  function restore(table: ManageTable) {
    const ownZoneActive = zones.some((zone) => zone.id === table.zoneId)
    return run('POST', `/api/manage/floor/tables/${table.id}/restore`, {
      version: table.version,
      ...(ownZoneActive || !selected ? {} : { zoneId: selected.id }),
    })
  }

  return (
    <div className="flex flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <h1 className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">Floor</h1>
        <label className="flex min-h-11 items-center gap-sp-2 text-fs-14 font-semibold text-slate-700 night:text-night-second">
          <input type="checkbox" className="size-5" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
          Show removed tables
        </label>
      </header>

      {message ? (
        <p role="alert" className="flex items-center justify-between gap-sp-3 rounded-control bg-amber-50 px-sp-4 py-sp-3 text-fs-14 font-semibold text-amber-900 night:bg-amber-500/10 night:text-amber-300">
          {message}
          <button type="button" aria-label="Dismiss" className={icon} onClick={() => setMessage(null)}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {isLoading ? <p className="text-fs-14 text-slate-600 night:text-night-second">Loading the floor…</p> : null}

      <div className="flex flex-col gap-sp-4 lg:flex-row lg:items-start">
        {/* ── Zones ──────────────────────────────────────────────────────── */}
        <section aria-label="Zones" className="flex flex-col gap-sp-2 rounded-panel bg-white p-sp-3 lg:w-72 lg:shrink-0 night:bg-night-card">
          <h2 className="px-sp-2 text-fs-14 font-bold tracking-micro text-slate-500 uppercase night:text-night-muted">Zones</h2>
          <SortableList
            items={zones}
            disabled={busy}
            label={(zone) => zone.name}
            className="flex flex-col gap-sp-1"
            onReorder={(ids) => reorder('zone', null, ids)}
            renderItem={(zone, handle) => (
              <ZoneRow
                key={zone.version}
                zone={zone}
                handle={handle}
                selected={selected?.id === zone.id}
                busy={busy}
                onSelect={() => setSelectedId(zone.id)}
                onRename={(name) => run('PATCH', `/api/manage/floor/zones/${zone.id}`, { version: zone.version, name })}
                onRemove={() =>
                  setConfirm({
                    text: `Remove the zone "${zone.name}"?`,
                    note: 'Its pill leaves the floor. Past orders keep their tables.',
                    run: async () => {
                      await run('DELETE', `/api/manage/floor/zones/${zone.id}?version=${zone.version}`)
                    },
                  })
                }
              />
            )}
          />
          <AddZone busy={busy} onAdd={(name) => run('POST', '/api/manage/floor/zones', { name })} />
        </section>

        {/* ── Tables ─────────────────────────────────────────────────────── */}
        <section aria-label="Tables" className="flex min-w-0 flex-1 flex-col gap-sp-2 rounded-panel bg-white p-sp-3 night:bg-night-card">
          <div className="flex items-center justify-between gap-sp-3 px-sp-2">
            <h2 className="flex items-center gap-sp-2 text-fs-18 font-extrabold text-slate-900 night:text-night-text">
              {selected ? <ZoneIcon name={selected.name} className="size-5 text-slate-500 night:text-night-muted" /> : null}
              {selected?.name ?? 'No zones yet'}
            </h2>
            {selected ? (
              <button type="button" className={primary} onClick={() => setEditing({ mode: 'new' })}>
                <Plus className="size-4" aria-hidden="true" /> Add table
              </button>
            ) : null}
          </div>
          {selected && selected.tables.length === 0 ? (
            <p className="px-sp-2 py-sp-4 text-fs-14 text-slate-600 night:text-night-second">
              No tables in this zone. A zone shows on the floor once it has a table.
            </p>
          ) : null}
          {selected ? (
            <SortableList
              items={selected.tables}
              disabled={busy}
              label={(table) => table.label}
              className="flex flex-col divide-y divide-slate-100 night:divide-night-hairline"
              onReorder={(ids) => reorder('table', selected.id, ids)}
              renderItem={(table, handle) => (
                <TableRow
                  key={table.version}
                  table={table}
                  handle={handle}
                  busy={busy}
                  onEdit={() => setEditing({ mode: 'edit', tableId: table.id })}
                  onRemove={() =>
                    setConfirm({
                      text: `Remove ${table.label} from the floor?`,
                      note: 'Past orders, bills and receipts keep it. You can restore a removed table.',
                      run: async () => {
                        await run('DELETE', `/api/manage/floor/tables/${table.id}?version=${table.version}`)
                      },
                    })
                  }
                />
              )}
            />
          ) : null}
        </section>
      </div>

      {showRemoved ? (
        <section aria-label="Removed tables" className="flex flex-col gap-sp-2 rounded-panel bg-white p-sp-3 night:bg-night-card">
          <h2 className="px-sp-2 text-fs-14 font-bold tracking-micro text-slate-500 uppercase night:text-night-muted">Removed tables</h2>
          {removed.length === 0 ? <p className="px-sp-2 text-fs-14 text-slate-600 night:text-night-second">No removed tables.</p> : null}
          <ul className="flex flex-col divide-y divide-slate-100 night:divide-night-hairline">
            {removed.map((table) => {
              const ownZoneActive = zones.some((zone) => zone.id === table.zoneId)
              return (
                <li key={table.id + table.version} className="flex flex-wrap items-center gap-sp-2 py-sp-2 pl-sp-2">
                  <span className="min-w-0 flex-1 text-fs-16 font-bold text-slate-400 line-through night:text-night-muted">{table.label}</span>
                  <span className="text-fs-12 text-slate-500 night:text-night-muted">{table.zoneName}</span>
                  <button
                    type="button"
                    className={secondary}
                    disabled={busy || (!ownZoneActive && !selected)}
                    onClick={() => restore(table)}
                  >
                    <Undo2 className="size-4" aria-hidden="true" />
                    {ownZoneActive || !selected ? 'Restore' : `Restore to ${selected.name}`}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {editing && selected ? (
        <TableSheet
          key={editing.mode === 'edit' ? `${editingTable?.id}${editingTable?.version}` : 'new'}
          table={editing.mode === 'edit' ? editingTable : null}
          zones={zones}
          defaultZoneId={selected.id}
          busy={busy}
          run={run}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          text={confirm.text}
          note={confirm.note}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await confirm.run()
            setConfirm(null)
          }}
        />
      ) : null}
    </div>
  )
}

// ── Zones ────────────────────────────────────────────────────────────────────

function ZoneRow({
  zone,
  handle,
  selected,
  busy,
  onSelect,
  onRename,
  onRemove,
}: {
  zone: ManageZone
  handle: ReactNode
  selected: boolean
  busy: boolean
  onSelect: () => void
  onRename: (name: string) => Promise<unknown>
  onRemove: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(zone.name)
  return (
    <div className="flex items-center">
      {handle}
      {renaming ? (
        <form
          className="flex min-w-0 flex-1 gap-sp-1"
          onSubmit={async (event) => {
            event.preventDefault()
            await onRename(name)
          }}
        >
          <input aria-label="Zone name" autoFocus maxLength={40} className={cn(input, 'min-w-0 flex-1')} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className={primary} disabled={busy || name.trim() === ''}>Save</button>
          <button type="button" aria-label="Cancel" className={icon} onClick={() => setRenaming(false)}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </form>
      ) : (
        <div className={cn('flex min-w-0 flex-1 items-center rounded-control', selected ? 'bg-brand-050 night:bg-night-raised' : '')}>
          <button
            type="button"
            aria-current={selected ? 'true' : undefined}
            onClick={onSelect}
            className={cn(
              'flex min-h-11 min-w-0 flex-1 items-center gap-sp-2 rounded-control px-sp-3 text-left text-fs-14 font-semibold whitespace-nowrap',
              selected ? 'text-brand-800 night:text-brand-300' : 'text-slate-700 hover:bg-slate-100 night:text-night-second night:hover:bg-night-raised',
            )}
          >
            <ZoneIcon name={zone.name} className="size-4 shrink-0 text-slate-500 night:text-night-muted" />
            <span className="truncate">{zone.name}</span>
            <span className="text-fs-12 text-slate-500 night:text-night-muted">{zone.tables.length}</span>
          </button>
          {selected ? (
            <span className="flex">
              <button type="button" aria-label={`Rename ${zone.name}`} className={icon} onClick={() => setRenaming(true)}>
                <Pencil className="size-4" aria-hidden="true" />
              </button>
              <button type="button" aria-label={`Remove ${zone.name}`} className={icon} disabled={busy} onClick={onRemove}>
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

function AddZone({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState('')
  return (
    <form
      className="flex gap-sp-1 border-t border-slate-100 pt-sp-2 night:border-night-hairline"
      onSubmit={async (event) => {
        event.preventDefault()
        if (await onAdd(name)) setName('')
      }}
    >
      <input aria-label="New zone name" placeholder="New zone" maxLength={40} className={cn(input, 'min-w-0 flex-1')} value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className={secondary} disabled={busy || name.trim() === ''}>
        <Plus className="size-4" aria-hidden="true" /> Add
      </button>
    </form>
  )
}

// ── Tables ───────────────────────────────────────────────────────────────────

function TableRow({
  table,
  handle,
  busy,
  onEdit,
  onRemove,
}: {
  table: ManageTable
  handle: ReactNode
  busy: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const occupied = table.inUse || table.status === 'occupied'
  return (
    <div className="flex flex-wrap items-center gap-sp-2 py-sp-2 pr-sp-2">
      {handle}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-sp-2">
        <span className="text-fs-16 font-bold text-slate-900 night:text-night-text">{table.label}</span>
        {table.capacity ? (
          <span className="inline-flex items-center gap-sp-1 text-fs-12 text-slate-600 night:text-night-second">
            <Users className="size-3.5" aria-hidden="true" /> {table.capacity} seats
          </span>
        ) : null}
        {occupied ? (
          <span className="rounded-pill bg-brand-050 px-sp-2 py-0.5 text-fs-12 font-semibold text-brand-800 night:bg-night-raised night:text-brand-300">Occupied</span>
        ) : null}
        {table.status === 'unavailable' ? (
          <span className="rounded-pill bg-amber-50 px-sp-2 py-0.5 text-fs-12 font-semibold text-amber-900 night:bg-amber-500/10 night:text-amber-300">Out of service</span>
        ) : null}
      </div>
      <button type="button" aria-label={`Edit ${table.label}`} className={icon} onClick={onEdit}>
        <Pencil className="size-4" aria-hidden="true" />
      </button>
      <button type="button" aria-label={`Remove ${table.label}`} className={icon} disabled={busy} onClick={onRemove}>
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

/** Seats as typed: '' is "not set"; anything else must be a whole number (the server checks 1–30). */
function seatsValue(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

function TableSheet({
  table,
  zones,
  defaultZoneId,
  busy,
  run,
  onClose,
}: {
  table: ManageTable | null
  zones: ManageZone[]
  defaultZoneId: string
  busy: boolean
  run: Run
  onClose: () => void
}) {
  const [label, setLabel] = useState(table?.label ?? '')
  const [seats, setSeats] = useState(table?.capacity ? String(table.capacity) : '')
  const [zoneId, setZoneId] = useState(table?.zoneId ?? defaultZoneId)
  const capacity = seatsValue(seats)
  const valid = label.trim() !== '' && capacity !== undefined

  async function save() {
    if (!valid) return
    const result = table
      ? await run('PATCH', `/api/manage/floor/tables/${table.id}`, {
          version: table.version,
          label,
          capacity,
          ...(zoneId !== table.zoneId ? { zoneId } : {}),
        })
      : await run('POST', `/api/manage/floor/zones/${zoneId}/tables`, { label, capacity })
    if (result) onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="table-sheet-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex items-center justify-between">
          <h2 id="table-sheet-title" className="text-fs-20 font-extrabold text-slate-900 night:text-night-text">
            {table ? table.label : 'New table'}
          </h2>
          <button type="button" aria-label="Close" className={icon} onClick={onClose}>
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
        {table && (table.inUse || table.status === 'occupied') ? (
          <p className="text-fs-14 text-slate-600 night:text-night-second">An order is open on this table. It stays on it if you rename or move it.</p>
        ) : null}
        <form
          className="flex flex-col gap-sp-3"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Label</span>
            <input autoFocus maxLength={20} className={input} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Table 7" />
          </label>
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Seats (optional)</span>
            <input inputMode="numeric" maxLength={2} className={input} value={seats} onChange={(e) => setSeats(e.target.value)} placeholder="4" />
            {capacity === undefined ? <span className="text-fs-12 text-red-700 night:text-red-400">A whole number, 1 to 30</span> : null}
          </label>
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Zone</span>
            <select className={input} value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>{zone.name}</option>
              ))}
            </select>
          </label>
          <button type="submit" className={primary} disabled={busy || !valid}>
            {table ? 'Save table' : 'Add table'}
          </button>
        </form>
      </div>
    </div>
  )
}

/** The floor's own icon for a zone, by its name (`zoneIcon`). */
// `createElement`, not `<Icon />`: the lookup RETURNS a component, and the
// React Compiler refuses one created during render.
function ZoneIcon({ name, className }: { name: string; className?: string }) {
  return createElement(zoneIcon(name), { 'aria-hidden': true, className })
}
