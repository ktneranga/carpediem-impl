'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Banknote,
  CreditCard,
  Delete,
  GripVertical,
  Plus,
  Printer,
  Receipt,
  Split,
  Users,
  X,
} from 'lucide-react'
import { lkrFromPaisa, percentFromBp } from '@/lib/format'
import { loginUrl } from '@/lib/return-to'
import { routeForDestination } from '@/lib/design'
import { cn } from '@/lib/utils'
import { ActionStripShell } from '@/components/pos/action-strip-chrome'
import type { ProductionDestination } from '@/types/orders'

export type BillScreenLine = {
  orderEventId: string
  name: string
  quantity: number
  /** What one unit costs, as quoted — so a share of a "2×" can be priced. */
  unitPricePaisa: number
  amountPaisa: number
  modifierText: string | null
  /** "Extra shot ×2, No ice" — the options it was sent with (Story 4.8). */
  optionText: string | null
  destination: ProductionDestination | null
  /** The seat it was ordered on — only on draft lines, for the seat pre-split. */
  seatSlotId?: string | null
}

type Totals = {
  subtotalPaisa: number
  serviceChargePaisa: number
  serviceChargeBp: number
  taxPaisa: number
  taxBp: number
  totalPaisa: number
}

/** A bill already recorded, with what has been paid against it. */
export type BillScreenBill = Totals & {
  billId: string
  type: 'consolidated' | 'seat' | 'split'
  /** Who it is for: the person, the seat, or "Whole table". */
  label: string
  paidPaisa: number
  lines: BillScreenLine[]
}

/** What no bill covers yet, priced exactly as a bill would be. Nothing stored. */
export type BillScreenDraft = Totals & { lines: BillScreenLine[] }

/** A person on the split. Lives only on this screen until they settle. */
type Person = { id: string; label: string }

/** Something the waiter can settle. */
type Payable =
  | { kind: 'bill'; key: string; title: string; bill: BillScreenBill }
  // `billId` once Settle has written the bill but the payment has not gone
  // through (code review UI-P1): a retry pays THAT bill instead of trying to
  // write it again, which the server refuses because its units are billed.
  | { kind: 'draft'; key: 'draft'; title: string; draft: BillScreenDraft; billId?: string }
  | {
      kind: 'person'
      key: string
      title: string
      lines: BillScreenLine[]
      totals: Totals
      billId?: string
    }

function outstandingOf(payable: Payable): number {
  if (payable.kind === 'bill') return payable.bill.totalPaisa - payable.bill.paidPaisa
  if (payable.kind === 'draft') return payable.draft.totalPaisa
  return payable.totals.totalPaisa
}

function totalsOf(payable: Payable): Totals {
  if (payable.kind === 'bill') return payable.bill
  if (payable.kind === 'draft') return payable.draft
  return payable.totals
}

function linesOf(payable: Payable): BillScreenLine[] {
  if (payable.kind === 'bill') return payable.bill.lines
  if (payable.kind === 'draft') return payable.draft.lines
  return payable.lines
}

function itemCount(lines: BillScreenLine[]): number {
  return lines.reduce((total, line) => total + line.quantity, 0)
}

/**
 * A person's share, priced the way the server will price their bill.
 *
 * Uses the DRAFT's rates, which `priceBillable` already resolved — including
 * the pinned service rate, so a party whose first bill carried 10% shows 10%
 * on every share. Each share is rounded on its own, exactly as its own bill
 * will be; the shares can therefore differ from the whole-table figure by a
 * few paisa, which is the correct outcome, not a bug.
 */
function priceShare(lines: BillScreenLine[], rates: Totals): Totals {
  const subtotalPaisa = lines.reduce((total, line) => total + line.amountPaisa, 0)
  const serviceChargePaisa = Math.round((subtotalPaisa * rates.serviceChargeBp) / 10_000)
  const taxPaisa = Math.round(((subtotalPaisa + serviceChargePaisa) * rates.taxBp) / 10_000)
  return {
    subtotalPaisa,
    serviceChargePaisa,
    serviceChargeBp: rates.serviceChargeBp,
    taxPaisa,
    taxBp: rates.taxBp,
    totalPaisa: subtotalPaisa + serviceChargePaisa + taxPaisa,
  }
}

class RefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (response.status === 401) {
    // A tenant with `financial_action_reauth` on answers a bill with a PIN
    // CHALLENGE. That is not an expired session, and sending the waiter to the
    // sign-in screen for it threw the whole bill away. The PIN prompt is Story
    // 2.4; until it exists, say so.
    const code = payload?.error?.code
    if (code === 'REAUTH_REQUIRED' || code === 'REAUTH_FAILED') {
      throw new RefusedError(code, 'This needs a manager PIN, which this screen cannot ask for yet.')
    }
    window.location.assign(loginUrl())
    throw new RefusedError('UNAUTHENTICATED', 'Sign in again.')
  }
  if (response.ok && payload?.success) return payload.data as T
  throw new RefusedError(
    payload?.error?.code ?? 'UNKNOWN',
    payload?.error?.message ?? 'Something went wrong. Try again.',
  )
}

/**
 * Who has how many of each item (migration 0025).
 *
 * Each unbilled line is held as PIECES: "2× Devilled Cashew" starts as one
 * piece of 2 with no owner, and moving one of them to Person 2 leaves a piece
 * of 1 behind. Pieces with the same owner always merge, so a column never
 * shows the same dish twice.
 */
type Piece = { owner: string | null; qty: number }
type SplitState = { view: 'whole' | 'split'; persons: Person[]; allocation: Record<string, Piece[]> }

/** Same-owner pieces merged, empty ones dropped, first-seen order kept. */
function normalize(pieces: Piece[]): Piece[] {
  const merged: Piece[] = []
  for (const piece of pieces) {
    if (piece.qty <= 0) continue
    const existing = merged.find((candidate) => candidate.owner === piece.owner)
    if (existing) existing.qty += piece.qty
    else merged.push({ ...piece })
  }
  return merged
}

/**
 * A card being dragged (design 32): which card, how many of its units, where
 * the pointer is, and the drop target under it — `none` for Not assigned, a
 * person's id, or `new` for Add person.
 */
type DragState = {
  key: string
  count: number
  line: BillScreenLine
  x: number
  y: number
  over: string | undefined
}

/** The drop target under a point: the nearest `[data-drop]` ancestor. */
function dropIdAt(x: number, y: number): string | undefined {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]')
  return element?.dataset.drop
}

/**
 * What makes two lines "the same dish" on a bill: name, unit price, options,
 * note and station. Options are in it so a plain and an extra-shot Mojito never
 * fold into one line, even where a delta of 0 gives them the same price. Used by the whole-table list and by the split's cards alike, so the
 * two views never disagree about what counts as one line.
 */
/** The options, then the waiter's note: "Extra shot ×2, No ice · less sugar". */
function lineDetail(line: BillScreenLine): string {
  return [line.optionText, line.modifierText].filter(Boolean).join(' · ')
}

function dishKey(line: BillScreenLine): string {
  return [
    line.name,
    line.unitPricePaisa,
    line.optionText ?? '',
    line.modifierText ?? '',
    line.destination ?? '',
  ].join('|')
}

/**
 * A card on the split: ONE OWNER's units of ONE DISH — possibly drawn from
 * several order events. Keyed `${owner}::${dishKey}`.
 *
 * Two Devilled Cashews ordered for two seats are two events; moved onto the
 * same person they are one "2×" card, not the same dish twice (Teran,
 * 2026-10-25). The card remembers its events (`members`), so moving one of
 * them takes a unit from one event, and settling bills each event for its
 * own units.
 */
function cardKey(owner: string | null, dish: string): string {
  return `${owner ?? ''}::${dish}`
}

let personCounter = 0
function newPersonId(): string {
  personCounter += 1
  return `p${Date.now().toString(36)}${personCounter}`
}

/**
 * A new column's name: the next seat number, in the order screen's words
 * (Teran, 2026-10-25) — columns are seats, not "Person 3". Counts past every
 * column already there, whatever it is called, so a note like "thattaya" in
 * Seat 1's place still yields "Seat 2", never a duplicate.
 */
function nextPersonLabel(persons: Person[], taken: string[] = []): string {
  // `taken` is the names already on recorded bills (code review UI-P11): once
  // "Seat 2" has paid and its column is gone, the next column must not be
  // "Seat 2" again, or two bills carry one person's name.
  const labels = [...persons.map((person) => person.label), ...taken]
  const used = labels
    .map((label) => /^Seat (\d+)$/.exec(label)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
  let n = Math.max(persons.length, ...used, 0) + 1
  while (labels.includes(`Seat ${n}`)) n += 1
  return `Seat ${n}`
}

/**
 * The split's columns: one per seat, named as the order screen names them
 * (Teran, 2026-10-25) — "thattaya", "Seat 2" — and never fewer than two, the
 * commonest split (6.3).
 *
 * `assignBySeat` puts each item on the seat it was ordered on. True for a
 * Separate-bills order, where the waiter tagged who had what while ordering
 * and this is where it pays off. False for One bill, where every item sits on
 * Seat 1 only because the database needs a seat — dropping them all on Seat
 * 1's column would be a guess, so they start unassigned.
 */
function splitFromSeats(
  draft: BillScreenDraft | null,
  seats: { id: string; name: string }[],
  assignBySeat: boolean,
): SplitState {
  const lines = draft?.lines ?? []
  // Ids DERIVED from the seat, never `newPersonId()` (code review UI-P2). This
  // runs during the first render on the server and again in the browser; a
  // time-based id differed between the two, and `data-drop` kept the server's,
  // so a drop onto a seat column landed on an owner that did not exist.
  const persons: Person[] = seats.map((seat) => ({ id: `seat-${seat.id}`, label: seat.name }))
  while (persons.length < 2) {
    persons.push({ id: `extra-${persons.length + 1}`, label: nextPersonLabel(persons) })
  }
  const allocation: Record<string, Piece[]> = {}
  if (assignBySeat) {
    for (const line of lines) {
      const index = seats.findIndex((seat) => seat.id === line.seatSlotId)
      if (index >= 0) {
        allocation[line.orderEventId] = [{ owner: persons[index]!.id, qty: line.quantity }]
      }
    }
  }
  return { view: 'split', persons, allocation }
}

/**
 * The bill screen (Story 6.5 and 6.3, designs 27, 28 and 29).
 *
 * ── Two views of one table ───────────────────────────────────────────────────
 * WHOLE — lines on the left, money on the right, one Settle, and a "Paying
 * separately?" card that opens the split.
 * SPLIT — a column per person, items moved between them, a Settle per person.
 * "Merge into one bill" goes back. Nothing is recorded by either view: a
 * person's bill is written when THEY settle, so the split can be rearranged
 * freely until money changes hands.
 *
 * A Separate-bills order opens straight into the split, pre-filled from the
 * seats it was ordered on.
 *
 * ── Moving items: drag, or tap then "Move here" ──────────────────────────────
 * HTML drag-and-drop does not fire for touch, and this runs on tablets. So an
 * item can also be TAPPED to pick it up, and every other column then offers
 * "Move here" — which is the design's own hint text. Mouse users can drag.
 *
 * Split by units (6.1 as amended, migration 0025): a "2× Lion Lager" can go one
 * to each person — pick the card and step "Move 1 of 2". A single unit cannot
 * be divided between people; sharing one dish is deferred.
 *
 * ── The split survives a reload, on this tablet ──────────────────────────────
 * Kept in localStorage per session, so a waiter who steps back to the order and
 * returns finds it as they left it. It is NOT shared across tablets; the bills
 * that come out of it are.
 */
export function BillScreen({
  sessionId,
  tableLabel,
  orderLabel = null,
  billMode,
  bills,
  draft,
  draftError = null,
  seats,
}: {
  sessionId: string
  tableLabel: string
  /** The day's order number, "#042" (Teran, 2026-11-02). */
  orderLabel?: string | null
  billMode: 'one' | 'separate'
  bills: BillScreenBill[]
  draft: BillScreenDraft | null
  /** Why the unbilled part could not be priced, when it could not (P2). */
  draftError?: string | null
  seats: { id: string; name: string }[]
}) {
  const router = useRouter()
  const storageKey = `bill-split:${sessionId}`
  const draftLines = draft?.lines ?? []

  // The first render is the same on the server and in the browser — the seat
  // pre-split or the whole view — and the saved split is applied after it.
  // Reading localStorage in the initialiser made the two disagree whenever a
  // split had been saved, which React reports as a hydration mismatch.
  const [split, setSplit] = useState<SplitState>(() =>
    billMode === 'separate' && draftLines.length > 0
      ? splitFromSeats(draft, seats, true)
      : { view: 'whole', persons: [], allocation: {} },
  )
  const [restored, setRestored] = useState(false)
  /** The card picked up by a tap, and how many of its units "Move here" moves. */
  const [selected, setSelected] = useState<{ key: string; count: number } | null>(null)
  /** A LKR 0 bill being recorded — guards a double tap. */
  const [recording, setRecording] = useState(false)
  /** The last pick-up or move, for the screen-reader live region (Story 6.1). */
  const [announcement, setAnnouncement] = useState('')
  const [paying, setPaying] = useState<Payable | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as
        | (SplitState & { billMode?: 'one' | 'separate' })
        | null
      // Only a split saved under the SAME bill mode (Teran, 2026-10-25). An
      // order switched to One bill on the order screen must open on the
      // one-bill view, not on the seat split it had while it was separate —
      // and switched to Separate bills, on a fresh split by seat. The mode is
      // the waiter's latest answer; a saved arrangement from before it is not.
      if (
        saved &&
        saved.billMode === billMode &&
        (saved.view === 'split' || saved.view === 'whole') &&
        // An older or hand-edited shape crashed the render (code review UI-P8).
        Array.isArray(saved.persons) &&
        saved.allocation &&
        typeof saved.allocation === 'object'
      ) {
        // An item ordered AFTER this split was saved — a custom charge on Seat
        // 2, a late dessert — has no entry in it, and fell into Not assigned
        // for the waiter to drag (Teran, 2026-11-02). On a Separate-bills
        // split it goes on the seat it was ordered on, as at first opening.
        // Only lines the saved split has never seen: one moved to Not assigned
        // keeps an entry (owner null) and stays where the waiter put it.
        const allocation = { ...saved.allocation }
        if (billMode === 'separate' && saved.view === 'split') {
          const columns = new Set(saved.persons.map((person) => person.id))
          for (const line of draftLines) {
            const owner = `seat-${line.seatSlotId}`
            if (!(line.orderEventId in allocation) && line.seatSlotId && columns.has(owner)) {
              allocation[line.orderEventId] = [{ owner, qty: line.quantity }]
            }
          }
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring browser-only state after hydration is exactly this
        setSplit({ ...saved, allocation })
      }
    } catch {
      // A private window or blocked storage: start fresh.
    }
    setRestored(true)
    // Not on `draftLines`: a refreshed bill must not throw away moves made
    // since opening — this is the restore, run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billMode, storageKey])

  useEffect(() => {
    // Not before the restore, or the default would overwrite what was saved.
    if (!restored) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ ...split, billMode }))
    } catch {
      // Storage is a convenience here, never a requirement.
    }
  }, [billMode, restored, split, storageKey])

  /** Names already on recorded bills — a new column must not reuse one. */
  const billLabels = bills.map((bill) => bill.label)

  // Only allocations that still make sense: the line is still unbilled, its
  // pieces add up to what is left of it, and every owner still exists. A bill
  // settled on another tablet changes what is left, and that line falls back
  // to unassigned rather than showing units nobody can bill.
  const personIds = new Set(split.persons.map((person) => person.id))
  // Takes the state to read from, so a `setSplit` updater can pass the
  // CURRENT state rather than this render's (code review UI-P5): two moves
  // before a re-render each started from the same old allocation, and the
  // second undid the first.
  const piecesOf = (line: BillScreenLine, state: SplitState = split): Piece[] => {
    const ids = state === split ? personIds : new Set(state.persons.map((person) => person.id))
    const saved = state.allocation[line.orderEventId]
    if (!saved || saved.reduce((total, piece) => total + piece.qty, 0) !== line.quantity) {
      return [{ owner: null, qty: line.quantity }]
    }
    return normalize(
      saved.map((piece) => ({
        owner: piece.owner && ids.has(piece.owner) ? piece.owner : null,
        qty: piece.qty,
      })),
    )
  }

  /** One owner's cards: their units of each line, priced per unit. */
  // Every card on the split, built once per render: each owner's units of
  // each dish, and which events (and how many of each) a card is made of.
  const members = new Map<string, { eventId: string; qty: number }[]>()
  const cardsByOwner = new Map<string | null, BillScreenLine[]>()
  for (const line of draftLines) {
    for (const piece of piecesOf(line)) {
      const key = cardKey(piece.owner, dishKey(line))
      const cards = cardsByOwner.get(piece.owner) ?? []
      const card = cards.find((candidate) => candidate.orderEventId === key)
      if (card) {
        card.quantity += piece.qty
        card.amountPaisa += piece.qty * line.unitPricePaisa
      } else {
        cards.push({
          ...line,
          orderEventId: key,
          quantity: piece.qty,
          amountPaisa: piece.qty * line.unitPricePaisa,
        })
      }
      cardsByOwner.set(piece.owner, cards)
      members.set(key, [...(members.get(key) ?? []), { eventId: line.orderEventId, qty: piece.qty }])
    }
  }
  const cardsFor = (owner: string | null): BillScreenLine[] => cardsByOwner.get(owner) ?? []
  const unassigned = cardsFor(null)
  const ownerOfCard = (key: string): string | null => key.slice(0, key.indexOf('::')) || null

  /**
   * Moves `count` units of a card to `target` — all of them when no count is
   * given, which is what a drag does.
   */
  function move(key: string, target: string | null | 'new', count?: number) {
    setSelected(null)
    const from = ownerOfCard(key)
    const parts = members.get(key)
    if (!parts) return
    setSplit((current) => {
      let persons = current.persons
      let to: string | null = target === 'new' ? null : target
      if (target === 'new') {
        const person = { id: newPersonId(), label: nextPersonLabel(current.persons, billLabels) }
        persons = [...current.persons, person]
        to = person.id
      }
      // Take the units from the card's events in order until `count` is met:
      // "Move 1 of 2" on a card made of two events moves one unit of one.
      let left = count ?? parts.reduce((total, part) => total + part.qty, 0)
      const allocation = { ...current.allocation }
      for (const part of parts) {
        if (left <= 0) break
        const line = draftLines.find((candidate) => candidate.orderEventId === part.eventId)
        if (!line) continue
        const pieces = piecesOf(line, current).map((piece) => ({ ...piece }))
        const source = pieces.find((piece) => piece.owner === from)
        if (!source) continue
        const moving = Math.min(left, source.qty)
        source.qty -= moving
        pieces.push({ owner: to, qty: moving })
        allocation[part.eventId] = normalize(pieces)
        left -= moving
      }
      return { ...current, persons, allocation }
    })
    // Said out loud as well as shown (code review UI-P14, Story 6.1).
    const line = draftLines.find((candidate) => candidate.orderEventId === parts[0]?.eventId)
    const destination =
      target === null
        ? 'Not assigned'
        : target === 'new'
          ? 'a new person'
          : (split.persons.find((person) => person.id === target)?.label ?? 'a person')
    if (line) {
      const moved = count ?? parts.reduce((total, part) => total + part.qty, 0)
      setAnnouncement(`Moved ${moved}× ${line.name} to ${destination}.`)
    }
  }

  // ── Dragging, on POINTER events (design 32) ─────────────────────────────
  // HTML drag-and-drop never fires for touch, and this runs on tablets: the
  // first version could only be dragged with a mouse. Pointer events cover a
  // finger and a mouse alike. A press that moves under 8px is a TAP and picks
  // the card for "Move here"; past 8px it becomes a drag, a tilted copy of the
  // card follows the pointer, and the column under it lights up.
  const [drag, setDrag] = useState<DragState | null>(null)
  const pending = useRef<{ key: string; count: number; line: BillScreenLine; x: number; y: number } | null>(null)
  const dragged = useRef(false)
  // `move` closes over this render's split; the window listeners are attached
  // once, so they reach the current one through a ref.
  const moveRef = useRef(move)
  useEffect(() => {
    moveRef.current = move
  })

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const press = pending.current
      if (!press) return
      if (!dragged.current) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 8) return
        dragged.current = true
      }
      setDrag({
        key: press.key,
        count: press.count,
        line: press.line,
        x: event.clientX,
        y: event.clientY,
        over: dropIdAt(event.clientX, event.clientY),
      })
    }
    function onUp(event: PointerEvent) {
      const press = pending.current
      pending.current = null
      if (!press || !dragged.current) {
        dragged.current = false
        return
      }
      setDrag(null)
      const over = dropIdAt(event.clientX, event.clientY)
      if (over !== undefined) moveRef.current(press.key, over === 'none' ? null : over, press.count)
      // The click that follows this pointerup must not also pick the card.
      setTimeout(() => {
        dragged.current = false
      }, 0)
    }
    function onCancel() {
      pending.current = null
      dragged.current = false
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [])

  /** A press on a card: maybe a tap, maybe the start of a drag. */
  function press(key: string, count: number, line: BillScreenLine, x: number, y: number) {
    pending.current = { key, count, line, x, y }
    dragged.current = false
  }

  function pick(key: string, qty: number) {
    // The click at the end of a drag is not a tap.
    if (dragged.current) return
    const picking = selected?.key !== key
    setSelected((current) => (current?.key === key ? null : { key, count: qty }))
    const line = draftLines.find(
      (candidate) => candidate.orderEventId === members.get(key)?.[0]?.eventId,
    )
    if (line) {
      setAnnouncement(
        picking
          ? `Picked up ${qty}× ${line.name}. Choose Move here on a column.`
          : `Put down ${line.name}.`,
      )
    }
  }

  /** What every draggable list needs from here. */
  const dragProps = {
    selected,
    onSelect: pick,
    onPress: press,
    draggingKey: drag?.key ?? null,
    onCount: (count: number) => setSelected((current) => (current ? { ...current, count } : null)),
  }

  /**
   * A person whose bill has been written: their column goes, and so do THEIR
   * units — they are on a bill now (code review UI-P3). Handing them back to
   * the pool, as `removePerson` does, broke every line they shared: a "2×"
   * split one each still summed to 2 in the allocation while the refreshed
   * draft had 1 left, so the whole line fell back to Not assigned and the
   * other person lost their half.
   */
  function retirePerson(personId: string) {
    setSelected(null)
    setSplit((current) => ({
      ...current,
      persons: current.persons.filter((person) => person.id !== personId),
      allocation: Object.fromEntries(
        Object.entries(current.allocation).map(([eventId, pieces]) => [
          eventId,
          normalize(pieces.filter((piece) => piece.owner !== personId)),
        ]),
      ),
    }))
  }

  function removePerson(personId: string) {
    setSelected(null)
    setSplit((current) => ({
      ...current,
      persons: current.persons.filter((person) => person.id !== personId),
      // Their units go back to the pool, merging with whatever is there.
      allocation: Object.fromEntries(
        Object.entries(current.allocation).map(([eventId, pieces]) => [
          eventId,
          normalize(
            pieces.map((piece) => (piece.owner === personId ? { ...piece, owner: null } : piece)),
          ),
        ]),
      ),
    }))
  }

  function startSplit() {
    setNotice(null)
    setSplit(splitFromSeats(draft, seats, billMode === 'separate'))
  }

  function merge() {
    setSelected(null)
    setSplit({ view: 'whole', persons: [], allocation: {} })
  }

  /**
   * Writes the bill for a draft or a person's share, at Settle.
   *
   * If the total the server writes differs from the one shown — a round
   * landed, or another tablet billed one of these items — it stops rather than
   * charge the guest a figure they were not quoted, and returns null.
   */
  /**
   * A person's units, as the server takes them. A card may hold several
   * events; each is taken for exactly this person's units of it. Shared by
   * Settle and Print, so the bill printed and the bill recorded cover the same
   * units.
   */
  function shareItems(lines: BillScreenLine[]) {
    return lines.flatMap((line) =>
      (members.get(line.orderEventId) ?? []).map((part) => ({
        eventId: part.eventId,
        quantity: part.qty,
      })),
    )
  }

  async function createBillFor(
    payable: Extract<Payable, { kind: 'draft' | 'person' }>,
  ): Promise<string | null> {
    const expected = outstandingOf(payable)
    const bill = await postJson<{ billId: string; totalPaisa: number }>(
      `/api/sessions/${sessionId}/bills`,
      payable.kind === 'draft'
        ? { type: 'consolidated' }
        : { type: 'split', personLabel: payable.title, items: shareItems(payable.lines) },
    )
    if (bill.totalPaisa !== expected) {
      setPaying(null)
      setNotice(
        `${payable.title}'s bill came to ${lkrFromPaisa(bill.totalPaisa)}, not ${lkrFromPaisa(
          expected,
        )}. It has been recorded — check it below and settle it.`,
      )
      router.refresh()
      return null
    }
    return bill.billId
  }

  /**
   * Settle a payable. With nothing due — free items, or comps covering it —
   * there is no money to take (code review P1): the bill is recorded and is
   * paid by definition, so the payment dialog is skipped.
   */
  async function settle(payable: Payable) {
    if (outstandingOf(payable) > 0) {
      setPaying(payable)
      return
    }
    // A double tap on "Record LKR 0 bill" wrote two bills (code review UI-P6).
    if (payable.kind === 'bill' || recording) return
    setRecording(true)
    try {
      const billId = await createBillFor(payable)
      if (!billId) return
      if (payable.kind === 'person') retirePerson(payable.key)
      setNotice(null)
      router.refresh()
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not record the bill.')
    } finally {
      setRecording(false)
    }
  }

  // ── Print (Story 6.6) ─────────────────────────────────────────────────────
  // Which payable is being sent to the printer, and which was just sent — the
  // button says "Sent to printer" for a moment, because nothing else on this
  // screen changes when a bill prints.
  const [printing, setPrinting] = useState<string | null>(null)
  const [printed, setPrinted] = useState<string | null>(null)
  useEffect(() => {
    if (!printed) return
    const timer = setTimeout(() => setPrinted(null), 2000)
    return () => clearTimeout(timer)
  }, [printed])

  /**
   * Sends a bill to the receipt printer. Nothing is recorded: a draft or a
   * person's share prints as it stands, priced by the server, and the waiter
   * can still change the order afterwards. A bill already written — paid,
   * part-paid, or written by a Settle whose payment failed — prints from what
   * was recorded.
   */
  async function printPayable(key: string, payable: Payable) {
    // Disabled while in flight: a double tap would print the bill twice.
    if (printing) return
    setPrinting(key)
    setNotice(null)
    try {
      const recorded = payable.kind === 'bill' ? payable.bill.billId : (payable.billId ?? null)
      if (recorded) {
        await postJson(`/api/bills/${recorded}/print`, {})
      } else if (payable.kind === 'person') {
        await postJson(`/api/sessions/${sessionId}/bill-print`, {
          items: shareItems(payable.lines),
          personLabel: payable.title,
          expectedTotalPaisa: totalsOf(payable).totalPaisa,
        })
      } else {
        // The total on THIS screen: the server refuses a different one rather
        // than print a bill the waiter never saw (Teran, 2026-11-11).
        await postJson(`/api/sessions/${sessionId}/bill-print`, {
          expectedTotalPaisa: totalsOf(payable).totalPaisa,
        })
      }
      setPrinted(key)
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not send the bill to the printer.')
    } finally {
      setPrinting(null)
    }
  }

  /** The props a Print button needs for one payable. */
  function printProps(key: string, payable: Payable) {
    // While the draft cannot be priced the screen cannot say what is owed, so
    // it offers no Print for it either (Task 7). A recorded bill still can.
    if (draftError && payable.kind !== 'bill') return {}
    return {
      onPrint: () => void printPayable(key, payable),
      printState: printing === key ? ('sending' as const) : printed === key ? ('sent' as const) : ('idle' as const),
      printDisabled: printing !== null && printing !== key,
    }
  }

  const [closing, setClosing] = useState(false)
  /** "All paid. Close Table 5?" — shown once, after the payment that settles everything. */
  const [askClose, setAskClose] = useState(false)
  /** Close the table once everything is paid (code review D1). */
  async function closeTable() {
    setClosing(true)
    try {
      await postJson(`/api/sessions/${sessionId}/close`, { reason: 'settled' })
      try {
        window.localStorage.removeItem(storageKey)
      } catch {
        // Nothing to clean up, then.
      }
      router.push('/')
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'Could not close the table.')
      setClosing(false)
    }
  }

  const unpaidBills = bills.filter((bill) => bill.paidPaisa < bill.totalPaisa)
  const paidBills = bills.filter((bill) => bill.paidPaisa >= bill.totalPaisa)

  const wholePayables: Payable[] = [
    ...unpaidBills.map((bill) => ({
      kind: 'bill' as const,
      key: bill.billId,
      title: bill.label,
      bill,
    })),
    ...(draft
      ? [
          {
            kind: 'draft' as const,
            key: 'draft' as const,
            title: bills.length === 0 ? 'Whole table' : 'Rest of the table',
            draft,
          },
        ]
      : []),
  ]

  const billTotal =
    bills.reduce((total, bill) => total + bill.totalPaisa, 0) + (draft?.totalPaisa ?? 0)
  const settled = bills.reduce((total, bill) => total + Math.min(bill.paidPaisa, bill.totalPaisa), 0)
  const outstanding = billTotal - settled
  // Every bill paid and nothing unbilled. A draft that could not be priced
  // counts as not paid — something is still owed that the screen cannot show.
  const allPaid = bills.length > 0 && outstanding === 0 && draft === null && !draftError
  const allLines = [...bills.flatMap((bill) => bill.lines), ...draftLines]
  const inSplit = split.view === 'split' && draft !== null

  return (
    <div className="h-app flex flex-col bg-slate-100">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center justify-between gap-sp-3 border-b border-slate-200 bg-white px-sp-4 py-sp-3">
        <div className="flex min-w-0 items-center gap-sp-3">
          <button
            type="button"
            onClick={() => router.push(`/orders/${sessionId}`)}
            aria-label="Back to the order"
            className={cn(
              'flex size-touch-kitchen shrink-0 items-center justify-center rounded-control',
              'border border-slate-200 bg-white text-slate-900',
              'transition-transform duration-80 ease-standard active:scale-[0.97]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            <ArrowLeft aria-hidden="true" strokeWidth={2.5} className="size-6" />
          </button>
          <div className="flex min-w-0 flex-col">
            <h1 className="truncate text-fs-24 font-extrabold tracking-title text-slate-900">
              Bill · {tableLabel}
            </h1>
            <p className="truncate text-fs-12 font-semibold text-slate-600">
              {orderLabel ? `${orderLabel} · ` : ''}
              {itemCount(allLines)} item{itemCount(allLines) === 1 ? '' : 's'} ·{' '}
              {inSplit
                ? `${split.persons.length} ${split.persons.length === 1 ? 'person' : 'people'} · settling separately`
                : 'paying together'}
            </p>
          </div>
          <span
            className={cn(
              'flex shrink-0 items-center gap-sp-1 rounded-pill px-sp-3 py-sp-1 text-fs-12 font-bold',
              inSplit ? 'bg-brand-050 text-brand-700' : 'bg-slate-100 text-slate-700',
            )}
          >
            {inSplit ? (
              <Users aria-hidden="true" className="size-4" />
            ) : (
              <Receipt aria-hidden="true" className="size-4" />
            )}
            {inSplit ? 'Separate bills' : 'One bill'}
          </span>
          {inSplit ? (
            <p className="hidden min-w-0 text-fs-12 text-slate-600 lg:block">
              Drag items between people, or tap an item then “Move here”
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-sp-3">
          {inSplit ? (
            <button
              type="button"
              onClick={merge}
              className={cn(
                'h-touch-standard rounded-control border border-slate-200 bg-white px-sp-4',
                'text-fs-14 font-bold text-slate-900 active:scale-[0.97]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
              )}
            >
              Merge into one bill
            </button>
          ) : null}
          <span
            className={cn(
              'flex items-center gap-sp-2 rounded-pill px-sp-4 py-sp-2 text-fs-14 font-bold',
              outstanding > 0 || draftError
                ? 'bg-occupied-chip text-occupied-ink'
                : 'bg-open-chip text-open-ink',
            )}
          >
            <span aria-hidden="true" className="size-2 rounded-pill bg-current" />
            {/* Not "Paid" while part of the order could not be priced — the
                notice says something is owed (code review UI-P7). */}
            {outstanding > 0
              ? `Unpaid ${lkrFromPaisa(outstanding)}`
              : draftError
                ? 'Check the order'
                : 'Paid'}
          </span>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <main className="flex min-h-0 flex-1 flex-col gap-sp-4 overflow-y-auto p-sp-4">
        {notice || draftError ? (
          <p
            role="status"
            className="rounded-control bg-occupied-chip px-sp-4 py-sp-3 text-fs-14 font-semibold text-occupied-ink"
          >
            {notice ?? draftError}
          </p>
        ) : null}

        {inSplit ? (
          // ── SPLIT: a column per person ───────────────────────────────────
          <div className="flex min-h-0 flex-1 gap-sp-4 overflow-x-auto pb-sp-1">
            {unpaidBills.map((bill) => (
              <Column key={bill.billId} title={bill.label} total={bill.totalPaisa - bill.paidPaisa} badge="Billed">
                <ItemList lines={bill.lines} />
                <ColumnFooter
                  totals={bill}
                  onSettle={() => settle({ kind: 'bill', key: bill.billId, title: bill.label, bill })}
                  due={bill.totalPaisa - bill.paidPaisa}
                  {...printProps(bill.billId, { kind: 'bill', key: bill.billId, title: bill.label, bill })}
                />
              </Column>
            ))}

            {unassigned.length > 0 ? (
              <Column
                title="Not assigned"
                total={unassigned.reduce((total, line) => total + line.amountPaisa, 0)}
                badge={`${itemCount(unassigned)} left`}
                tone="pending"
                moveHere={
                  selected && ownerOfCard(selected.key) !== null
                    ? () => move(selected.key, null, selected.count)
                    : undefined
                }
                dropId="none"
                isOver={drag?.over === 'none'}
              >
                <ItemList lines={unassigned} {...dragProps} />
                <p className="shrink-0 border-t border-occupied-edge px-sp-3 py-sp-2 text-fs-12 font-semibold text-occupied-ink">
                  Give every item to a person before settling the table.
                </p>
              </Column>
            ) : null}

            {split.persons.map((person) => {
              const lines = cardsFor(person.id)
              const totals = priceShare(lines, draft)
              // While a card from another column is held over this one, its
              // total shows what it WOULD be (Story 6.1).
              const preview =
                drag && drag.over === person.id && ownerOfCard(drag.key) !== person.id
                  ? priceShare(
                      [
                        ...lines,
                        {
                          ...drag.line,
                          quantity: drag.count,
                          amountPaisa: drag.count * drag.line.unitPricePaisa,
                        },
                      ],
                      draft,
                    )
                  : null
              return (
                <Column
                  key={person.id}
                  title={person.label}
                  total={(preview ?? totals).totalPaisa}
                  // Items waiting on this person to pay, as drawn.
                  badge={lines.length > 0 ? 'Awaiting' : undefined}
                  onRemove={() => removePerson(person.id)}
                  moveHere={
                    selected && ownerOfCard(selected.key) !== person.id
                      ? () => move(selected.key, person.id, selected.count)
                      : undefined
                  }
                  dropId={person.id}
                  isOver={drag?.over === person.id}
                >
                  {lines.length === 0 ? (
                    <div className="m-sp-3 flex flex-1 items-center justify-center rounded-card border-2 border-dashed border-slate-200 text-fs-14 font-semibold text-slate-400">
                      Drag items here
                    </div>
                  ) : (
                    <ItemList lines={lines} {...dragProps} />
                  )}
                  {lines.length > 0 ? (
                    <ColumnFooter
                      totals={totals}
                      due={totals.totalPaisa}
                      onSettle={() =>
                        settle({ kind: 'person', key: person.id, title: person.label, lines, totals })
                      }
                      {...printProps(person.id, { kind: 'person', key: person.id, title: person.label, lines, totals })}
                    />
                  ) : (
                    <div className="shrink-0 border-t border-slate-200 p-sp-3">
                      <button
                        type="button"
                        onClick={() => removePerson(person.id)}
                        className="h-touch-standard w-full rounded-control border border-slate-200 bg-white text-fs-14 font-bold text-slate-600 active:scale-[0.98]"
                      >
                        Remove person
                      </button>
                    </div>
                  )}
                </Column>
              )
            })}

            {/* Add person — and, while an item is picked up, a place to drop it
                that starts a new person with it. */}
            <button
              type="button"
              onClick={() => (selected ? move(selected.key, 'new', selected.count) : setSplit((current) => ({
                ...current,
                persons: [...current.persons, { id: newPersonId(), label: nextPersonLabel(current.persons, billLabels) }],
              })))}
              data-drop="new"
              className={cn(
                // About two-thirds of a column, as drawn.
                'flex min-w-48 shrink-0 basis-[calc(16%-12px)] flex-col items-center justify-center gap-sp-2 rounded-panel',
                'border-2 border-dashed border-slate-300 bg-transparent p-sp-4 text-center',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                (selected || drag?.over === 'new') && 'border-brand-500 bg-brand-050',
              )}
            >
              <span className="flex size-12 items-center justify-center rounded-control bg-white shadow-el-1">
                <Plus aria-hidden="true" className="size-6 text-brand-700" />
              </span>
              <span className="text-fs-16 font-bold text-slate-900">
                {selected ? 'Move to a new person' : 'Add person'}
              </span>
              <span className="text-fs-12 text-slate-600">Drop an item here to start a new bill</span>
            </button>
          </div>
        ) : wholePayables.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-panel border border-dashed border-slate-200 bg-white p-sp-5 text-center text-fs-16 text-slate-600">
            {allLines.length === 0
              ? 'Nothing has been sent to the kitchen yet, so there is nothing to bill.'
              : draftError
                ? 'Part of this order could not be priced — see the notice above.'
                : 'Everything on this table is paid.'}
          </div>
        ) : wholePayables.length === 1 ? (
          // ── WHOLE: the design's one-bill layout, 2 : 1 ───────────────────
          <div className="flex min-h-0 flex-1 flex-col gap-sp-4 md:flex-row">
            <div className="flex min-h-0 flex-col md:min-w-0 md:flex-[2_2_0%]">
              <LinesCard title={wholePayables[0]!.title} lines={linesOf(wholePayables[0]!)} />
            </div>
            <div className="flex shrink-0 flex-col gap-sp-4 md:min-w-0 md:flex-[1_1_0%]">
              <TotalsCard
                totals={totalsOf(wholePayables[0]!)}
                paidPaisa={wholePayables[0]!.kind === 'bill' ? wholePayables[0]!.bill.paidPaisa : 0}
                onSettle={() => settle(wholePayables[0]!)}
                {...printProps(wholePayables[0]!.key, wholePayables[0]!)}
              />
              {/* Offered from two DRINKS, not two lines: "2× Lion Lager" is one
                  line, and since migration 0025 the split gives one to each
                  person. Counting lines hid the card on exactly the bar tab
                  that needed it (Teran, 2026-10-30). */}
              {wholePayables[0]!.kind === 'draft' && itemCount(draftLines) >= 2 ? (
                <SplitCard onSplit={startSplit} />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-sp-4">
            {wholePayables.map((payable) => (
              <div key={payable.key} className="flex min-h-0 flex-col gap-sp-3">
                <LinesCard title={payable.title} lines={linesOf(payable)} />
                <TotalsCard
                  totals={totalsOf(payable)}
                  paidPaisa={payable.kind === 'bill' ? payable.bill.paidPaisa : 0}
                  onSettle={() => settle(payable)}
                  {...printProps(payable.key, payable)}
                />
                {payable.kind === 'draft' && itemCount(draftLines) >= 2 ? (
                  <SplitCard onSplit={startSplit} />
                ) : null}
              </div>
            ))}
          </div>
        )}

        {paidBills.length > 0 ? (
          <section className="flex shrink-0 flex-col gap-sp-2">
            <h2 className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">Paid</h2>
            <ul className="flex flex-wrap gap-sp-2">
              {paidBills.map((bill) => {
                const key = `receipt:${bill.billId}`
                const state = printing === key ? 'sending' : printed === key ? 'sent' : 'idle'
                return (
                  <li
                    key={bill.billId}
                    className="flex items-center gap-sp-3 rounded-control bg-open-chip py-sp-1 pr-sp-1 pl-sp-3 text-fs-14 font-semibold text-open-ink"
                  >
                    <span>
                      {bill.label} · {lkrFromPaisa(bill.totalPaisa)}
                    </span>
                    {/* The receipt already printed at payment (Teran,
                        2026-11-10), so this is a rare reprint, marked COPY —
                        a small icon beside what it reprints, with a full
                        44px target. It says so when it has been sent. */}
                    {state === 'sent' ? (
                      <span className="pr-sp-2 text-fs-12 font-bold">Sent</span>
                    ) : null}
                    <button
                      type="button"
                      disabled={printing !== null}
                      onClick={() =>
                        void printPayable(key, { kind: 'bill', key: bill.billId, title: bill.label, bill })
                      }
                      aria-label={`Print another receipt for ${bill.label}`}
                      title="Print another receipt"
                      className={cn(
                        'flex size-touch-standard items-center justify-center rounded-control text-open-ink',
                        'hover:bg-white/60 active:scale-[0.95] disabled:opacity-60',
                        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                      )}
                    >
                      <Printer aria-hidden="true" strokeWidth={2} className="size-4" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
      </main>

      {/* The card in flight: a tilted copy following the pointer, as design 32
          draws it. Pointer-transparent, so the column under it is what the
          drop lands in. */}
      {drag ? (
        <div
          aria-hidden="true"
          style={{ left: drag.x - 130, top: drag.y - 28 }}
          className="pointer-events-none fixed z-[60] flex w-64 -rotate-2 items-baseline justify-between gap-sp-2 rounded-card border-2 border-brand-500 bg-white p-sp-3 shadow-el-2"
        >
          <span className="min-w-0 truncate text-fs-16 font-bold text-slate-900">
            <span className="text-brand-700">{drag.count}×</span> {drag.line.name}
          </span>
          <span className="shrink-0 text-fs-14 font-bold tabular-nums text-slate-900">
            {lkrFromPaisa(drag.count * drag.line.unitPricePaisa)}
          </span>
        </div>
      ) : null}

      {/* ── Bottom bar ─────────────────────────────────────────────────────────
          The SAME shell as the order and floor bars, not a look-alike. A
          hand-built footer came out shorter than both — their height comes from
          the 80px buttons inside the shell, and this bar has none yet — so the
          summary is held at that same 80px. */}
      <ActionStripShell
        regionLabel="Bill summary"
        leading={
          <div className="flex h-touch-waiter items-center gap-sp-5">
            <dl className="grid grid-cols-[auto_auto] gap-x-sp-4 gap-y-sp-1 text-fs-14">
              <dt className="text-slate-600">Settled</dt>
              <dd className="text-right font-bold tabular-nums text-open-ink">
                {lkrFromPaisa(settled)}
              </dd>
              <dt className="font-semibold text-slate-900">Outstanding</dt>
              <dd className="text-right font-bold tabular-nums text-slate-900">
                {lkrFromPaisa(outstanding)}
              </dd>
            </dl>
            <div className="flex items-baseline gap-sp-2 border-l border-slate-200 pl-sp-5">
              <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                Bill
              </span>
              <span className="text-fs-24 font-extrabold tabular-nums text-slate-900">
                {lkrFromPaisa(billTotal)}
              </span>
            </div>
          </div>
        }
      >
        {/* As design 27 draws it: always present, disabled until the order is
            fully paid. The server re-checks before it closes (NOT_SETTLED),
            and records the close as `settled`. */}
        <button
          type="button"
          disabled={!allPaid || closing}
          onClick={closeTable}
          className={cn(
            'h-touch-waiter min-w-40 rounded-waiter px-sp-5 text-fs-16 font-bold',
            'transition-transform duration-80 ease-standard active:scale-[0.97]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            allPaid ? 'bg-brand-800 text-white shadow-el-2' : 'bg-slate-100 text-slate-400',
          )}
        >
          {closing ? 'Closing…' : allPaid ? 'All paid · Close table' : 'Close table'}
        </button>
      </ActionStripShell>

      {askClose ? (
        <CloseAfterPaymentDialog
          tableLabel={tableLabel}
          closing={closing}
          onClose={() => {
            setAskClose(false)
            void closeTable()
          }}
          onKeepOpen={() => setAskClose(false)}
        />
      ) : null}

      {paying ? (
        <PaymentDialog
          title={`${paying.title} · ${tableLabel}`}
          duePaisa={outstandingOf(paying)}
          onCancel={() => {
            // A bill was written but not paid: refresh, so it appears as a
            // recorded bill to settle rather than staying hidden (UI-P1).
            const wrote = paying.kind !== 'bill' && Boolean(paying.billId)
            setPaying(null)
            if (wrote) router.refresh()
          }}
          onPay={async (tenders, cashReceivedPaisa) => {
            // A bill this dialog already wrote, on a retry after a failed
            // payment (code review UI-P1), is paid — never written again.
            let billId = paying.kind === 'bill' ? paying.bill.billId : (paying.billId ?? null)
            if (!billId && paying.kind !== 'bill') {
              billId = await createBillFor(paying)
              if (!billId) return
              const written = billId
              setPaying((current) =>
                current && current.kind !== 'bill' ? { ...current, billId: written } : current,
              )
              // Their units are billed now, whatever happens to the payment.
              if (paying.kind === 'person') retirePerson(paying.key)
            }
            if (!billId) return

            const paid = await postJson<{
              allPaid: boolean
              settled: boolean
              receiptJobId: string | null
              /** The guest already has the printed BILL for this (Teran, 2026-11-13). */
              receiptSkipped?: boolean
            }>(`/api/bills/${billId}/payments`, {
              tenders,
              cashReceivedPaisa,
            })
            setPaying(null)
            // The last bill is paid: ask, once, whether the guests have gone
            // (Teran, 2026-11-10). Asked, never done — a paid table can still
            // have people at it, which is why closing stopped being automatic
            // (code review D1).
            if (paid.allPaid) setAskClose(true)
            // Paying never closes the table (code review D1). When everything
            // is paid the refreshed screen offers Close table in the bar.
            // That person is paid: their column goes, and their items are on a
            // bill now, so the draft the server sends back no longer has them.
            // The receipt prints by itself. If it could not be queued the money is
            // still recorded — say so, so nobody waits at the printer.
            setNotice(
              paid.settled && !paid.receiptJobId && !paid.receiptSkipped
                ? 'Paid, but the receipt was not queued. Use the print icon on the paid bill to get one.'
                : null,
            )
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}

function SplitCard({ onSplit }: { onSplit: () => void }) {
  return (
    <section className="flex shrink-0 flex-col gap-sp-3 rounded-panel border-2 border-dashed border-slate-300 p-sp-4">
      <div className="flex items-center gap-sp-3">
        <span className="flex size-10 items-center justify-center rounded-control bg-brand-050">
          <Users aria-hidden="true" className="size-5 text-brand-700" />
        </span>
        <h3 className="text-fs-16 font-extrabold text-slate-900">Paying separately?</h3>
      </div>
      <p className="text-fs-14 text-slate-600">
        Split into one bill per person, then drag each item to whoever is paying for it.
      </p>
      <button
        type="button"
        onClick={onSplit}
        className={cn(
          'h-touch-kitchen rounded-waiter border border-brand-300 bg-brand-050 text-fs-16 font-bold text-brand-700',
          'active:scale-[0.98]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        Split bill
      </button>
    </section>
  )
}

/** One column of the split: a person, the unassigned pool, or a recorded bill. */
function Column({
  title,
  total,
  badge,
  tone = 'person',
  onRemove,
  moveHere,
  dropId,
  isOver = false,
  children,
}: {
  title: string
  total: number
  badge?: string
  tone?: 'person' | 'pending'
  onRemove?: () => void
  /** Present while an item from ANOTHER column is picked up. */
  moveHere?: () => void
  /** Makes the column a drop target: `none`, a person's id. */
  dropId?: string
  /** A dragged card is over this column. */
  isOver?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      data-drop={dropId}
      className={cn(
        // A quarter of the row, as drawn — four columns fill the screen in
        // design 28. A fixed 288px read as narrow on a wide display; 288px
        // stays the floor so a small tablet scrolls rather than crushes.
        'flex min-w-72 shrink-0 basis-[calc(25%-12px)] flex-col overflow-hidden rounded-panel',
        tone === 'pending'
          ? 'border-2 border-dashed border-occupied-edge bg-occupied-body'
          : 'border border-slate-200 bg-white shadow-el-1',
        // The design marks the target with a brand edge along the top.
        isOver && 'border-t-4 border-t-brand-500',
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-sp-2 border-b border-slate-200 px-sp-3 py-sp-3">
        <div className="flex min-w-0 items-center gap-sp-2">
          <h2 className="truncate text-fs-16 font-extrabold text-slate-900">{title}</h2>
          {badge ? (
            <span className="shrink-0 rounded-pill bg-occupied-chip px-sp-2 py-0.5 text-fs-12 font-bold tracking-micro text-occupied-ink uppercase">
              {badge}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-sp-1">
          <span className="text-fs-16 font-extrabold tabular-nums text-slate-900">
            {lkrFromPaisa(total)}
          </span>
          {onRemove ? (
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove ${title}`}
              className="flex size-9 items-center justify-center rounded-control text-slate-400 hover:text-slate-700"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
      </header>
      {moveHere ? (
        <button
          type="button"
          onClick={moveHere}
          className="m-sp-3 mb-0 h-touch-standard shrink-0 rounded-control bg-brand-800 text-fs-14 font-bold text-white active:scale-[0.98]"
        >
          Move here
        </button>
      ) : null}
      {children}
    </section>
  )
}

function ItemList({
  lines,
  selected = null,
  onSelect,
  onCount,
  onPress,
  draggingKey = null,
}: {
  lines: BillScreenLine[]
  selected?: { key: string; count: number } | null
  onSelect?: (key: string, qty: number) => void
  /** Sets how many of the picked card's units "Move here" will move. */
  onCount?: (count: number) => void
  /** A press that may become a drag. */
  onPress?: (key: string, count: number, line: BillScreenLine, x: number, y: number) => void
  /** The card currently being dragged, dimmed where it sits. */
  draggingKey?: string | null
}) {
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-sp-2 overflow-y-auto p-sp-3">
      {lines.map((line) => {
        const isSelected = selected?.key === line.orderEventId
        const content = (
          <>
            <span className="flex w-full items-baseline justify-between gap-sp-2">
              <span className="min-w-0 truncate text-fs-16 font-bold text-slate-900">
                <span className="text-brand-700">{line.quantity}×</span> {line.name}
              </span>
              <span className="shrink-0 text-fs-14 font-bold tabular-nums text-slate-900">
                {lkrFromPaisa(line.amountPaisa)}
              </span>
            </span>
            <span className="flex w-full items-center gap-sp-2">
              <StationChip destination={line.destination} />
              {/* Everything on a bill has gone to the kitchen — that is what
                  makes it billable — and the design says so on the card. */}
              <span className="text-fs-12 font-bold tracking-micro text-open-ink uppercase">Sent</span>
              {lineDetail(line) ? (
                <span className="truncate text-fs-12 text-slate-600">{lineDetail(line)}</span>
              ) : null}
              {onPress ? (
                <GripVertical aria-hidden="true" className="ml-auto size-4 shrink-0 text-slate-400" />
              ) : null}
            </span>
          </>
        )
        return (
          <li key={line.orderEventId}>
            {onSelect ? (
              <button
                type="button"
                aria-pressed={isSelected}
                // A drag of the PICKED card carries the count chosen on its
                // stepper — "Move 1 of 2", then drag, moves one.
                onPointerDown={(event) => {
                  if (event.button !== 0 || !onPress) return
                  onPress(
                    line.orderEventId,
                    isSelected ? selected!.count : line.quantity,
                    line,
                    event.clientX,
                    event.clientY,
                  )
                }}
                onClick={() => onSelect(line.orderEventId, line.quantity)}
                className={cn(
                  // `touch-none`: on a tablet a finger on a card drags it rather
                  // than scrolling the column. The column scrolls from its gaps.
                  'flex w-full cursor-grab touch-none flex-col items-start gap-sp-1 rounded-card border bg-white p-sp-3 text-left select-none',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  isSelected ? 'border-brand-500 ring-2 ring-brand-500' : 'border-slate-200',
                  draggingKey === line.orderEventId && 'opacity-50',
                )}
              >
                {content}
              </button>
            ) : (
              <div className="flex flex-col gap-sp-1 rounded-card border border-slate-200 bg-white p-sp-3">
                {content}
              </div>
            )}
            {/* How many of a "2×" to move. Beside the card, not inside it — a
                stepper in the card would be a button inside a button. Starts at
                all of them; step down to split one off. */}
            {isSelected && onCount && line.quantity > 1 ? (
              <div className="mt-sp-1 flex items-center justify-between gap-sp-2 rounded-control bg-brand-050 px-sp-3 py-sp-1">
                <span className="text-fs-14 font-semibold text-brand-700">
                  Move {selected!.count} of {line.quantity}
                </span>
                <span className="flex items-center gap-sp-1">
                  <button
                    type="button"
                    aria-label="Move one fewer"
                    disabled={selected!.count <= 1}
                    onClick={() => onCount(selected!.count - 1)}
                    className="flex size-10 items-center justify-center rounded-control bg-white text-fs-18 font-bold text-brand-700 disabled:opacity-40"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    aria-label="Move one more"
                    disabled={selected!.count >= line.quantity}
                    onClick={() => onCount(selected!.count + 1)}
                    className="flex size-10 items-center justify-center rounded-control bg-white text-fs-18 font-bold text-brand-700 disabled:opacity-40"
                  >
                    +
                  </button>
                </span>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Asked once, after the payment that settles everything (Teran, 2026-11-10).
 *
 * Paid is not the same as gone — guests linger over coffee — so the table is
 * not closed for them (code review D1). This puts the question where the
 * waiter already is, with Keep open as the safe answer. The floor offers
 * Close table again later, from its bottom bar.
 */
function CloseAfterPaymentDialog({
  tableLabel,
  closing,
  onClose,
  onKeepOpen,
}: {
  tableLabel: string
  closing: boolean
  onClose: () => void
  onKeepOpen: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-after-payment-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onKeepOpen()
      }}
    >
      <div className="flex w-full max-w-md flex-col gap-sp-4 rounded-panel bg-white p-sp-5 shadow-el-2">
        <div className="flex flex-col gap-sp-1">
          <span className="text-fs-12 font-bold tracking-micro text-open-ink uppercase">All paid</span>
          <h2 id="close-after-payment-title" className="text-fs-24 font-extrabold text-slate-900">
            Close {tableLabel}?
          </h2>
          <p className="text-fs-14 text-slate-600">
            Keep it open if the guests are still at the table. You can close it later from the floor.
          </p>
        </div>
        <div className="flex gap-sp-3">
          <button
            type="button"
            autoFocus
            onClick={onKeepOpen}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter border border-slate-200 bg-white text-fs-16 font-bold text-slate-900',
              'active:scale-[0.98]',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            Keep open
          </button>
          <button
            type="button"
            disabled={closing}
            onClick={onClose}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter bg-brand-800 text-fs-16 font-bold text-white shadow-el-2',
              'active:scale-[0.98] disabled:opacity-60',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            {closing ? 'Closing…' : 'Close table'}
          </button>
        </div>
      </div>
    </div>
  )
}

type PrintState = 'idle' | 'sending' | 'sent'

/**
 * Print the bill (Story 6.6) — secondary to Settle, never instead of it.
 *
 * A real button, not an icon: printing the bill for a guest who asks for it is
 * an everyday action, so it gets the same height as Settle beside it. Disabled
 * while it sends, because a double tap would print the bill twice.
 */
function PrintBillButton({
  state,
  disabled,
  onPrint,
  size,
}: {
  state: PrintState
  disabled: boolean
  onPrint: () => void
  size: 'waiter' | 'kitchen'
}) {
  return (
    <button
      type="button"
      onClick={onPrint}
      disabled={disabled || state === 'sending'}
      className={cn(
        size === 'waiter' ? 'h-touch-waiter text-fs-16' : 'h-touch-kitchen text-fs-14',
        'flex items-center justify-center gap-sp-2 rounded-waiter border border-slate-200 bg-white font-bold text-slate-900',
        'active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
      )}
    >
      <Printer aria-hidden="true" strokeWidth={2} className="size-5" />
      {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Sent to printer' : 'Print bill'}
    </button>
  )
}

function ColumnFooter({
  totals,
  due,
  onSettle,
  onPrint,
  printState = 'idle',
  printDisabled = false,
}: {
  totals: Totals
  due: number
  onSettle: () => void
  onPrint?: () => void
  printState?: PrintState
  printDisabled?: boolean
}) {
  return (
    <div className="flex shrink-0 flex-col gap-sp-2 border-t border-slate-200 bg-slate-50 p-sp-3">
      {totals.serviceChargeBp > 0 ? (
        <div className="flex justify-between text-fs-12 text-slate-600">
          <span>{lkrFromPaisa(totals.subtotalPaisa)} + service</span>
          <span className="tabular-nums">{lkrFromPaisa(totals.serviceChargePaisa)}</span>
        </div>
      ) : null}
      {onPrint ? (
        <PrintBillButton state={printState} disabled={printDisabled} onPrint={onPrint} size="kitchen" />
      ) : null}
      <button
        type="button"
        onClick={onSettle}
        className={cn(
          'h-touch-kitchen rounded-waiter bg-brand-800 text-fs-16 font-bold text-white shadow-el-2',
          'active:scale-[0.98]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        {due > 0 ? `Settle ${lkrFromPaisa(due)}` : 'Record LKR 0 bill'}
      </button>
    </div>
  )
}

function StationChip({ destination }: { destination: ProductionDestination | null }) {
  if (!destination) return null
  const route = routeForDestination(destination)
  return (
    <span
      className={cn(
        'shrink-0 rounded-pill bg-slate-100 px-sp-2 py-0.5 text-fs-12 font-bold tracking-micro uppercase',
        route.ink,
      )}
    >
      {route.short}
    </span>
  )
}

/**
 * Identical dishes as one line: same name, unit price, note and station
 * (Teran, 2026-10-25).
 *
 * Two Devilled Cashews ordered for two different seats are two order events —
 * that is what lets the split give one to each person — but on one bill a
 * guest should read "2× Devilled Cashew", not the same dish twice. DISPLAY
 * only: the events stay separate underneath, so splitting again behaves
 * exactly as before. A different price (a re-price between rounds) or a
 * different note ("no chilli") keeps the lines apart, because they are not
 * the same thing on a bill.
 */
function groupLines(lines: BillScreenLine[]): BillScreenLine[] {
  const groups = new Map<string, BillScreenLine>()
  for (const line of lines) {
    const key = dishKey(line)
    const existing = groups.get(key)
    if (existing) {
      existing.quantity += line.quantity
      existing.amountPaisa += line.amountPaisa
    } else {
      groups.set(key, { ...line })
    }
  }
  return [...groups.values()]
}

function LinesCard({ title, lines: ungrouped }: { title: string; lines: BillScreenLine[] }) {
  const lines = groupLines(ungrouped)
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-panel bg-white shadow-el-1">
      <header className="flex shrink-0 items-baseline justify-between gap-sp-3 border-b border-slate-200 px-sp-5 py-sp-4">
        <h2 className="text-fs-18 font-extrabold text-slate-900">{title}</h2>
        <span className="text-fs-14 font-semibold text-slate-600">
          {lines.length} line{lines.length === 1 ? '' : 's'} · {itemCount(lines)} item
          {itemCount(lines) === 1 ? '' : 's'}
        </span>
      </header>
      {/* Read aloud to a guest and checked by them across the table, so the
          rows are sized for that: 18px names, 64px rows. */}
      <ul className="min-h-0 flex-1 divide-y divide-slate-200 overflow-y-auto px-sp-5">
        {lines.map((line) => (
          <li key={line.orderEventId} className="flex min-h-16 items-center gap-sp-4 py-sp-3">
            <span className="w-10 shrink-0 text-fs-18 font-extrabold text-brand-700 tabular-nums">
              {line.quantity}×
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-fs-18 font-bold text-slate-900">
                {line.name}
              </span>
              {lineDetail(line) ? (
                <span className="block truncate text-fs-14 text-slate-600">{lineDetail(line)}</span>
              ) : null}
            </span>
            <StationChip destination={line.destination} />
            <span className="w-28 shrink-0 text-right text-fs-18 font-extrabold tabular-nums text-slate-900">
              {lkrFromPaisa(line.amountPaisa)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TotalsCard({
  totals,
  paidPaisa,
  onSettle,
  onPrint,
  printState = 'idle',
  printDisabled = false,
}: {
  totals: Totals
  paidPaisa: number
  onSettle: () => void
  onPrint?: () => void
  printState?: PrintState
  printDisabled?: boolean
}) {
  const due = totals.totalPaisa - paidPaisa
  return (
    <section className="flex shrink-0 flex-col gap-sp-2 rounded-panel bg-white p-sp-4 shadow-el-1">
      <Row label="Subtotal" value={totals.subtotalPaisa} />
      {totals.serviceChargeBp > 0 ? (
        <Row label={`Service ${percentFromBp(totals.serviceChargeBp)}%`} value={totals.serviceChargePaisa} />
      ) : null}
      {totals.taxBp > 0 ? (
        <Row label={`Tax ${percentFromBp(totals.taxBp)}%`} value={totals.taxPaisa} />
      ) : null}
      <div className="mt-sp-1 flex items-baseline justify-between gap-sp-3 border-t border-slate-200 pt-sp-3">
        <span className="text-fs-16 font-bold text-slate-900">Total</span>
        <span className="text-fs-32 font-extrabold tabular-nums text-slate-900">
          {lkrFromPaisa(totals.totalPaisa)}
        </span>
      </div>
      {paidPaisa > 0 ? (
        <>
          <Row label="Paid" value={paidPaisa} />
          <Row label="Still to pay" value={due} />
        </>
      ) : null}
      {onPrint ? (
        <div className="mt-sp-2 flex flex-col">
          <PrintBillButton state={printState} disabled={printDisabled} onPrint={onPrint} size="waiter" />
        </div>
      ) : null}
      <button
        type="button"
        onClick={onSettle}
        className={cn(
          'mt-sp-2 h-touch-waiter rounded-waiter bg-brand-800 text-fs-18 font-bold text-white shadow-el-2',
          'transition-transform duration-80 ease-standard active:scale-[0.98]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        {due > 0 ? `Settle ${lkrFromPaisa(due)}` : 'Record LKR 0 bill'}
      </button>
    </section>
  )
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-sp-3 text-fs-14">
      <span className="text-slate-600">{label}</span>
      <span className="font-semibold tabular-nums text-slate-900">{lkrFromPaisa(value)}</span>
    </div>
  )
}

/**
 * Taking the money (design 31): method on the left, a number pad on the right.
 *
 * ── Cash: type what the guest handed over ────────────────────────────────────
 * RECEIVED fills from the pad (whole rupees; "00" for the round notes), or
 * from the quick buttons — Exact, then the next round 1,000 and 5,000 above.
 * Received at or above the total shows the change. What is RECORDED is the
 * bill's amount, never the note: change never belonged to the restaurant
 * (see `payment_records`).
 *
 * ── Cash + card: part of each (FR28-30, Story 6.5) ───────────────────────────
 * Its own method, as the docs specify. The design drew only Cash and Card, and
 * a split hidden inside "cash that falls short" was not one a waiter could
 * find (Teran, 2026-10-25). The pad types the CASH part and the CARD part is
 * the rest; both must be above zero. Cash that falls short in Cash mode does
 * not split by itself: its action switches to Cash + card, keeping the
 * amount, so a split is always confirmed on purpose.
 *
 * ── Card ─────────────────────────────────────────────────────────────────────
 * Charge the total on the machine, then confirm.
 *
 * Not drawn yet, rather than drawn dead: TIP (nothing stores a tip — a payment
 * is capped at the bill). The receipt prints by itself when this records the
 * payment that settles the bill (Teran, 2026-11-10); Print receipt in the Paid
 * list prints another, marked COPY.
 */
function PaymentDialog({
  title,
  duePaisa,
  onCancel,
  onPay,
}: {
  title: string
  duePaisa: number
  onCancel: () => void
  /**
   * `cashReceivedPaisa` is what the pad holds in Cash mode — the note the guest
   * handed over — so the receipt can print the change (Story 6.6). Absent for
   * card, and for Cash + card, where the pad types the exact cash part.
   */
  onPay: (
    tenders: { method: 'cash' | 'card'; amountPaisa: number }[],
    cashReceivedPaisa?: number,
  ) => Promise<void>
}) {
  const [method, setMethod] = useState<'cash' | 'card' | 'split'>('cash')
  // What the pad has typed, in WHOLE RUPEES as a digit string. "Exact" may set
  // a paisa amount that is not whole rupees, so it is held separately.
  const [digits, setDigits] = useState('')
  const [exact, setExact] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const received = exact ?? (digits === '' ? null : Number(digits) * 100)
  const stillNeeded = received === null ? duePaisa : Math.max(duePaisa - received, 0)
  const change = received !== null && received > duePaisa ? received - duePaisa : 0

  // Quick notes: exact, then the next round 1,000 and 5,000 above the total.
  const quick = Array.from(
    new Set([100_000, 500_000].map((step) => Math.ceil(duePaisa / step) * step)),
  ).filter((amount) => amount > duePaisa)

  function press(key: string) {
    setError(null)
    setExact(null)
    setDigits((current) => {
      if (key === 'back') return current.slice(0, -1)
      const next = (current + key).replace(/^0+/, '')
      // Seven digits is LKR 9,999,999 — more cash than anyone carries in.
      return next.length > 7 ? current : next
    })
  }

  const cash = received ?? 0
  const hasCash = cash > 0
  // Cash in Cash mode that does not cover the bill: the action offers a split.
  const cashShort = method === 'cash' && hasCash && cash < duePaisa

  const tenders: { method: 'cash' | 'card'; amountPaisa: number }[] | null =
    method === 'card'
      ? [{ method: 'card', amountPaisa: duePaisa }]
      : method === 'cash'
        ? hasCash && cash >= duePaisa
          ? [{ method: 'cash', amountPaisa: duePaisa }]
          : null
        : hasCash && cash < duePaisa
          ? [
              { method: 'cash', amountPaisa: cash },
              { method: 'card', amountPaisa: duePaisa - cash },
            ]
          : null

  const actionLabel = busy
    ? 'Recording…'
    : method === 'card'
      ? `Card payment taken · ${lkrFromPaisa(duePaisa)}`
      : method === 'cash'
        ? !hasCash
          ? 'Enter amount received'
          : cashShort
            ? `${lkrFromPaisa(stillNeeded)} short · pay the rest by card`
            : change > 0
              ? `Record cash · change ${lkrFromPaisa(change)}`
              : 'Record cash'
        : !hasCash
          ? 'Enter the cash part'
          : cash >= duePaisa
            ? 'Cash covers it all · use Cash'
            : `Record ${lkrFromPaisa(cash)} cash + ${lkrFromPaisa(stillNeeded)} card`

  const focusRing =
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="payment-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
    >
      <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-panel bg-white shadow-el-2">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <header className="flex shrink-0 items-start justify-between gap-sp-4 border-b border-slate-200 px-sp-5 py-sp-4">
          <div className="flex min-w-0 flex-col">
            <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
              Settle
            </span>
            <h2 id="payment-title" className="truncate text-fs-24 font-extrabold text-slate-900">
              {title}
            </h2>
          </div>
          <div className="flex shrink-0 items-start gap-sp-4">
            <div className="flex flex-col items-end">
              <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                To pay
              </span>
              <span className="text-fs-32 font-extrabold tabular-nums text-slate-900">
                {lkrFromPaisa(duePaisa)}
              </span>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              aria-label="Close"
              className={cn(
                'flex size-touch-standard items-center justify-center rounded-control border border-slate-200 bg-white',
                'text-slate-900 active:scale-[0.97] disabled:opacity-40',
                focusRing,
              )}
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row">
          {/* ── Left: method and the sum ─────────────────────────────────── */}
          <section className="flex shrink-0 flex-col gap-sp-4 border-slate-200 bg-slate-50 p-sp-5 md:w-80 md:border-r">
            <div className="flex flex-col gap-sp-2">
              <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                Method
              </span>
              <div role="group" aria-label="How the guest is paying" className="grid grid-cols-2 gap-sp-2">
                {([
                  { key: 'cash' as const, label: 'Cash', icon: Banknote },
                  { key: 'card' as const, label: 'Card', icon: CreditCard },
                  { key: 'split' as const, label: 'Cash + card', icon: Split },
                ]).map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={method === key}
                    onClick={() => {
                      setMethod(key)
                      setError(null)
                    }}
                    className={cn(
                      'flex h-touch-kitchen items-center justify-center gap-sp-2 rounded-waiter border-2 text-fs-16 font-bold',
                      // The third choice spans the row rather than sitting as
                      // half a row waiting for a partner.
                      key === 'split' && 'col-span-2',
                      'active:scale-[0.97]',
                      focusRing,
                      method === key
                        ? 'border-brand-500 bg-brand-050 text-brand-700'
                        : 'border-slate-200 bg-white text-slate-700',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <dl className="mt-auto flex flex-col gap-sp-2 border-t border-slate-200 pt-sp-4 text-fs-14 md:mt-0">
              <div className="flex justify-between">
                <dt className="text-slate-600">Bill</dt>
                <dd className="font-semibold tabular-nums text-slate-900">{lkrFromPaisa(duePaisa)}</dd>
              </div>
              {method === 'split' && hasCash && cash < duePaisa ? (
                <>
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Cash</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">{lkrFromPaisa(cash)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Card</dt>
                    <dd className="font-semibold tabular-nums text-slate-900">
                      {lkrFromPaisa(stillNeeded)}
                    </dd>
                  </div>
                </>
              ) : null}
              <div className="flex justify-between pt-sp-1">
                <dt className="font-bold text-slate-900">Total</dt>
                <dd className="font-extrabold tabular-nums text-slate-900">{lkrFromPaisa(duePaisa)}</dd>
              </div>
            </dl>
          </section>

          {/* ── Right: the pad ────────────────────────────────────────────── */}
          <section className="flex min-w-0 flex-1 flex-col gap-sp-3 p-sp-5">
            {method !== 'card' ? (
              <>
                <div className="grid grid-cols-2 gap-sp-3">
                  <div
                    aria-live="polite"
                    className="flex flex-col rounded-waiter border-2 border-brand-500 bg-white px-sp-4 py-sp-3"
                  >
                    <span className="flex items-center justify-between gap-sp-2">
                      <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                        {method === 'split' ? 'Cash part' : 'Received'}
                      </span>
                      {/* Clear (Teran, 2026-10-25): back to empty in one tap,
                          rather than a delete per digit. Only while there is
                          something to clear. */}
                      {received !== null ? (
                        <button
                          type="button"
                          onClick={() => {
                            setDigits('')
                            setExact(null)
                            setError(null)
                          }}
                          className={cn(
                            // The standard 44px touch floor, even tucked in
                            // a corner: a missed Clear is a wrong amount.
                            'h-touch-standard rounded-control border border-slate-200 bg-white px-sp-4',
                            'text-fs-12 font-bold text-slate-700 active:scale-[0.97]',
                            focusRing,
                          )}
                        >
                          Clear
                        </button>
                      ) : null}
                    </span>
                    <span className="text-fs-32 font-extrabold tabular-nums text-slate-900">
                      {received === null ? 'LKR —' : lkrFromPaisa(received)}
                    </span>
                  </div>
                  <div className="flex flex-col rounded-waiter bg-slate-100 px-sp-4 py-sp-3">
                    <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                      {method === 'split' ? 'Card part' : change > 0 ? 'Change' : 'Still needed'}
                    </span>
                    <span
                      className={cn(
                        'text-fs-32 font-extrabold tabular-nums',
                        method === 'cash' && change > 0 ? 'text-open-ink' : 'text-slate-600',
                      )}
                    >
                      {lkrFromPaisa(method === 'cash' && change > 0 ? change : stillNeeded)}
                    </span>
                  </div>
                </div>

                <div className={cn('flex flex-wrap gap-sp-2', method === 'split' && 'hidden')}>
                  {[
                    { label: 'Exact', set: () => (setDigits(''), setExact(duePaisa)) },
                    ...quick.map((amount) => ({
                      label: lkrFromPaisa(amount).replace('LKR ', ''),
                      set: () => (setExact(null), setDigits(String(amount / 100))),
                    })),
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      onClick={() => {
                        setError(null)
                        option.set()
                      }}
                      className={cn(
                        'h-touch-standard min-w-24 rounded-control border border-brand-300 bg-brand-050 px-sp-4',
                        'text-fs-14 font-bold text-brand-700 active:scale-[0.97]',
                        focusRing,
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <div className="grid flex-1 grid-cols-3 gap-sp-2">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'].map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => press(key)}
                      aria-label={key === 'back' ? 'Delete last digit' : key}
                      className={cn(
                        'flex h-touch-kitchen items-center justify-center rounded-waiter border border-slate-200 bg-white',
                        'text-fs-24 font-bold text-slate-900 active:scale-[0.97] active:bg-slate-100',
                        focusRing,
                      )}
                    >
                      {key === 'back' ? <Delete aria-hidden="true" className="size-6" /> : key}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-sp-3 rounded-waiter bg-slate-100 p-sp-5 text-center">
                <CreditCard aria-hidden="true" className="size-10 text-brand-700" />
                <p className="text-fs-18 font-semibold text-slate-900">
                  Charge <strong className="tabular-nums">{lkrFromPaisa(duePaisa)}</strong> on the
                  card machine.
                </p>
                <p className="text-fs-14 text-slate-600">Confirm here once it is approved.</p>
              </div>
            )}

            {error ? (
              <p role="alert" className="text-fs-14 font-semibold text-unavailable-ink">
                {error}
              </p>
            ) : null}

            <button
              type="button"
              disabled={busy || (tenders === null && !cashShort)}
              onClick={async () => {
                // Short cash in Cash mode: switch to Cash + card with the
                // amount kept, so the split is confirmed there on purpose.
                if (cashShort) {
                  setMethod('split')
                  return
                }
                if (!tenders) return
                setBusy(true)
                setError(null)
                try {
                  await onPay(tenders, method === 'cash' ? cash : undefined)
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : 'Could not record the payment.')
                  setBusy(false)
                }
              }}
              className={cn(
                'h-touch-waiter shrink-0 rounded-waiter text-fs-18 font-bold',
                'active:scale-[0.98] disabled:active:scale-100',
                focusRing,
                busy || (tenders === null && !cashShort)
                  ? 'bg-slate-100 text-slate-400'
                  : cashShort
                    ? 'border-2 border-brand-500 bg-brand-050 text-brand-700'
                    : 'bg-brand-800 text-white shadow-el-2',
              )}
            >
              {actionLabel}
            </button>
          </section>
        </div>
      </div>
    </div>
  )
}
