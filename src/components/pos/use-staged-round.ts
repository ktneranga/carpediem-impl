'use client'

import { useSyncExternalStore } from 'react'
import type { MenuItemRow } from '@/app/api/menu/route'

/**
 * One line in the staged round.
 *
 * ── Why the name, price and seat label are copied onto the line ──────────────
 * Not looked up at render or at submit time:
 *
 * 1. The menu refetches (Story 4.2 listens for `menu:item_updated`), so an item
 *    86'd or renamed mid-round would change or blank a line under the waiter.
 * 2. `order_events.unit_price_paisa` is written at submission into an
 *    APPEND-ONLY table. Reading the price from `menu_items` at that moment lets
 *    a mid-service re-price change what the guest is charged for something
 *    already ordered. The price the waiter saw is the price that goes in.
 * 3. The seat can be removed on another tablet. When it is, the line must still
 *    be able to say WHICH seat vanished — "Seat 3 (red shirt)" — so the waiter
 *    knows whose dish needs a new home (AC-7). A seat id alone cannot say that.
 */
export type StagedLine = {
  /** Client-generated, never the menu item id. */
  lineId: string
  menuItemId: string
  name: string
  /** Integer paisa, as quoted when the dish was tapped. */
  pricePaisa: number
  /** A positive integer. */
  quantity: number
  /** "" when the waiter never opened the sheet, which is the common case. */
  modifierText: string
  /** Whichever seat was selected at the moment of the tap. */
  seatSlotId: string
  /** That seat's name at the moment of the tap — its note, else its label. */
  seatLabel: string
  /** Carried so Story 4.5 can route without re-reading the menu. */
  productionDestination: MenuItemRow['productionDestination']
}

const DESTINATIONS: readonly string[] = ['kitchen', 'pizza_kitchen', 'bar']
const STORAGE_PREFIX = 'cdrms:staged:'
const SEND_PREFIX = 'cdrms:staged-send:'
const EMPTY: StagedLine[] = []

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`
}

function sendKey(sessionId: string): string {
  return `${SEND_PREFIX}${sessionId}`
}

/**
 * An id that works on plain `http://`.
 *
 * `crypto.randomUUID()` exists only in a secure context. A tablet reaching the
 * POS at `http://192.168.x.x` — an ordinary deployment for this product — has
 * no such function, and every Add tap threw before anything was staged.
 *
 * Used for line ids AND for the send id. A line id only has to be unique within
 * one device's round, but the send id is the primary key of `order_rounds`, so
 * the fallback produces a real version-4 UUID (122 random bits) — the server
 * validates the format, and a collision would be answered as someone else's
 * round.
 */
function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  // The fallback must still be a UUID: it is also used for the send id, which
  // the server validates as one. Version 4 layout, from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/**
 * Reads a mirrored round back, trusting nothing about it.
 *
 * Checks VALUES, not just types: a quantity of `NaN`, `0`, `-2` or `1.5`, or a
 * missing destination, is a corrupt line, and a corrupt line is dropped rather
 * than rendered as "LKR NaN" or left out of the "→ Kitchen & Bar" summary. The
 * first version's guard checked types only and skipped the destination.
 *
 * `seatLabel` is optional on read: rounds mirrored before it existed get "",
 * and the list falls back to the live seat's name.
 */
function readStorage(sessionId: string): StagedLine[] {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(storageKey(sessionId))
  } catch {
    return EMPTY
  }
  if (!raw) return EMPTY

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EMPTY

    const lines: StagedLine[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const c = entry as Record<string, unknown>
      const valid =
        typeof c.lineId === 'string' &&
        typeof c.menuItemId === 'string' &&
        typeof c.name === 'string' &&
        Number.isInteger(c.pricePaisa) &&
        (c.pricePaisa as number) >= 0 &&
        Number.isInteger(c.quantity) &&
        (c.quantity as number) > 0 &&
        typeof c.modifierText === 'string' &&
        typeof c.seatSlotId === 'string' &&
        typeof c.productionDestination === 'string' &&
        DESTINATIONS.includes(c.productionDestination)
      if (!valid) continue

      lines.push({
        lineId: c.lineId as string,
        menuItemId: c.menuItemId as string,
        name: c.name as string,
        pricePaisa: c.pricePaisa as number,
        quantity: c.quantity as number,
        modifierText: c.modifierText as string,
        seatSlotId: c.seatSlotId as string,
        seatLabel: typeof c.seatLabel === 'string' ? c.seatLabel : '',
        productionDestination: c.productionDestination as StagedLine['productionDestination'],
      })
    }
    return lines
  } catch {
    return EMPTY
  }
}

// ── The store ────────────────────────────────────────────────────────────────
//
// Why a module-level store read through `useSyncExternalStore`, and not
// `useState` seeded from storage. The first version used a lazy `useState`
// initialiser and had four defects, all from the same root:
//
// 1. HYDRATION. On the server the initialiser saw no `window` and returned [];
//    on the client's first render it returned the stored lines. Server HTML and
//    hydration disagreed across the list, the counts, the badges and the bar.
//    `useSyncExternalStore` takes a separate server snapshot, hydrates with it,
//    and then renders the stored round — no mismatch.
// 2. STALE CLOSURES. Every mutator built the next array from the `lines` its
//    render saw, so two calls in one batch lost one. Mutators here read the
//    store's CURRENT value.
// 3. SESSION CHANGE. State seeded once kept table A's round when the component
//    was reused for table B. The store is keyed by session, so B reads B.
// 4. TWO TABS. Each tab held its own copy and the last write won unseen. The
//    `storage` event now refreshes the other tab, so both show the same round.
//
// `memory` is this tab's source of truth; storage is the mirror that survives a
// reload. Arrays are replaced, never mutated, so a snapshot is referentially
// stable between writes — which `useSyncExternalStore` requires.

const memory = new Map<string, StagedLine[]>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function snapshot(sessionId: string): StagedLine[] {
  let lines = memory.get(sessionId)
  if (!lines) {
    lines = readStorage(sessionId)
    memory.set(sessionId, lines)
  }
  return lines
}

// ── The send id (Story 4.5, AC-8 and AC-13) ─────────────────────────────────
//
// One id per round CONTENT. It is created on the first tap of Send, kept for
// every retry of that exact round — including across a reload — and thrown away
// the moment the round changes. The server treats a repeated id as "already
// sent", so a retry after a lost response cannot write the round twice, while a
// round the waiter has since edited is, correctly, a new send.

const pendingSend = new Map<string, string | null>()

function readPendingSend(sessionId: string): string | null {
  if (pendingSend.has(sessionId)) return pendingSend.get(sessionId) ?? null
  let value: string | null = null
  try {
    value = window.localStorage.getItem(sendKey(sessionId))
  } catch {
    value = null
  }
  pendingSend.set(sessionId, value)
  return value
}

function writePendingSend(sessionId: string, value: string | null): void {
  pendingSend.set(sessionId, value)
  try {
    if (value === null) window.localStorage.removeItem(sendKey(sessionId))
    else window.localStorage.setItem(sendKey(sessionId), value)
  } catch {
    // Memory still holds it for this page's lifetime.
  }
}

/**
 * The id to send this round under: the existing one if the round has not
 * changed since the last attempt, otherwise a new one (persisted first).
 */
export function sendIdForRound(sessionId: string): string {
  const existing = readPendingSend(sessionId)
  if (existing) return existing
  const created = newId()
  writePendingSend(sessionId, created)
  return created
}

function write(sessionId: string, next: StagedLine[]): void {
  // Any change to the round makes it a different send.
  writePendingSend(sessionId, null)
  memory.set(sessionId, next)
  try {
    if (next.length === 0) window.localStorage.removeItem(storageKey(sessionId))
    else window.localStorage.setItem(storageKey(sessionId), JSON.stringify(next))
  } catch {
    // A failed write (full quota, blocked storage) would otherwise leave the
    // PREVIOUS round in storage, to be restored after a reload as if it were
    // the whole thing. Remove it instead: losing the mirror is honest, a stale
    // partial round is not.
    try {
      window.localStorage.removeItem(storageKey(sessionId))
    } catch {
      // Storage is unusable altogether. Memory still holds the round.
    }
  }
  notify()
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && !event.key.startsWith(STORAGE_PREFIX)) return
  // Another tab changed a round (or cleared storage). Drop the cached copy so
  // the next snapshot rereads it.
  if (event.key === null) {
    memory.clear()
    pendingSend.clear()
  } else {
    const sessionId = event.key.slice(STORAGE_PREFIX.length)
    memory.delete(sessionId)
    pendingSend.delete(sessionId)
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

function serverSnapshot(): StagedLine[] {
  return EMPTY
}

/**
 * Discards a session's staged round and its mirror.
 *
 * Called when the table is CLOSED. Without it every closed sitting left a
 * `cdrms:staged:<uuid>` key on a shared tablet for the life of the install.
 */
export function clearStagedRound(sessionId: string): void {
  write(sessionId, EMPTY)
}

/**
 * The round the waiter is building, before anybody submits it (FR7, FR11).
 *
 * ── Nothing here touches the database ────────────────────────────────────────
 * AC-5: staged items produce no writes. Submission is the commit point, and a
 * half-written round in an append-only table could never be retracted.
 *
 * ── Mirrored to localStorage, per device ─────────────────────────────────────
 * So a tablet that sleeps or reloads keeps its round (AC-11). A round staged on
 * tablet A is deliberately NOT recoverable on tablet B: it is not real until it
 * is sent, and two devices restoring one draft would double the order.
 */
export function useStagedRound(sessionId: string) {
  const lines = useSyncExternalStore(
    subscribe,
    () => snapshot(sessionId),
    serverSnapshot,
  )

  /**
   * Stages a dish — or adds to a line that is already the same order.
   *
   * ── Same dish, same seat, same note: one line, more quantity ──────────────
   * Changed on 2026-09-16 at Teran's request. Tapping Devilled Cashew twice for
   * Seat 1 used to produce two identical lines; now the second tap raises the
   * first line's quantity, and the line's own minus undoes a mis-tap.
   *
   * ── The NOTE is part of what makes it "the same" ─────────────────────────
   * "Cashew" and "Cashew — no chilli" for one guest are two things for the
   * kitchen, so a different note — including note versus no note — stays a
   * separate line. A different SEAT always does: a different person, and
   * possibly a different bill.
   */
  function addLine(
    item: MenuItemRow,
    {
      seatSlotId,
      seatLabel,
      quantity = 1,
      modifierText = '',
    }: {
      seatSlotId: string
      seatLabel: string
      quantity?: number
      modifierText?: string
    },
  ): void {
    const current = snapshot(sessionId)
    const note = modifierText.trim()
    const amount = Math.max(1, Math.trunc(quantity))
    const existing = current.find(
      (line) =>
        line.menuItemId === item.id &&
        line.seatSlotId === seatSlotId &&
        line.modifierText === note,
    )

    if (existing) {
      write(
        sessionId,
        current.map((line) =>
          line.lineId === existing.lineId
            ? { ...line, quantity: line.quantity + amount }
            : line,
        ),
      )
      return
    }

    write(sessionId, [
      ...current,
      {
        lineId: newId(),
        menuItemId: item.id,
        name: item.name,
        pricePaisa: item.pricePaisa,
        quantity: amount,
        modifierText: note,
        seatSlotId,
        seatLabel,
        productionDestination: item.productionDestination,
      },
    ])
  }

  function removeLine(lineId: string): void {
    write(
      sessionId,
      snapshot(sessionId).filter((line) => line.lineId !== lineId),
    )
  }

  /**
   * Sets a line's quantity. Clamped at 1: zero is what Remove means, and a
   * zero-quantity line would submit an `order_event` for nothing. The list's
   * minus removes the line at 1 instead of calling this.
   */
  function setQuantity(lineId: string, quantity: number): void {
    const next = Math.max(1, Math.trunc(quantity))
    write(
      sessionId,
      snapshot(sessionId).map((line) =>
        line.lineId === lineId ? { ...line, quantity: next } : line,
      ),
    )
  }

  /**
   * Takes the menu's new price onto every line of that dish (Story 4.5, AC-9).
   *
   * The waiter confirms it; the send is refused until they do. It is a change
   * to the round, so the next send goes under a new id.
   */
  function acceptPrice(menuItemId: string, pricePaisa: number): void {
    write(
      sessionId,
      snapshot(sessionId).map((line) =>
        line.menuItemId === menuItemId ? { ...line, pricePaisa } : line,
      ),
    )
  }

  /** Moves a line to a live seat — the repair for AC-7's vanished-seat case. */
  function reassignLine(lineId: string, seatSlotId: string, seatLabel: string): void {
    write(
      sessionId,
      snapshot(sessionId).map((line) =>
        line.lineId === lineId ? { ...line, seatSlotId, seatLabel } : line,
      ),
    )
  }

  /** Empties the round AND its mirror. Story 4.5 calls this after a 201. */
  function clear(): void {
    write(sessionId, EMPTY)
  }

  return { lines, addLine, removeLine, setQuantity, reassignLine, acceptPrice, clear }
}
