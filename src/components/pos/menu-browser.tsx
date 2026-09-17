'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MenuCategoryRow, MenuItemRow } from '@/app/api/menu/route'
import type { MenuItemUpdatedPayload } from '@/server/socket/events'
import { MenuCategoryChips } from '@/components/pos/menu-category-chips'
import { MenuItemCard } from '@/components/pos/menu-item-card'
import { useSocketEvent } from '@/hooks/use-socket'
import { cn } from '@/lib/utils'

/**
 * The menu cache key. Exported because the order screen reads this same cache to
 * tell whether a staged item has been 86'd — it must never be re-declared there.
 * Two arrays that have to stay equal but are written in two files is the exact
 * coupling Story 4.3's review flagged on the seat index name.
 */
export const MENU_QUERY_KEY = ['menu'] as const

/** Longer than the empty state can usefully show; the rest is noise. */
const MAX_ECHOED_SEARCH = 40

/** Thrown when the session is gone. Signing in again fixes it. */
class SessionExpiredError extends Error {}

async function fetchMenu(): Promise<MenuCategoryRow[]> {
  const response = await fetch('/api/menu')

  // A session that idled out mid-shift is not a network problem, and the waiter
  // cannot act on it here. Every other screen splits this out; the menu used to
  // tell them to check the Wi-Fi.
  if (response.status === 401) throw new SessionExpiredError('Session expired')

  const body = await response.json().catch(() => null)

  if (!response.ok || !body?.success) {
    throw new Error(body?.error?.message ?? 'Could not load the menu')
  }
  return body.data as MenuCategoryRow[]
}

/**
 * The menu query, exactly as this component runs it.
 *
 * Exported so the order screen can OBSERVE the same cache entry — one fetch,
 * two subscribers — and re-render when a socket event 86's a dish it has
 * staged. A plain `getQueryData` read does not subscribe, which is why the
 * staged line's warning used to never appear.
 */
export const menuQueryOptions = {
  queryKey: MENU_QUERY_KEY,
  queryFn: fetchMenu,
}

/**
 * Menu browse and search for the order screen (FR7).
 *
 * ── Search leads; browse is the fallback ─────────────────────────────────────
 * `ux-design-specification.md:307` — "Search is the primary menu navigation
 * path — type 2–3 characters, item appears instantly" — and `:91` — "browsing by
 * category is the fallback, not the primary path". So the search field is first
 * and STAYS put: it and the chips are `shrink-0` while only the grid scrolls,
 * which is what makes "always visible" true rather than merely intended.
 *
 * ── Filtering never touches the network ──────────────────────────────────────
 * The whole menu arrives once and every keystroke filters the array in memory.
 * A request per keystroke on a restaurant LAN, on a tablet, while a guest waits,
 * is the kind of thing that teaches staff to write orders on paper instead.
 */
export function MenuBrowser({
  onAdd,
  onOpenModifiers,
  stagedCountByItem,
}: {
  /**
   * Stages the tapped item as-is on the active seat (Story 4.4, AC-1).
   *
   * Threaded THROUGH this component to the card rather than the order screen
   * reaching around it — the browser owns the menu query, the filtering and the
   * socket patching, and a second component resolving item ids would be a
   * second source of truth for what is on the menu right now.
   *
   * Optional, so the browser still renders standalone with no staging context.
   */
  onAdd?: (item: MenuItemRow) => void
  /** Opens the modifier sheet for the tapped item (AC-2). */
  onOpenModifiers?: (item: MenuItemRow) => void
  /**
   * Staged quantity per menu item id, for the card badge and "Add another".
   * Owned by the order screen, which owns the staged round.
   */
  stagedCountByItem?: Map<string, number>
} = {}) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null)

  const { data: categories, isPending, isError, error } = useQuery(menuQueryOptions)

  /**
   * An item was 86'd, restocked or toggled by a manager.
   *
   * Invalidates on an empty cache, never `return current`. The event can land
   * before the first fetch resolves, or during a refetch whose in-flight
   * (pre-change) response then commits over the top — a real lost update, which
   * is exactly what `table-grid.tsx` documents having fixed. Dropping the patch
   * silently is how an 86'd item stays orderable on one tablet.
   *
   * The payload type is IMPORTED from the emitter. A hand-copied local type is
   * why `portionCount` could be written as `undefined` without the compiler
   * noticing: Decision 2 agreed the event's NAME, and the shape has to be agreed
   * the same way.
   */
  useSocketEvent<MenuItemUpdatedPayload>('menu:item_updated', (payload) => {
    const current = queryClient.getQueryData<MenuCategoryRow[]>(MENU_QUERY_KEY)
    if (!current) {
      void queryClient.invalidateQueries({ queryKey: MENU_QUERY_KEY })
      return
    }

    let matched = false
    const next = current.map((category) => ({
      ...category,
      items: category.items.map((item) => {
        if (item.id !== payload.itemId) return item
        matched = true
        return {
          ...item,
          available: payload.available,
          // `?? item.portionCount` — an emitter that omits the count must not
          // erase it. Belt as well as braces: the epic now specifies it too.
          portionCount: payload.portionCount ?? item.portionCount,
        }
      }),
    }))

    // An item this client has never seen — created or re-categorised since the
    // fetch. A patch cannot add it, so refetch, exactly as the grid does.
    if (!matched) {
      void queryClient.invalidateQueries({ queryKey: MENU_QUERY_KEY })
      return
    }

    queryClient.setQueryData<MenuCategoryRow[]>(MENU_QUERY_KEY, next)
  })

  /**
   * A filter whose category has gone.
   *
   * The owner can deactivate a category and `/api/menu` filters on that, so a
   * refetch can return without the one being filtered to. Left alone the menu
   * empties with no chip pressed and nothing telling the waiter a filter is on.
   * Derived rather than stored, so there is no effect to go stale.
   */
  const effectiveCategoryId =
    activeCategoryId && categories?.some((category) => category.id === activeCategoryId)
      ? activeCategoryId
      : null

  // Case-insensitive substring, which is what FR7 asks for and AC-3 specifies.
  // NOT fuzzy matching against kitchen aliases — the UX spec wants that, no
  // requirement covers it, and it needs a column that does not exist.
  const visible = useMemo(() => {
    if (!categories) return []
    const needle = search.trim().toLowerCase()

    return (
      categories
        .filter((category) => effectiveCategoryId === null || category.id === effectiveCategoryId)
        .map((category) => ({
          ...category,
          items: needle
            ? category.items.filter((item) => item.name.toLowerCase().includes(needle))
            : category.items,
        }))
        // An empty category is noise while SEARCHING and a real configuration
        // fact while browsing — which is why `/api/menu` pays for a LEFT JOIN to
        // keep them. This condition also required an active chip, which dropped
        // them in the default view: the one place the comment said they survive.
        .filter((category) => category.items.length > 0 || !needle)
    )
  }, [categories, search, effectiveCategoryId])

  const matchCount = visible.reduce((total, category) => total + category.items.length, 0)
  const trimmedSearch = search.trim()
  const activeCategoryName = categories?.find(
    (category) => category.id === effectiveCategoryId,
  )?.name

  /**
   * Why the list is empty, said accurately.
   *
   * Three causes used to share two strings: an unconfigured menu reported "No
   * items in this category" with no category selected, and a search narrowed by
   * an active chip reported "nothing matches" while the dish sat one chip away.
   */
  function emptyMessage(): string {
    if (trimmedSearch) {
      const shown =
        trimmedSearch.length > MAX_ECHOED_SEARCH
          ? `${trimmedSearch.slice(0, MAX_ECHOED_SEARCH)}…`
          : trimmedSearch
      return activeCategoryName
        ? `Nothing in ${activeCategoryName} matches “${shown}”. Tap All items to search the whole menu.`
        : `Nothing matches “${shown}”.`
    }
    if (activeCategoryName) return `No items in ${activeCategoryName}.`
    return 'No menu items are set up yet. Add them in settings, or run the seed.'
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-sp-3" aria-label="Menu">
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search the menu — two letters is enough"
        aria-label="Search the menu"
        className={cn(
          'h-touch-waiter w-full shrink-0 rounded-control border border-slate-200 bg-white px-sp-4',
          'text-fs-18 text-slate-900 placeholder:text-slate-400 shadow-el-1',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      />

      <MenuCategoryChips
        // Counts are of what the category can be ORDERED from right now — not
        // of what the search matches (a number that changes per keystroke reads
        // as the menu changing), and not of 86'd dishes ("PIZZA 2" when both
        // pizzas are off is the opposite of the signal the count exists for).
        categories={(categories ?? []).map((category) => ({
          id: category.id,
          name: category.name,
          itemCount: category.items.filter((item) => item.available).length,
        }))}
        activeCategoryId={effectiveCategoryId}
        onSelect={setActiveCategoryId}
      />

      {/* A failure AFTER the first success used to be invisible: the guard was
          `isError && !categories`, so the menu went stale with no banner while
          the socket patches it depends on may also have been missing. */}
      {isError && categories ? (
        <p
          role="status"
          className="shrink-0 rounded-control bg-occupied-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-occupied-ink"
        >
          Menu may be out of date — {error instanceof Error ? error.message : 'refresh failed'}.
        </p>
      ) : null}

      {isPending ? (
        <p className="text-fs-16 text-slate-600">Loading the menu…</p>
      ) : isError && !categories ? (
        // The server's own wording. `fetchMenu` goes to the trouble of reading it
        // out of the response; telling every failure — a 403, a 503
        // NOT_PROVISIONED, a database outage — to "check the network" threw that
        // away and sent the waiter to look at the Wi-Fi.
        <p role="alert" className="text-fs-16 font-semibold text-unavailable-ink">
          {error instanceof Error && error.message
            ? error.message
            : 'Could not load the menu. Check the tablet is on the restaurant network.'}
        </p>
      ) : matchCount === 0 ? (
        <p className="text-fs-16 text-slate-600">{emptyMessage()}</p>
      ) : (
        // Only the GRID scrolls. The search field and chips above it are
        // `shrink-0`, so the primary navigation path stays on screen at any menu
        // length — and "Close table" below stays reachable without scrolling past
        // every dish.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-sp-4">
            {visible.map((category) => {
              return (
                <div key={category.id} className="flex flex-col gap-sp-2">
                  {/* The heading stays even while searching, so a match is always
                      attributable to a category — AC-3's last clause. */}
                  <h2 className="text-fs-12 font-semibold tracking-micro text-slate-600 uppercase">
                    {category.name}
                  </h2>

                  {/* As many 210px+ cards as the menu column fits — three on
                      a tablet, more on a wide screen. Fixed breakpoints stopped
                      making sense once the column's width became a ratio of the
                      screen rather than the screen itself. */}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-sp-3">
                    {category.items.map((item) => (
                      <MenuItemCard
                        key={item.id}
                        item={item}
                        stagedCount={stagedCountByItem?.get(item.id) ?? 0}
                        // The ITEM, not its id. The card already holds the row
                        // the browser resolved; handing back an id would make
                        // the caller look it up again in a list it does not own,
                        // and the price it found could differ from the one on
                        // the card the waiter actually tapped.
                        onAdd={onAdd}
                        onOpenModifiers={onOpenModifiers}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
