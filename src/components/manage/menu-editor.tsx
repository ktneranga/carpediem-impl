'use client'

import { createElement, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Pencil, Plus, Trash2, X } from 'lucide-react'
import { MenuImportSheet } from '@/components/manage/menu-import-sheet'
import { SortableList } from '@/components/manage/sortable-list'
import {
  ApiError,
  button,
  call as callApi,
  ConfirmDialog,
  icon,
  input,
  OffChip,
  primary,
  secondary,
  Switch,
} from '@/components/manage/manage-ui'
import type { ManageCategory, ManageGroup, ManageItem, ManageOption } from '@/server/services/menu-admin.service'
import { menuCategoryIcon, routeForDestination } from '@/lib/design'
import { lkrFromPaisa, paisaFromLkrInput, signedLkrFromPaisa } from '@/lib/format'
import { isDrinksCategory } from '@/lib/menu-sections'
import { useSocketEvent } from '@/hooks/use-socket'
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

type Side = 'Food' | 'Drinks'

/**
 * Where the editor lists a category. Its dishes decide (`isDrinksCategory`);
 * an EMPTY one stays on the side it was added from (Teran, 2026-11-13), so a
 * new drinks category does not first appear under Food. That memory is this
 * screen's only — the server has no notion of a side — so after a reload an
 * empty category is listed under Food again until it has a dish.
 */
function sideOf(category: ManageCategory, addedTo: Record<string, Side>): Side {
  if (category.items.some((item) => item.isActive)) return isDrinksCategory(category) ? 'Drinks' : 'Food'
  // Every dish switched off (or the category itself): its dishes still say
  // which side it belongs on.
  if (category.items.length > 0) {
    return isDrinksCategory({ items: category.items.map((item) => ({ ...item, isActive: true })) }) ? 'Drinks' : 'Food'
  }
  return addedTo[category.id] ?? 'Food'
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

const call = (method: string, url: string, body?: unknown) => callApi(method, url, body, '/manage/menu')

export function MenuEditor() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ mode: 'new' } | { mode: 'edit'; itemId: string } | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; run: () => Promise<void> } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [importing, setImporting] = useState(false)
  /** Empty categories added from the Drinks (or Food) side — see `sideOf`. */
  const [addedTo, setAddedTo] = useState<Record<string, Side>>({})

  // Switched-off categories and dishes are always listed, greyed (Teran,
  // 2026-11-15): the switch is how they come back.
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['manage-menu'],
    queryFn: async () => ((await call('GET', '/api/manage/menu?removed=1')) as { data: ManageCategory[] }).data,
  })

  // A dish sold out or back on elsewhere (Story 8.3) bumps its version: reload,
  // or the owner's next save of that dish is refused as STALE.
  useSocketEvent('menu:item_updated', () => {
    void queryClient.invalidateQueries({ queryKey: ['manage-menu'] })
  })

  const selected =
    categories.find((c) => c.id === selectedId) ?? categories.find((c) => c.isActive) ?? categories[0] ?? null
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

  /** A dish's switch: off hides it from the POS, on brings it back. */
  const switchDish = (item: ManageItem) => (on: boolean) =>
    on
      ? run('POST', `/api/manage/menu/items/${item.id}/restore`, { version: item.version })
      : run('DELETE', `/api/manage/menu/items/${item.id}?version=${item.version}`)

  /** A drag and drop: the new order of one whole list (Teran, 2026-11-13). */
  const reorder: Reorder = (kind, parentId, ids) => run('POST', '/api/manage/menu/reorder', { kind, parentId, ids })

  return (
    <div className="flex flex-col gap-sp-4">
      <header className="flex flex-wrap items-center justify-between gap-sp-3">
        <h1 className="text-fs-24 font-extrabold text-slate-900 night:text-night-text">Menu</h1>
        <div className="flex flex-wrap items-center gap-sp-3">
          <button type="button" className={secondary} onClick={() => setImporting(true)}>
            <FileSpreadsheet className="size-4" aria-hidden="true" /> Bulk upload
          </button>
        </div>
      </header>

      {message ? (
        <p role="alert" className="flex items-center justify-between gap-sp-3 rounded-control bg-amber-50 px-sp-4 py-sp-3 text-fs-14 font-semibold text-amber-900 night:bg-amber-500/10 night:text-amber-300">
          {message}
          <button type="button" aria-label="Dismiss" className={icon} onClick={() => setMessage(null)}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </p>
      ) : null}

      {isLoading ? <p className="text-fs-14 text-slate-600 night:text-night-second">Loading the menu…</p> : null}

      <div className="flex flex-col gap-sp-4 lg:flex-row lg:items-start">
        {/* ── Categories ─────────────────────────────────────────────────── */}
        <section aria-label="Categories" className="flex flex-col gap-sp-2 rounded-panel bg-white p-sp-3 lg:w-80 lg:shrink-0 night:bg-night-card">
          <h2 className="px-sp-2 text-fs-14 font-bold tracking-micro text-slate-500 uppercase night:text-night-muted">Categories</h2>
          {(['Food', 'Drinks'] as const).map((side) => {
            const all = categories.filter((category) => sideOf(category, addedTo) === side)
            const list = all.filter((category) => category.isActive)
            const off = all.filter((category) => !category.isActive)
            const row = (category: ManageCategory, handle: ReactNode) => (
              <CategoryRow
                key={category.version}
                category={category}
                handle={handle}
                selected={selected?.id === category.id}
                busy={busy}
                onSelect={() => setSelectedId(category.id)}
                onRename={(name) => run('PATCH', `/api/manage/menu/categories/${category.id}`, { version: category.version, name })}
                onSwitch={(on) =>
                  on
                    ? run('POST', `/api/manage/menu/categories/${category.id}/restore`, { version: category.version })
                    : run('DELETE', `/api/manage/menu/categories/${category.id}?version=${category.version}`)
                }
              />
            )
            return (
              <div key={side} className="flex flex-col gap-sp-1">
                <h3 className="px-sp-2 pt-sp-2 text-fs-12 font-bold text-slate-500 night:text-night-muted">{side}</h3>
                <SortableList
                  items={list}
                  disabled={busy}
                  label={(category) => category.name}
                  className="flex flex-col gap-sp-1"
                  // One shared order for every category: the dragged side's
                  // categories take their new order in the slots they held.
                  onReorder={(sideIds) => {
                    // Only switched-on categories are ordered (the server
                    // refuses any other list).
                    const queue = [...sideIds]
                    const ids = categories
                      .filter((category) => category.isActive)
                      .map((category) => (sideOf(category, addedTo) === side ? queue.shift()! : category.id))
                    return reorder('category', null, ids)
                  }}
                  renderItem={(category, handle) => row(category, handle)}
                />
                {off.map((category) => (
                  <div key={category.id + category.version}>{row(category, <span className="size-11 shrink-0" />)}</div>
                ))}
                <AddCategory
                  side={side}
                  busy={busy}
                  onAdd={async (name) => {
                    const result = (await run('POST', '/api/manage/menu/categories', { name })) as { data?: { id: string } } | null
                    const id = result?.data?.id
                    if (id) {
                      setAddedTo((current) => ({ ...current, [id]: side }))
                      // Straight to it: the next step is its first dish.
                      setSelectedId(id)
                    }
                    return result
                  }}
                />
              </div>
            )
          })}
        </section>

        {/* ── Dishes ─────────────────────────────────────────────────────── */}
        <section aria-label="Dishes" className="flex min-w-0 flex-1 flex-col gap-sp-2 rounded-panel bg-white p-sp-3 night:bg-night-card">
          <div className="flex items-center justify-between gap-sp-3 px-sp-2">
            <h2 className="flex items-center gap-sp-2 text-fs-18 font-extrabold text-slate-900 night:text-night-text">
              {selected ? <CategoryIcon name={selected.name} className="size-5 text-slate-500 night:text-night-muted" /> : null}
              {selected?.name ?? 'No categories yet'}
            </h2>
            {selected?.isActive ? (
              <button type="button" className={primary} onClick={() => setEditing({ mode: 'new' })}>
                <Plus className="size-4" aria-hidden="true" /> Add dish
              </button>
            ) : null}
          </div>
          {selected && !selected.isActive ? (
            <p className="px-sp-2 text-fs-14 text-slate-600 night:text-night-second">
              This category is off: none of its dishes show on the POS. Their switches are kept; switch the category on to bring them back.
            </p>
          ) : null}
          {selected && selected.items.length === 0 ? (
            <p className="px-sp-2 py-sp-4 text-fs-14 text-slate-600 night:text-night-second">No dishes in this category.</p>
          ) : null}
          {selected ? (
            <SortableList
              items={selected.items.filter((item) => item.isActive)}
              disabled={busy}
              label={(item) => item.name}
              className="flex flex-col divide-y divide-slate-100 night:divide-night-hairline"
              onReorder={(ids) => reorder('item', selected.id, ids)}
              renderItem={(item, handle) => (
                <DishRow
                  item={item}
                  handle={handle}
                  busy={busy}
                  onEdit={() => setEditing({ mode: 'edit', itemId: item.id })}
                  onSwitch={switchDish(item)}
                  categoryOff={!selected.isActive}
                />
              )}
            />
          ) : null}
          {selected && selected.items.some((item) => !item.isActive) ? (
            <ul className="flex flex-col divide-y divide-slate-100 border-t border-slate-200 night:divide-night-hairline night:border-night-hairline">
              {selected.items
                .filter((item) => !item.isActive)
                .map((item) => (
                  <li key={item.id + item.version}>
                    <DishRow
                      item={item}
                      handle={null}
                      busy={busy}
                      onEdit={() => setEditing({ mode: 'edit', itemId: item.id })}
                      onSwitch={switchDish(item)}
                      categoryOff={!selected.isActive}
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
          // Only categories that are on can take a dish (the server refuses
          // the others); its own stays listed so the choice shows it.
          categories={categories.filter((category) => category.isActive || category.id === selected.id)}
          defaultCategoryId={selected.id}
          defaultDestination={sideOf(selected, addedTo) === 'Drinks' ? 'bar' : 'kitchen'}
          busy={busy}
          run={run}
          reorder={reorder}
          confirm={(text, action) => setConfirm({ text, run: action })}
          onClose={() => setEditing(null)}
          onCreated={(id) => setEditing({ mode: 'edit', itemId: id })}
        />
      ) : null}

      {importing ? (
        <MenuImportSheet
          onClose={() => setImporting(false)}
          onImported={() => void queryClient.invalidateQueries({ queryKey: ['manage-menu'] })}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          text={confirm.text}
          note="Past orders and bills keep it."
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
  onSwitch,
}: {
  category: ManageCategory
  handle: ReactNode
  selected: boolean
  busy: boolean
  onSelect: () => void
  onRename: (name: string) => Promise<unknown>
  onSwitch: (on: boolean) => Promise<unknown>
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
            <CategoryIcon name={category.name} className="size-4 shrink-0 text-slate-500 night:text-night-muted" />
            <span className={cn('truncate', category.isActive ? '' : 'text-slate-400 night:text-night-muted')}>{category.name}</span>
            {category.isActive ? (
              <span className="text-fs-12 text-slate-500 night:text-night-muted">{category.items.filter((i) => i.isActive).length}</span>
            ) : (
              <OffChip />
            )}
          </button>
          {selected ? (
            <button type="button" aria-label={`Rename ${category.name}`} className={icon} onClick={() => setRenaming(true)}>
              <Pencil className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <Switch
            on={category.isActive}
            label={category.name}
            disabled={busy}
            onChange={(on) => void onSwitch(on)}
          />
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
  onSwitch,
  categoryOff = false,
}: {
  item: ManageItem
  handle: ReactNode
  busy: boolean
  onEdit: () => void
  onSwitch: (on: boolean) => Promise<unknown>
  /** Its category is off: it stays hidden from the POS whatever its own switch says. */
  categoryOff?: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-sp-2 py-sp-2 pr-sp-2">
      {handle ?? <span className="size-11 shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn('flex items-center gap-sp-2 text-fs-16 font-bold', item.isActive ? 'text-slate-900 night:text-night-text' : 'text-slate-400 night:text-night-muted')}>
          {item.name}
          {item.isActive ? (categoryOff ? <span className="rounded-full bg-amber-50 px-sp-2 text-fs-12 font-bold text-amber-800 night:bg-amber-500/10 night:text-amber-300">Hidden: category off</span> : null) : <OffChip />}
        </span>
        <span className="flex flex-wrap items-center gap-sp-2 text-fs-12 text-slate-600 night:text-night-second">
          <StationChip destination={item.productionDestination} />
          {item.groups.length > 0 ? `${item.groups.length} option group${item.groups.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      <span className="text-fs-16 font-bold tabular-nums text-slate-900 night:text-night-text">{lkrFromPaisa(item.pricePaisa)}</span>
      <button type="button" aria-label={`Edit ${item.name}`} className={icon} onClick={onEdit}>
        <Pencil className="size-4" aria-hidden="true" />
      </button>
      <Switch
        on={item.isActive}
        label={item.name}
        disabled={busy}
        onChange={(on) => void onSwitch(on)}
      />
    </div>
  )
}

function AddCategory({ side, busy, onAdd }: { side: Side; busy: boolean; onAdd: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState('')
  return (
    <form
      className="flex gap-sp-1 border-t border-slate-100 pt-sp-2 night:border-night-hairline"
      onSubmit={async (event) => {
        event.preventDefault()
        if (await onAdd(name)) setName('')
      }}
    >
      <input aria-label={`New ${side.toLowerCase()} category name`} placeholder={`New ${side.toLowerCase()} category`} maxLength={60} className={cn(input, 'min-w-0 flex-1')} value={name} onChange={(e) => setName(e.target.value)} />
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
      <div className="flex h-full w-full max-w-2xl flex-col gap-sp-4 overflow-y-auto bg-white p-sp-5 shadow-el-2 night:bg-night-card">
        <div className="flex items-center justify-between">
          <h2 id="item-sheet-title" className="text-fs-20 font-extrabold text-slate-900 night:text-night-text">
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
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Name</span>
            <input autoFocus={!item} maxLength={60} className={input} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Category</span>
            <select className={input} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-sp-1">
            <span className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Price (LKR, whole rupees)</span>
            <input inputMode="numeric" className={input} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="1,250" />
            <span className={cn('text-fs-12', pricePaisa === null && price !== '' ? 'text-red-700 night:text-red-400' : 'text-slate-500 night:text-night-muted')}>
              {price === '' ? ' ' : pricePaisa === null ? 'Whole rupees only, like 1250' : lkrFromPaisa(pricePaisa)}
            </span>
          </label>
          <fieldset className="flex flex-col gap-sp-1 sm:col-span-2">
            <legend className="text-fs-14 font-semibold text-slate-700 night:text-night-second">Prints at</legend>
            <div className="flex gap-sp-1" role="radiogroup">
              {DESTINATIONS.map((d) => {
                return (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={destination === d.value}
                  onClick={() => setDestination(d.value)}
                  className={cn(button, 'flex-1 border', destination === d.value ? 'border-brand-800 bg-brand-800 text-white' : 'border-slate-200 text-slate-900 night:border-night-hairline night:text-night-text')}
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
          <section aria-label="Options" className="flex flex-col gap-sp-3 border-t border-slate-200 pt-sp-4 night:border-night-hairline">
            <h3 className="text-fs-18 font-extrabold text-slate-900 night:text-night-text">Options</h3>
            {item.groups.length === 0 ? <p className="text-fs-14 text-slate-600 night:text-night-second">No options on this dish.</p> : null}
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
          <p className="text-fs-14 text-slate-600 night:text-night-second">Add the dish first, then its options.</p>
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
    <div className="flex flex-col gap-sp-3 rounded-panel border border-slate-200 p-sp-3 night:border-night-hairline">
      <div className="flex flex-wrap items-center gap-sp-2">
        {handle}
        <input aria-label="Group name" maxLength={60} className={cn(input, 'min-w-40 flex-1 font-bold')} value={name} onChange={(e) => setName(e.target.value)} />
        <select aria-label="Choice" className={input} value={selection} onChange={(e) => setSelection(e.target.value as 'single' | 'multi')}>
          <option value="single">Pick one</option>
          <option value="multi">Pick any</option>
        </select>
        <label className="flex min-h-11 items-center gap-sp-2 text-fs-14 text-slate-700 night:text-night-second">
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
        <span className="text-fs-12 text-slate-500 night:text-night-muted">{delta === null ? (draft.price === '' ? 'no change' : 'whole rupees') : signedLkrFromPaisa(delta) || 'no change'}</span>
      </label>
      <label className="flex min-h-11 items-center gap-sp-1 text-fs-14 text-slate-700 night:text-night-second">
        <input type="checkbox" className="size-5" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} /> Default
      </label>
      <label className="flex items-center gap-sp-1 text-fs-14 text-slate-700 night:text-night-second">
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
    <div className="flex flex-wrap items-center gap-sp-2 rounded-control bg-slate-50 p-sp-2 night:bg-night-raised">
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
      className="flex flex-wrap items-center gap-sp-2 border-t border-slate-100 pt-sp-2 night:border-night-hairline"
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
      className="flex flex-wrap items-center gap-sp-2 rounded-panel border border-dashed border-slate-300 p-sp-3 night:border-night-hairline"
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
      <label className="flex min-h-11 items-center gap-sp-2 text-fs-14 text-slate-700 night:text-night-second">
        <input type="checkbox" className="size-5" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
      </label>
      <button type="submit" className={secondary} disabled={busy || name.trim() === ''}>
        <Plus className="size-4" aria-hidden="true" /> Add group
      </button>
    </form>
  )
}

/** The order screen's icon for a category, by its name (`menuCategoryIcon`). */
// `createElement`, not `<Icon />`: the lookup RETURNS a component, and the
// React Compiler refuses one created during render (same as `zoneIcon`).
function CategoryIcon({ name, className }: { name: string; className?: string }) {
  return createElement(menuCategoryIcon(name), { 'aria-hidden': true, className })
}
