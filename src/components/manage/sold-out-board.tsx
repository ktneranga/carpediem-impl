'use client'

import { createElement, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, RotateCcw, Search, X } from 'lucide-react'
import { ConfirmDialog, icon, input, secondary } from '@/components/manage/manage-ui'
import type { ManageCategory, ManageItem, ManageOption } from '@/server/services/menu-admin.service'
import { useSocketEvent } from '@/hooks/use-socket'
import { menuCategoryIcon } from '@/lib/design'
import { lkrFromPaisa } from '@/lib/format'
import { isDrinksCategory } from '@/lib/menu-sections'
import { loginUrl } from '@/lib/return-to'
import { cn } from '@/lib/utils'

/**
 * Manage → Sold out (Story 8.3): mark a dish or an option sold out, and back
 * on, mid-service. Owner and waiters, no Manage password.
 *
 * Last write wins — no version is sent. A tap flips the switch at once
 * (`pending`); the server's answer patches the cache, a failure flips it back
 * with a short message. Rows are keyed by id only, so a switch never remounts
 * under a finger. Another tablet's toggle arrives as `menu:item_updated` or
 * `menu:changed` and reloads the board.
 */

const QUERY_KEY = ['sold-out'] as const
const FAILED = 'Could not save. Try again.'

type Side = 'Food' | 'Drinks'
type Kind = 'item' | 'option'
const keyOf = (kind: Kind, id: string) => `${kind}:${id}`

class RequestError extends Error {}

/** A copy of `record` without `key`. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record }
  delete copy[key]
  return copy
}

/** One request. A 401 means the PIN session ended: back to the pad, and back here after. */
async function request(method: string, url: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await response.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null
  if (response.status === 401) window.location.assign(loginUrl())
  if (!response.ok) throw new RequestError(json?.error?.message ?? FAILED)
  return json?.data
}

/** The board with one dish or option's switch set — the server's answer, written into the cache. */
function withAvailable(categories: ManageCategory[], kind: Kind, id: string, available: boolean): ManageCategory[] {
  return categories.map((category) => ({
    ...category,
    items: category.items.map((item) =>
      kind === 'item'
        ? item.id === id ? { ...item, isAvailable: available } : item
        : {
            ...item,
            groups: item.groups.map((group) => ({
              ...group,
              options: group.options.map((option) => (option.id === id ? { ...option, isAvailable: available } : option)),
            })),
          },
    ),
  }))
}

export function SoldOutBoard() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [side, setSide] = useState<Side>('Food')
  const [openDishes, setOpenDishes] = useState<Record<string, boolean>>({})
  /** Switches flipped on screen while their save is in flight: key → the new value. */
  const [pending, setPending] = useState<Record<string, boolean>>({})
  /** Rows whose last save failed: key → the message. */
  const [failed, setFailed] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  const { data: categories = [], isLoading, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await request('GET', '/api/menu-items/sold-out')) as ManageCategory[],
  })

  // Another tablet (or Manage → Menu) changed something: reload.
  useSocketEvent('menu:item_updated', () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  })
  useSocketEvent('menu:changed', () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  })

  const shown = (kind: Kind, id: string, server: boolean) => pending[keyOf(kind, id)] ?? server

  async function toggle(kind: Kind, id: string, available: boolean) {
    const key = keyOf(kind, id)
    if (key in pending) return // a double tap while saving
    setPending((current) => ({ ...current, [key]: available }))
    setFailed((current) => without(current, key))
    try {
      const url = kind === 'item' ? `/api/menu-items/${id}/availability` : `/api/menu-options/${id}/availability`
      const saved = (await request('PATCH', url, { available })) as { available: boolean }
      queryClient.setQueryData<ManageCategory[]>(QUERY_KEY, (current) =>
        current ? withAvailable(current, kind, id, saved.available) : current,
      )
    } catch {
      setFailed((current) => ({ ...current, [key]: FAILED }))
    } finally {
      setPending((current) => without(current, key))
    }
  }

  // ── What is off right now — dishes and options, as the screen shows them ──
  const allItems = categories.flatMap((category) => category.items)
  const offItems = allItems.filter((item) => !shown('item', item.id, item.isAvailable))
  const offOptions = allItems.flatMap((item) =>
    item.groups.flatMap((group) =>
      group.options
        .filter((option) => !shown('option', option.id, option.isAvailable))
        .map((option) => ({ option, item, groupName: group.name })),
    ),
  )
  const offCount = offItems.length + offOptions.length

  async function resetAll() {
    setResetting(true)
    setMessage(null)
    try {
      const { count } = (await request('POST', '/api/menu-items/availability/reset')) as { count: number }
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      setMessage(count === 1 ? '1 item is back on.' : `${count} items are back on.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : FAILED)
    } finally {
      setResetting(false)
      setConfirmReset(false)
    }
  }

  // ── The list: one side, or every dish matching the search ─────────────────
  const term = search.trim().toLowerCase()
  const listed = categories
    .filter((category) => category.items.length > 0)
    .filter((category) => term !== '' || (isDrinksCategory(category) ? 'Drinks' : 'Food') === side)
    .map((category) => ({
      ...category,
      items: term === '' ? category.items : category.items.filter((item) => item.name.toLowerCase().includes(term)),
    }))
    .filter((category) => category.items.length > 0)

  const row = { shown, pending, failed, toggle }

  return (
    <div className="flex max-w-3xl flex-col gap-sp-4">
      <header className="flex flex-col gap-sp-3">
        <h1 className="text-fs-24 font-extrabold text-slate-900">Sold out</h1>
        <label className="relative flex items-center">
          <span className="sr-only">Find a dish</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-sp-3 size-4 text-slate-500" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a dish"
            className={cn(input, 'w-full pl-10')}
          />
        </label>
      </header>

      {message ? (
        <p role="status" className="flex items-center justify-between gap-sp-3 rounded-control bg-slate-50 px-sp-4 py-sp-3 text-fs-14 font-semibold text-slate-800">
          {message}
          <button type="button" aria-label="Dismiss" className={icon} onClick={() => setMessage(null)}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {offCount > 0 ? (
        <section aria-labelledby="off-now" className="flex flex-col gap-sp-2 rounded-panel border border-unavailable-edge bg-unavailable-body p-sp-3">
          <div className="flex flex-wrap items-center justify-between gap-sp-2">
            <h2 id="off-now" className="text-fs-18 font-extrabold text-unavailable-ink">Sold out now ({offCount})</h2>
            <button type="button" className={secondary} disabled={resetting} onClick={() => setConfirmReset(true)}>
              <RotateCcw className="size-4" aria-hidden="true" /> Put everything back on
            </button>
          </div>
          <ul className="flex flex-col divide-y divide-unavailable-chip">
            {offItems.map((item) => (
              <li key={keyOf('item', item.id)}>
                <ToggleRow {...row} kind="item" id={item.id} name={item.name} detail={lkrFromPaisa(item.pricePaisa)} server={item.isAvailable} />
              </li>
            ))}
            {offOptions.map(({ option, item, groupName }) => (
              <li key={keyOf('option', option.id)}>
                <ToggleRow {...row} kind="option" id={option.id} name={option.name} detail={`${item.name} · ${groupName}`} server={option.isAvailable} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div role="group" aria-label="Food or drinks" className="flex gap-sp-2">
        {(['Food', 'Drinks'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={term === '' && side === value}
            disabled={term !== ''}
            onClick={() => setSide(value)}
            className={cn(
              'h-11 rounded-pill px-sp-4 text-fs-14 font-bold disabled:opacity-50',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              term === '' && side === value ? 'bg-brand-800 text-white' : 'border border-slate-200 bg-white text-slate-900',
            )}
          >
            {value}
          </button>
        ))}
        {term !== '' ? <span className="self-center text-fs-12 font-semibold text-slate-600">Searching the whole menu</span> : null}
      </div>

      {isLoading ? <p className="text-fs-14 text-slate-600">Loading the menu…</p> : null}
      {isError ? <p role="alert" className="text-fs-14 font-semibold text-unavailable-ink">Could not load the menu. Reload to try again.</p> : null}
      {!isLoading && !isError && listed.length === 0 ? (
        <p className="text-fs-14 text-slate-600">{term ? `No dish matches “${search.trim().slice(0, 40)}”.` : 'No dishes here.'}</p>
      ) : null}

      {listed.map((category) => (
        <section key={category.id} aria-label={category.name} className="flex flex-col rounded-panel bg-white p-sp-3">
          <h2 className="flex items-center gap-sp-2 px-sp-1 pb-sp-2 text-fs-16 font-extrabold text-slate-900">
            <CategoryIcon name={category.name} className="size-4 text-slate-600" />
            {category.name}
          </h2>
          <ul className="flex flex-col divide-y divide-slate-100">
            {category.items.map((item) => (
              <li key={item.id}>
                <ToggleRow {...row} kind="item" id={item.id} name={item.name} detail={lkrFromPaisa(item.pricePaisa)} server={item.isAvailable} />
                {item.groups.some((group) => group.options.length > 0) ? (
                  <DishOptions
                    {...row}
                    item={item}
                    open={!!openDishes[item.id]}
                    onOpen={() => setOpenDishes((current) => ({ ...current, [item.id]: !current[item.id] }))}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {confirmReset ? (
        <ConfirmDialog
          text={`Put ${offCount} item${offCount === 1 ? '' : 's'} back on?`}
          note="Every sold-out dish and option goes back on every tablet."
          confirmLabel="Put back on"
          busy={resetting}
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => void resetAll()}
        />
      ) : null}
    </div>
  )
}

type RowProps = {
  shown: (kind: Kind, id: string, server: boolean) => boolean
  pending: Record<string, boolean>
  failed: Record<string, string>
  toggle: (kind: Kind, id: string, available: boolean) => Promise<void>
}

function ToggleRow({
  kind,
  id,
  name,
  detail,
  server,
  shown,
  pending,
  failed,
  toggle,
  nested = false,
}: RowProps & { kind: Kind; id: string; name: string; detail: string; server: boolean; nested?: boolean }) {
  const key = keyOf(kind, id)
  const on = shown(kind, id, server)
  return (
    <div className={cn('flex flex-col py-sp-2', nested ? 'pl-sp-4' : 'px-sp-1')}>
      <div className="flex items-center gap-sp-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn(nested ? 'text-fs-14' : 'text-fs-16', 'font-bold', on ? 'text-slate-900' : 'text-unavailable-ink line-through')}>
            {name}
          </span>
          <span className="text-fs-12 text-slate-600 tabular-nums">{detail}</span>
        </div>
        <Switch on={on} label={name} saving={key in pending} onToggle={() => void toggle(kind, id, !on)} />
      </div>
      {failed[key] ? (
        <p role="alert" className="pt-sp-1 text-right text-fs-12 font-semibold text-unavailable-ink">{failed[key]}</p>
      ) : null}
    </div>
  )
}

/** The "Options" disclosure under a dish: each active option with its own switch. */
function DishOptions({ item, open, onOpen, ...row }: RowProps & { item: ManageItem; open: boolean; onOpen: () => void }) {
  const off = item.groups
    .flatMap((group) => group.options)
    .filter((option: ManageOption) => !row.shown('option', option.id, option.isAvailable)).length
  return (
    <div className="pb-sp-2 pl-sp-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={onOpen}
        className="inline-flex min-h-11 items-center gap-sp-1 rounded-control px-sp-2 text-fs-12 font-semibold text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-500"
      >
        {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
        Options{off > 0 ? ` (${off} sold out)` : ''}
      </button>
      {open
        ? item.groups
            .filter((group) => group.options.length > 0)
            .map((group) => (
              <div key={group.id} className="flex flex-col">
                <p className="pl-sp-4 pt-sp-1 text-fs-12 font-bold uppercase tracking-wide text-slate-500">{group.name}</p>
                {group.options.map((option) => (
                  <ToggleRow
                    key={option.id}
                    {...row}
                    kind="option"
                    id={option.id}
                    name={option.name}
                    detail={option.priceDeltaPaisa === 0 ? 'No extra charge' : lkrFromPaisa(option.priceDeltaPaisa)}
                    server={option.isAvailable}
                    nested
                  />
                ))}
              </div>
            ))
        : null}
    </div>
  )
}

/** A switch with its state in words: "Available" or "Sold out". 44px tall. */
function Switch({ on, label, saving, onToggle }: { on: boolean; label: string; saving: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${label} available`}
      aria-busy={saving}
      onClick={() => {
        if (!saving) onToggle()
      }}
      className={cn(
        'inline-flex h-11 w-36 shrink-0 items-center gap-sp-2 rounded-pill border-2 px-sp-1 text-fs-14 font-bold',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        on ? 'border-open-edge bg-open-body text-open-ink' : 'flex-row-reverse border-unavailable-band bg-unavailable-band text-white',
        saving && 'opacity-70',
      )}
    >
      <span aria-hidden="true" className={cn('size-8 shrink-0 rounded-pill', on ? 'bg-open-band' : 'bg-white')} />
      <span className="flex-1 text-center">{on ? 'Available' : 'Sold out'}</span>
    </button>
  )
}

/** The order screen's icon for a category (`createElement`: the lookup returns a component). */
function CategoryIcon({ name, className }: { name: string; className?: string }) {
  return createElement(menuCategoryIcon(name), { 'aria-hidden': true, className })
}
