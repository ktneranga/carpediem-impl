'use client'

import { useState } from 'react'
import type { MenuItemRow } from '@/app/api/menu/route'

/**
 * One line in the staged round.
 *
 * ── Why the name and price are copied onto the line ──────────────────────────
 * Not looked up from the menu at render or at submit time. Two reasons, both of
 * which have already bitten this codebase in other shapes:
 *
 * 1. The menu refetches (Story 4.2 listens for `menu:item_updated`), so an item
 *    86'd or renamed mid-round would make a staged line render as blank or
 *    change its name under the waiter's hand.
 * 2. `order_events.unit_price_paisa` is written at submission into an
 *    APPEND-ONLY table. If Story 4.5 reads the price from `menu_items` at that
 *    moment, an owner re-pricing between staging and submitting silently
 *    changes what the guest is charged for something already ordered — and the
 *    audit row then claims the new price was the one quoted. The price the
 *    waiter saw when they tapped is the price that goes in the row.
 */
export type StagedLine = {
  /**
   * Client-generated, never the menu item id.
   *
   * Two "Grilled Fish" on different seats — or on the same seat with different
   * modifiers — are different lines that must be removable independently.
   */
  lineId: string
  menuItemId: string
  name: string
  pricePaisa: number
  quantity: number
  /** "" when the waiter never opened the sheet, which is the common case. */
  modifierText: string
  /** Whichever seat chip was active at the moment of the tap. */
  seatSlotId: string
  /** Carried so Story 4.5 can route without re-reading the menu. */
  productionDestination: MenuItemRow['productionDestination']
}

/** `localStorage` key. Scoped per session — see the note in the hook. */
function storageKey(sessionId: string): string {
  return `cdrms:staged:${sessionId}`
}

/**
 * Reads the mirrored round back.
 *
 * Every access is wrapped: a tablet in private mode, one with site data
 * blocked, and one with a full quota all throw on plain property access. None
 * of those is a reason for the order screen to fail to render — the round is
 * simply lost, which is exactly what happened before this mirror existed.
 *
 * Parsed defensively too. The stored shape is this file's own, but a half-
 * written value or a shape from an older deploy must degrade to "no staged
 * round" rather than crashing the screen on mount.
 */
function readStaged(sessionId: string): StagedLine[] {
  try {
    const raw = window.localStorage.getItem(storageKey(sessionId))
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.filter((line): line is StagedLine => {
      if (typeof line !== 'object' || line === null) return false
      const candidate = line as Partial<StagedLine>
      return (
        typeof candidate.lineId === 'string' &&
        typeof candidate.menuItemId === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.pricePaisa === 'number' &&
        typeof candidate.quantity === 'number' &&
        typeof candidate.modifierText === 'string' &&
        typeof candidate.seatSlotId === 'string'
      )
    })
  } catch {
    return []
  }
}

function writeStaged(sessionId: string, lines: StagedLine[]): void {
  try {
    if (lines.length === 0) window.localStorage.removeItem(storageKey(sessionId))
    else window.localStorage.setItem(storageKey(sessionId), JSON.stringify(lines))
  } catch {
    // Storage is a convenience here, never the source of truth. React state is.
  }
}

/**
 * The round the waiter is building, before anybody submits it (FR7, FR11).
 *
 * ── Nothing here touches the database ────────────────────────────────────────
 * AC-5 is explicit: staged items produce no writes. Submission is the commit
 * point, and a half-written round in an append-only table is worse than no
 * round at all — the rows could never be retracted.
 *
 * ── Which is why it is mirrored to localStorage ──────────────────────────────
 * The consequence of "no writes" is that the round lives in React state on one
 * device. A tablet that sleeps, a browser killed by the OS, a stray back
 * navigation — and six items typed at a table of six are gone with the waiter
 * still standing there. The mirror keeps AC-5 true (nothing reaches the
 * database) while surviving the thing that will actually happen on a shared
 * tablet in a beach restaurant.
 *
 * The mirror is deliberately PER DEVICE. A round staged on tablet A is not
 * recoverable on tablet B, and should not be: the round is not real until it is
 * submitted, and two devices restoring the same draft would double the order.
 *
 * ── Seeded, not synced ───────────────────────────────────────────────────────
 * The restore is a lazy `useState` initialiser, not an effect that calls
 * `setState`. That rule has been enforced three times on this project now — the
 * React Compiler lint rejects the effect form, and it renders one frame of
 * wrong UI besides.
 */
export function useStagedRound(sessionId: string) {
  const [lines, setLines] = useState<StagedLine[]>(() => readStaged(sessionId))

  function commit(next: StagedLine[]): void {
    setLines(next)
    writeStaged(sessionId, next)
  }

  /**
   * Stages one line. Never merges with an existing one.
   *
   * Tapping the same dish twice gives two lines. That is the point: a mis-tap
   * must be undoable with one Remove, not by decrementing a stepper to find the
   * quantity the waiter meant. Quantity is for "3 × Lion Lager" typed
   * deliberately in the sheet.
   */
  function addLine(
    item: MenuItemRow,
    { seatSlotId, quantity = 1, modifierText = '' }: {
      seatSlotId: string
      quantity?: number
      modifierText?: string
    },
  ): void {
    commit([
      ...lines,
      {
        lineId: crypto.randomUUID(),
        menuItemId: item.id,
        name: item.name,
        pricePaisa: item.pricePaisa,
        quantity,
        modifierText: modifierText.trim(),
        seatSlotId,
        productionDestination: item.productionDestination,
      },
    ])
  }

  function removeLine(lineId: string): void {
    commit(lines.filter((line) => line.lineId !== lineId))
  }

  /**
   * Sets a line's quantity. The stepper on the staged line calls this.
   *
   * Clamped at 1: zero is what Remove means, and a zero-quantity line would
   * submit an `order_event` for nothing. The list's minus button removes the
   * line instead of calling this at 1, so the clamp is a guard, not the UI.
   */
  function setQuantity(lineId: string, quantity: number): void {
    const next = Math.max(1, Math.trunc(quantity))
    commit(lines.map((line) => (line.lineId === lineId ? { ...line, quantity: next } : line)))
  }

  /** Moves a line to a live seat — the repair for AC-7's vanished-seat case. */
  function reassignLine(lineId: string, seatSlotId: string): void {
    commit(lines.map((line) => (line.lineId === lineId ? { ...line, seatSlotId } : line)))
  }

  /** Empties the round AND its mirror. Story 4.5 calls this after a 201. */
  function clear(): void {
    commit([])
  }

  return { lines, addLine, removeLine, setQuantity, reassignLine, clear }
}
