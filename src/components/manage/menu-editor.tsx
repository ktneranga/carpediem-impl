'use client'

import { createElement, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2, Undo2, X } from 'lucide-react'
import { SortableList } from '@/components/manage/sortable-list'
import type { ManageCategory, ManageGroup, ManageItem, ManageOption } from '@/server/services/menu-admin.service'
import { menuCategoryIcon, routeForDestination } from '@/lib/design'
import { lkrFromPaisa, paisaFromLkrInput, signedLkrFromPaisa } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Manage → Menu (Story 10.4).
 *
 * Every save goes to `/api/manage/menu/...` with the version the screen loaded;
 * the server refuses a stale one (409 STALE) and the screen reloads. Each row is
 * keyed on `id + version`, so after any save it remounts with the server's
 * values — no draft state survives a reload, and no ref is read during render.
 * Prices are typed in whole rupees and sent as paisa.
 */

type Destination = ManageItem['productionDestination']
const DESTINATIONS: { value: Destination; label: string }[] = [
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'pizza_kitchen', label: 'Pizza kitchen' },
  { value: 'bar', label: 'Bar' },
]

/**
 * A drinks category, the order screen's rule (`menu-browser.tsx`): a drink is a
 * dish the BAR makes. A category whose active dishes all print at the bar is
 * listed under Drinks; anything else, and an empty one, under Food.
 */
function isDrinksCategory(category: ManageCategory): boolean {
  const active = category.items.filter((item) => item.isActive)
  return active.length > 0 && active.every((item) => item.productionDestination === 'bar')
}

/** The station chip, in the same colour and icon as the order screen's. */
function StationChip({ destination }: { destination: Destination }) {
  const route = routeForDestination(destination)
  return (
    <span className={cn('inline-flex items-center gap-sp-1 rounded-pill px-sp-2 py-0.5 text-fs-12 font-semibold text-white', route.chip)}>
      {createElement(route.icon, { 'aria-hidden': true, className: 'size-3.5' })}
      {route.short}
    </span>
  )
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call(method: string, url: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  if (!response.ok) {
    if (response.status === 401) {
      // The Manage session or the PIN session ended: back through the gate.
      window.location.assign(`/manage/unlock?next=${encodeURIComponent('/manage/menu')}`)
    }
    throw new ApiError(json?.error?.code ?? 'ERROR', json?.error?.message ?? 'Could not save the change')
  }
  return json
}

const input = cn(
  'h-11 rounded-control border border-slate-300 bg-white px-sp-3 text-fs-14 text-slate-900',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500',
)
const button = cn(
  'inline-flex h-11 shrink-0 items-center justify-center gap-sp-1 rounded-control px-sp-3 text-fs-14 font-bold',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50',
)
const primary = cn(button, 'bg-brand-800 text-white')
const secondary = cn(button, 'border border-slate-200 bg-white text-slate-900 hover:bg-slate-50')
const icon = cn(
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-slate-600 hover:bg-slate-100',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-30',
)

export function MenuEditor() {
  const queryClient = useQueryClient()
  const [showRemoved, setShowRemoved] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; itemId: string } | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; run: () => Promise<void> } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const queryKey = ['manage-menu', showRemoved] as const
  const { data: categories = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () =>
      ((await call('GET', `/api/manage/menu${showRemoved ? '?removed=1' : ''}`)) as { data: ManageCategory[] }).data,
  })

  const selected = categories.find((c) => c.id === selectedId) ?? categories[0] ?? null
  const editingItem =
    editing?.mode === 'edit' ? categories.flatMap((c) => c.items).find((i) => i.id === editing.itemId) ?? null : null

  /** Runs a save; on success reloads the menu; on failure shows why (and reloads on STALE). */
  async function run(method: string, url: string, body?: unknown): Promise<unknown> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await call(method, url, body)
      await queryClient.invalidateQueries({ queryKey: ['manage-menu'] })
      return result
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the change')
      if (error instanceof ApiError && error.code === 'STALE') {
        await queryClient.invalidateQueries({ queryKey: ['manage-menu'] })
      }
      return null
    } finally {
      setBusy(false)
    }
  }

  /** A drag and drop: the new order of one whole list (Teran, 2026-11-13). */
  const reorder: Reorder = (kind, parentId, ids) => run('POST', '/api/manage/menu/reorder', { kind, parentId, ids })

  return (
    <div className="flex flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <h1 className="text-fs-24 font-extrabold text-slate-900">Menu</h1>
        <label className="flex min-h-11 items-center gap-sp-2 text-fs-14 font-semibold text-slate-700">
          <input type="checkbox" className="size-5" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
          Show removed dishes
        </label>
      </header>

      {message ? (
        <p role="alert" className="flex items-center justify-between gap-sp-3 rounded-control bg-amber-50 px-sp-4 py-sp-3 text-fs-14 font-semibold text-amber-900">
          {message}
          <button type="button" aria-label="Dismiss" className={icon} onClick={() => setMessage(null)}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {isLoading ? <p className="text-fs-14 text-slate-600">Loading the menu…</p> : null}

      <div className="flex flex-col gap-sp-4 lg:flex-row lg:items-start">
        {/* ── Categories ─────────────────────────────────────────────────── */}
        <section aria-label="Categories" className="flex flex-col gap-sp-2 rounded-panel bg-white p-sp-3 lg:w-72 lg:shrink-0">
          <h2 className="px-sp-2 text-fs-14 font-bold tracking-micro text-slate-500 uppercase">Categories</h2>
          {(['Food', 'Drinks'] as const).map((side) => {
            const list = categories.filter((category) => isDrinksCategory(category) === (side === 'Drinks'))
            if (list.length === 0) return null
            return (
              <div key={side} className="flex flex-col gap-sp-1">
                <h3 className="px-sp-2 pt-sp-2 text-fs-12 font-bold text-slate-500">{side}</h3>
                <SortableList
                  items={list}
                  disabled={busy}
                  label={(category) => category.name}
                  className="flex flex-col gap-sp-1"
                  // One shared order for every category: the dragged side's
                  // categories take their new order in the slots they held.
                  onReorder={(sideIds) => {
                    const queue = [...sideIds]
                    const ids = categories.map((category) =>
                      isDrinksCategory(category) === (side === 'Drinks') ? queue.shift()! : category.id,
                    )
                    return reorder('category', null, ids)
                  }}
                  renderItem={(category, handle) => (
                    <CategoryRow
                      key={category.version}
                      category={category}
                      handle={handle}
                      selected={selected?.id === category.id}
                      busy={busy}
                      onSelect={() => setSelectedId(category.id)}
                      onRename={(name) => run('PATCH', `/api/manage/menu/categories/${category.id}`, { version: category.version, name })}
                      onRemove={() =>
                        setConfirm({
                          text: `Remove the category "${category.name}"?`,
                          run: async () => {
                            await run('DELETE', `/api/manage/menu/categories/${category.id}?version=${category.version}`)
                          },
                        })
                      }
                    />
                  )}
                />
              </div>
            )
          })}
          <AddCategory busy={busy} onAdd={(name) => run('POST', '/api/manage/menu/categories', { name })} />
        </section>

        {/* ── Dishes ─────────────────────────────────────────────────────── */}
        <section aria-label="Dishes" className="flex min-w-0 flex-1 flex-col gap-sp-2 rounded-panel bg-white p-sp-3">
          <div className="flex items-center justify-between gap-sp-3 px-sp-2">
            <h2 className="flex items-center gap-sp-2 text-fs-18 font-extrabold text-slate-900">
              {selected ? <CategoryIcon name={selected.name} className="size-5 text-slate-500" /> : null}
              {selected?.name ?? 'No categories yet'}
            </h2>
            {selected ? (
              <button type="button" className={primary} onClick={() => setEditing({ mode: 'new' })}>
                <Plus className="size-4" aria-hidden="true" /> Add dish
              </button>
            ) : null}
          </div>
          {selected && selected.items.length === 0 ? (
            <p className="px-sp-2 py-sp-4 text-fs-14 text-slate-600">No dishes in this category.</p>
          ) : null}
          {selected ? (
            <SortableList
              items={selected.items.filter((item) => item.isActive)}
              disabled={busy}
              label={(item) => item.name}
              className="flex flex-col divide-y divide-slate-100"
              onReorder={(ids) => reorder('item', selected.id, ids)}
              renderItem={(item, handle) => (
                <DishRow
                  item={item}
                  handle={handle}
                  busy={busy}
                  onEdit={() => setEditing({ mode: 'edit', itemId: item.id })}
                  onRemove={() =>
                    setConfirm({
                      text: `Remove ${item.name} from the menu?`,
                      run: async () => {
                        await run('DELETE', `/api/manage/menu/items/${item.id}?version=${item.version}`)
                      },
                    })
                  }
                  onRestore={() => run('POST', `/api/manage/menu/items/${item.id}/restore`, { version: item.version })}
                />
              )}
            />
          ) : null}
          {selected && selected.items.some((item) => !item.isActive) ? (
            <ul className="flex flex-col divide-y divide-slate-100 border-t border-slate-200">
              {selected.items
                .filter((item) => !item.isActive)
                .map((item) => (
                  <li key={item.id + item.version}>
                    <DishRow
                      item={item}
                      handle={null}
                      busy={busy}
                      onEdit={() => {}}
                      onRemove={() => {}}
                      onRestore={() => run('POST', `/api/manage/menu/items/${item.id}/restore`, { version: item.version })}
                    />
                  </li>
                ))}
            </ul>
          ) : null}
        </section>
      </div>

      {editing && selected ? (
        <ItemSheet
          key={editing.mode === 'edit' ? `${editingItem?.id}${editingItem?.version}` : 'new'}
          item={editing.mode === 'edit' ? editingItem : null}
          categories={categories}
          defaultCategoryId={selected.id}
          defaultDestination={isDrinksCategory(selected) ? 'bar' : 'kitchen'}
          busy={busy}
          run={run}
          reorder={reorder}
          confirm={(text, action) => setConfirm({ text, run: action })}
          onClose={() => setEditing(null)}
          onCreated={(id) => setEditing({ mode: 'edit', itemId: id })}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          text={confirm.text}
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

// ── Categories ───────────────────────────────────────────────────────────────

function CategoryRow({
  category,
  handle,
  selected,
  busy,
  onSelect,
  onRename,
  onRemove,
}: {
  category: ManageCategory
  handle: ReactNode
  selected: boolean
  busy: boolean
  onSelect: () => void
  onRename: (name: string) => Promise<unknown>
  onRemove: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(category.name)
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
          <input aria-label="Category name" autoFocus maxLength={60} className={cn(input, 'min-w-0 flex-1')} value={name} onChange={(e) => setName(e.target.value)} />
          <button type="submit" className={primary} disabled={busy || name.trim() === ''}>Save</button>
          <button type="button" aria-label="Cancel" className={icon} onClick={() => setRenaming(false)}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </form>
      ) : (
        <div className={cn('flex min-w-0 flex-1 items-center rounded-control', selected ? 'bg-brand-050' : '')}>
          <button
            type="button"
            aria-current={selected ? 'true' : undefined}
            onClick={onSelect}
            className={cn(
              'flex min-h-11 min-w-0 flex-1 items-center gap-sp-2 rounded-control px-sp-3 text-left text-fs-14 font-semibold whitespace-nowrap',
              selected ? 'text-brand-800' : 'text-slate-700 hover:bg-slate-100',
            )}
          >
            <CategoryIcon name={category.name} className="size-4 shrink-0 text-slate-500" />
            <span className="truncate">{category.name}</span>
            <span className="text-fs-12 text-slate-500">{category.items.filter((i) => i.isActive).length}</span>
          </button>
          {selected ? (
            <span className="flex">
              <button type="button" aria-label={`Rename ${category.name}`} className={icon} onClick={() => setRenaming(true)}>
                <Pencil className="size-4" aria-hidden="true" />
              </button>
              <button type="button" aria-label={`Remove ${category.name}`} className={icon} disabled={busy} onClick={onRemove}>
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}

function DishRow({
  item,
  handle,
  busy,
  onEdit,
  onRemove,
  onRestore,
}: {
  item: ManageItem
  handle: ReactNode
  busy: boolean
  onEdit: () => void
  onRemove: () => void
  onRestore: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-sp-2 py-sp-2 pr-sp-2">
      {handle ?? <span className="size-11 shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn('text-fs-16 font-bold', item.isActive ? 'text-slate-900' : 'text-slate-400 line-through')}>
          {item.name}
        </span>
        <span className="flex flex-wrap items-center gap-sp-2 text-fs-12 text-slate-600">
          <StationChip destination={item.productionDestination} />
          {item.groups.length > 0 ? `${item.groups.length} option group${item.groups.length === 1 ? '' : 's'}` : ''}
          {item.isActive ? '' : 'removed'}
        </span>
      </div>
      <span className="text-fs-16 font-bold tabular-nums text-slate-900">{lkrFromPaisa(item.pricePaisa)}</span>
      {item.isActive ? (
        <>
          <button type="button" aria-label={`Edit ${item.name}`} className={icon} onClick={onEdit}>
            <Pencil className="size-4" aria-hidden="true" />
          </button>
          <button type="button" aria-label={`Remove ${item.name}`} className={icon} disabled={busy} onClick={onRemove}>
            <Trash2 className="size-4" aria-hidden="true" />
          </button>
        </>
      ) : (
        <button type="button" className={secondary} disabled={busy} onClick={onRestore}>
          <Undo2 className="size-4" aria-hidden="true" /> Restore
        </button>
      )}
    </div>
  )
}

function AddCategory({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState('')
  return (
    <form
      className="flex gap-sp-1 border-t border-slate-100 pt-sp-2"
      onSubmit={async (event) => {
        event.preventDefault()
        if (await onAdd(name)) setName('')
      }}
    >
      <input aria-label="New category name" placeholder="New category" maxLength={60} className={cn(input, 'min-w-0 flex-1')} value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit" className={secondary} disabled={busy || name.trim() === ''}>
        <Plus className="size-4" aria-hidden="true" /> Add
      </button>
    </form>
  )
}

// ── A dish and its options ───────────────────────────────────────────────────

type Run = (method: string, url: string, body?: unknown) => Promise<unknown>
type Reorder = (kind: 'category' | 'item' | 'group' | 'option', parentId: string | null, ids: string[]) => Promise<unknown>

function ItemSheet({
  item,
  categories,
  defaultCategoryId,
  defaultDestination,
  busy,
  run,
  reorder,
  confirm,
  onClose,
  onCreated,
}: {
  item: ManageItem | null
  categories: ManageCategory[]
  defaultCategoryId: string
  defaultDestination: Destination
  busy: boolean
  run: Run
  reorder: Reorder
  confirm: (text: string, action: () => Promise<void>) => void
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [name, setName] = useState(item?.name ?? '')
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? defaultCategoryId)
  const [price, setPrice] = useState(item ? String(item.pricePaisa / 100) : '')
  const [destination, setDestination] = useState<Destination>(item?.productionDestination ?? defaultDestination)
  const pricePaisa = paisaFromLkrInput(price)
  const valid = name.trim() !== '' && pricePaisa !== null

  async function save() {
    if (!valid) return
    if (item) {
      await run('PATCH', `/api/manage/menu/items/${item.id}`, {
        version: item.version,
        name,
        pricePaisa,
        productionDestination: destination,
        ...(categoryId !== item.categoryId ? { categoryId } : {}),
      })
    } else {
      const result = (await run('POST', '/api/manage/menu/items', {
        categoryId,
        name,
        pricePaisa,
        productionDestination: destination,
      })) as { data?: { id: string } } | null
      if (result?.data?.id) onCreated(result.data.id)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-sheet-title"
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/40"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="flex h-full w-full max-w-2xl flex-col gap-sp-4 overflow-y-auto bg-white p-sp-5 shadow-el-2">
        <div className="flex items-center justify-between">
          <h2 id="item-sheet-title" className="text-fs-20 font-extrabold text-slate-900">
            {item ? item.name : 'New dish'}
          </h2>
          <button type="button" aria-label="Close" className={icon} onClick={onClose}>
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>

        <form
          className="grid gap-sp-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="flex flex-col gap-sp-1 sm:col-span-2">
            <span className="text-fs-14 font-semibold text-slate-700">Name</span>
            <input autoFocus={!item} maxLength={60} className={input} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700">Category</span>
            <select className={input} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700">Price (LKR, whole rupees)</span>
            <input inputMode="numeric" className={input} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1,250" />
            <span className={cn('text-fs-12', pricePaisa === null && price !== '' ? 'text-red-700' : 'text-slate-500')}>
              {price === '' ? ' ' : pricePaisa === null ? 'Whole rupees only, like 1250' : lkrFromPaisa(pricePaisa)}
            </span>
          </label>
          <fieldset className="flex flex-col gap-sp-1 sm:col-span-2">
            <legend className="text-fs-14 font-semibold text-slate-700">Prints at</legend>
            <div className="flex gap-sp-1" role="radiogroup">
              {DESTINATIONS.map((d) => {
                return (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={destination === d.value}
                  onClick={() => setDestination(d.value)}
                  className={cn(button, 'flex-1 border', destination === d.value ? 'border-brand-800 bg-brand-800 text-white' : 'border-slate-200 text-slate-900')}
                >
                  {createElement(routeForDestination(d.value).icon, { 'aria-hidden': true, className: 'size-4' })}
                  {d.label}
                </button>
                )
              })}
            </div>
          </fieldset>
          <div className="sm:col-span-2">
            <button type="submit" className={primary} disabled={busy || !valid}>
              {item ? 'Save dish' : 'Add dish'}
            </button>
          </div>
        </form>

        {item ? (
          <section aria-label="Options" className="flex flex-col gap-sp-3 border-t border-slate-200 pt-sp-4">
            <h3 className="text-fs-18 font-extrabold text-slate-900">Options</h3>
            {item.groups.length === 0 ? <p className="text-fs-14 text-slate-600">No options on this dish.</p> : null}
            <SortableList
              items={item.groups}
              disabled={busy}
              label={(group) => group.name}
              className="flex flex-col gap-sp-3"
              onReorder={(ids) => reorder('group', item.id, ids)}
              renderItem={(group, handle) => (
                <GroupCard
                  key={group.version}
                  group={group}
                  handle={handle}
                  otherGroups={item.groups.filter((g) => g.id !== group.id)}
                  busy={busy}
                  run={run}
                  reorder={reorder}
                  confirm={confirm}
                />
              )}
            />
            <AddGroup busy={busy} onAdd={(body) => run('POST', `/api/manage/menu/items/${item.id}/groups`, body)} />
          </section>
        ) : (
          <p className="text-fs-14 text-slate-600">Add the dish first, then its options.</p>
        )}
      </div>
    </div>
  )
}

function GroupCard({
  group,
  handle,
  otherGroups,
  busy,
  run,
  reorder,
  confirm,
}: {
  group: ManageGroup
  handle: ReactNode
  otherGroups: ManageGroup[]
  busy: boolean
  run: Run
  reorder: Reorder
  confirm: (text: string, action: () => Promise<void>) => void
}) {
  const [name, setName] = useState(group.name)
  const [selection, setSelection] = useState(group.selection)
  const [required, setRequired] = useState(group.isRequired)
  const changed = name !== group.name || selection !== group.selection || required !== group.isRequired

  return (
    <div className="flex flex-col gap-sp-3 rounded-panel border border-slate-200 p-sp-3">
      <div className="flex flex-wrap items-center gap-sp-2">
        {handle}
        <input aria-label="Group name" maxLength={60} className={cn(input, 'min-w-40 flex-1 font-bold')} value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label="Choice" className={input} value={selection} onChange={(e) => setSelection(e.target.value as 'single' | 'multi')}>
          <option value="single">Pick one</option>
          <option value="multi">Pick any</option>
        </select>
        <label className="flex min-h-11 items-center gap-sp-2 text-fs-14 text-slate-700">
          <input type="checkbox" className="size-5" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
        </label>
        {changed ? (
          <button type="button" className={primary} disabled={busy || name.trim() === ''} onClick={() => run('PATCH', `/api/manage/menu/groups/${group.id}`, { version: group.version, name, selection, isRequired: required })}>
            Save
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Remove ${group.name}`}
          className={icon}
          disabled={busy}
          onClick={() =>
            confirm(`Remove the option group "${group.name}"?`, async () => {
              await run('DELETE', `/api/manage/menu/groups/${group.id}?version=${group.version}`)
            })
          }
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>

      <SortableList
        items={group.options}
        disabled={busy}
        label={(option) => option.name}
        className="flex flex-col gap-sp-2"
        onReorder={(ids) => reorder('option', group.id, ids)}
        renderItem={(option, optionHandle) => (
          <OptionRow
            key={option.version}
            option={option}
            handle={optionHandle}
            otherGroups={otherGroups}
            busy={busy}
            run={run}
            confirm={confirm}
          />
        )}
      />
      <AddOption busy={busy} otherGroups={otherGroups} onAdd={(body) => run('POST', `/api/manage/menu/groups/${group.id}/options`, body)} />
    </div>
  )
}

type OptionDraft = { name: string; price: string; isDefault: boolean; maxCount: string; excludesGroupId: string }

function OptionFields({ draft, setDraft, otherGroups }: { draft: OptionDraft; setDraft: (d: OptionDraft) => void; otherGroups: ManageGroup[] }) {
  const delta = paisaFromLkrInput(draft.price, { allowNegative: true })
  return (
    <>
      <input aria-label="Option name" placeholder="Option" maxLength={60} className={cn(input, 'min-w-32 flex-1')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      <label className="flex flex-col">
        <input
          aria-label="Price change in LKR"
          placeholder="0"
          className={cn(input, 'w-28', delta === null && draft.price !== '' ? 'border-red-500' : '')}
          value={draft.price}
          onChange={(e) => setDraft({ ...draft, price: e.target.value })}
        />
        <span className="text-fs-12 text-slate-500">{delta === null ? (draft.price === '' ? 'no change' : 'whole rupees') : signedLkrFromPaisa(delta) || 'no change'}</span>
      </label>
      <label className="flex min-h-11 items-center gap-sp-1 text-fs-14 text-slate-700">
        <input type="checkbox" className="size-5" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Default
      </label>
      <label className="flex items-center gap-sp-1 text-fs-14 text-slate-700">
        Max
        <input aria-label="Max per dish" type="number" min={1} max={10} className={cn(input, 'w-16')} value={draft.maxCount} onChange={(e) => setDraft({ ...draft, maxCount: e.target.value })} />
      </label>
      <select aria-label="Rules out" className={input} value={draft.excludesGroupId} onChange={(e) => setDraft({ ...draft, excludesGroupId: e.target.value })}>
        <option value="">Rules out nothing</option>
        {otherGroups.map((g) => (
          <option key={g.id} value={g.id}>Rules out {g.name}</option>
        ))}
      </select>
    </>
  )
}

function draftBody(draft: OptionDraft) {
  const priceDeltaPaisa = draft.price.trim() === '' ? 0 : paisaFromLkrInput(draft.price, { allowNegative: true })
  const maxCount = Number.parseInt(draft.maxCount, 10)
  if (draft.name.trim() === '' || priceDeltaPaisa === null || !Number.isInteger(maxCount)) return null
  return { name: draft.name, priceDeltaPaisa, isDefault: draft.isDefault, maxCount, excludesGroupId: draft.excludesGroupId || null }
}

function OptionRow({
  option,
  handle,
  otherGroups,
  busy,
  run,
  confirm,
}: {
  option: ManageOption
  handle: ReactNode
  otherGroups: ManageGroup[]
  busy: boolean
  run: Run
  confirm: (text: string, action: () => Promise<void>) => void
}) {
  const initial: OptionDraft = {
    name: option.name,
    price: option.priceDeltaPaisa === 0 ? '' : String(option.priceDeltaPaisa / 100),
    isDefault: option.isDefault,
    maxCount: String(option.maxCount),
    excludesGroupId: option.excludesGroupId ?? '',
  }
  const [draft, setDraft] = useState(initial)
  const body = draftBody(draft)
  const changed = JSON.stringify(draft) !== JSON.stringify(initial)
  return (
    <div className="flex flex-wrap items-center gap-sp-2 rounded-control bg-slate-50 p-sp-2">
      {handle}
      <OptionFields draft={draft} setDraft={setDraft} otherGroups={otherGroups} />
      {changed ? (
        <button type="button" className={primary} disabled={busy || !body} onClick={() => run('PATCH', `/api/manage/menu/options/${option.id}`, { version: option.version, ...body })}>
          Save
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${option.name}`}
        className={icon}
        disabled={busy}
        onClick={() =>
          confirm(`Remove the option "${option.name}"?`, async () => {
            await run('DELETE', `/api/manage/menu/options/${option.id}?version=${option.version}`)
          })
        }
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
    </div>
  )
}

function AddOption({ busy, otherGroups, onAdd }: { busy: boolean; otherGroups: ManageGroup[]; onAdd: (body: object) => Promise<unknown> }) {
  const empty: OptionDraft = { name: '', price: '', isDefault: false, maxCount: '1', excludesGroupId: '' }
  const [draft, setDraft] = useState(empty)
  const body = draftBody(draft)
  return (
    <form
      className="flex flex-wrap items-center gap-sp-2 border-t border-slate-100 pt-sp-2"
      onSubmit={async (event) => {
        event.preventDefault()
        if (body && (await onAdd(body))) setDraft(empty)
      }}
    >
      <OptionFields draft={draft} setDraft={setDraft} otherGroups={otherGroups} />
      <button type="submit" className={secondary} disabled={busy || !body}>
        <Plus className="size-4" aria-hidden="true" /> Add option
      </button>
    </form>
  )
}

function AddGroup({ busy, onAdd }: { busy: boolean; onAdd: (body: object) => Promise<unknown> }) {
  const [name, setName] = useState('')
  const [selection, setSelection] = useState<'single' | 'multi'>('single')
  const [required, setRequired] = useState(false)
  return (
    <form
      className="flex flex-wrap items-center gap-sp-2 rounded-panel border border-dashed border-slate-300 p-sp-3"
      onSubmit={async (event) => {
        event.preventDefault()
        if (await onAdd({ name, selection, isRequired: required })) {
          setName('')
          setRequired(false)
        }
      }}
    >
      <input aria-label="New group name" placeholder="New option group, e.g. Alcohol" maxLength={60} className={cn(input, 'min-w-40 flex-1')} value={name} onChange={(e) => setName(e.target.value)} />
      <select aria-label="Choice" className={input} value={selection} onChange={(e) => setSelection(e.target.value as 'single' | 'multi')}>
        <option value="single">Pick one</option>
        <option value="multi">Pick any</option>
      </select>
      <label className="flex min-h-11 items-center gap-sp-2 text-fs-14 text-slate-700">
        <input type="checkbox" className="size-5" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
      </label>
      <button type="submit" className={secondary} disabled={busy || name.trim() === ''}>
        <Plus className="size-4" aria-hidden="true" /> Add group
      </button>
    </form>
  )
}

function ConfirmDialog({ text, busy, onCancel, onConfirm }: { text: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
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
      <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2">
        <h2 id="confirm-title" className="text-fs-20 font-extrabold text-slate-900">{text}</h2>
        <p className="text-fs-14 text-slate-600">Past orders and bills keep it. You can restore a removed dish.</p>
        <div className="flex gap-sp-3">
          <button type="button" autoFocus className={cn(secondary, 'flex-1')} onClick={onCancel}>Cancel</button>
          <button type="button" className={cn(primary, 'flex-1')} disabled={busy} onClick={onConfirm}>Remove</button>
        </div>
      </div>
    </div>
  )
}

/** The order screen's icon for a category, by its name (`menuCategoryIcon`). */
// `createElement`, not `<Icon />`: the lookup RETURNS a component, and the
// React Compiler refuses one created during render (same as `zoneIcon`).
function CategoryIcon({ name, className }: { name: string; className?: string }) {
  return createElement(menuCategoryIcon(name), { 'aria-hidden': true, className })
}
