'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Banknote,
  CreditCard,
  Plus,
  Receipt,
  Split,
  Users,
  X,
} from 'lucide-react'
import { lkrFromPaisa } from '@/lib/format'
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
  | { kind: 'draft'; key: 'draft'; title: string; draft: BillScreenDraft }
  | { kind: 'person'; key: string; title: string; lines: BillScreenLine[]; totals: Totals }

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
  if (response.status === 401) {
    window.location.assign('/login')
    throw new RefusedError('UNAUTHENTICATED', 'Sign in again.')
  }
  const payload = await response.json().catch(() => null)
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

/** A card on the split: one owner's units of one line. Keyed `${eventId}|${owner}`. */
function cardKey(eventId: string, owner: string | null): string {
  return `${eventId}|${owner ?? ''}`
}
function eventOfCard(key: string): string {
  return key.slice(0, key.indexOf('|'))
}

let personCounter = 0
function newPersonId(): string {
  personCounter += 1
  return `p${Date.now().toString(36)}${personCounter}`
}

function nextPersonLabel(persons: Person[]): string {
  const used = persons
    .map((person) => /^Person (\d+)$/.exec(person.label)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
  return `Person ${Math.max(persons.length, ...used, 0) + 1}`
}

/**
 * Where a Separate-bills order starts: one person per seat that has unbilled
 * items, named as the waiter named the seat, with those items already on them.
 * The waiter tagged who had what while ordering; this is where it pays off.
 */
function splitFromSeats(
  draft: BillScreenDraft | null,
  seats: { id: string; name: string }[],
): SplitState {
  const lines = draft?.lines ?? []
  const used = seats.filter((seat) => lines.some((line) => line.seatSlotId === seat.id))
  const persons = used.map((seat) => ({ id: newPersonId(), label: seat.name }))
  const allocation: Record<string, Piece[]> = {}
  for (const line of lines) {
    const index = used.findIndex((seat) => seat.id === line.seatSlotId)
    if (index >= 0) allocation[line.orderEventId] = [{ owner: persons[index]!.id, qty: line.quantity }]
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
 * Whole items only (6.1): a line of two Lion Lagers goes to one person. Splitting
 * a single line between people would need a quantity split on an append-only
 * event, which is not in scope.
 *
 * ── The split survives a reload, on this tablet ──────────────────────────────
 * Kept in localStorage per session, so a waiter who steps back to the order and
 * returns finds it as they left it. It is NOT shared across tablets; the bills
 * that come out of it are.
 */
export function BillScreen({
  sessionId,
  tableLabel,
  billMode,
  bills,
  draft,
  seats,
}: {
  sessionId: string
  tableLabel: string
  billMode: 'one' | 'separate'
  bills: BillScreenBill[]
  draft: BillScreenDraft | null
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
      ? splitFromSeats(draft, seats)
      : { view: 'whole', persons: [], allocation: {} },
  )
  const [restored, setRestored] = useState(false)
  /** The card picked up by a tap, and how many of its units "Move here" moves. */
  const [selected, setSelected] = useState<{ key: string; count: number } | null>(null)
  const [paying, setPaying] = useState<Payable | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as SplitState | null
      if (saved && (saved.view === 'split' || saved.view === 'whole') && saved.allocation) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring browser-only state after hydration is exactly this
        setSplit(saved)
      }
    } catch {
      // A private window or blocked storage: start fresh.
    }
    setRestored(true)
  }, [storageKey])

  useEffect(() => {
    // Not before the restore, or the default would overwrite what was saved.
    if (!restored) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(split))
    } catch {
      // Storage is a convenience here, never a requirement.
    }
  }, [restored, split, storageKey])

  // Only allocations that still make sense: the line is still unbilled, its
  // pieces add up to what is left of it, and every owner still exists. A bill
  // settled on another tablet changes what is left, and that line falls back
  // to unassigned rather than showing units nobody can bill.
  const personIds = new Set(split.persons.map((person) => person.id))
  const piecesOf = (line: BillScreenLine): Piece[] => {
    const saved = split.allocation[line.orderEventId]
    if (!saved || saved.reduce((total, piece) => total + piece.qty, 0) !== line.quantity) {
      return [{ owner: null, qty: line.quantity }]
    }
    return normalize(
      saved.map((piece) => ({
        owner: piece.owner && personIds.has(piece.owner) ? piece.owner : null,
        qty: piece.qty,
      })),
    )
  }

  /** One owner's cards: their units of each line, priced per unit. */
  const cardsFor = (owner: string | null): BillScreenLine[] =>
    draftLines.flatMap((line) =>
      piecesOf(line)
        .filter((piece) => piece.owner === owner)
        .map((piece) => ({
          ...line,
          orderEventId: cardKey(line.orderEventId, owner),
          quantity: piece.qty,
          amountPaisa: piece.qty * line.unitPricePaisa,
        })),
    )
  const unassigned = cardsFor(null)
  const ownerOfCard = (key: string): string | null => key.slice(key.indexOf('|') + 1) || null

  /**
   * Moves `count` units of a card to `target` — all of them when no count is
   * given, which is what a drag does.
   */
  function move(key: string, target: string | null | 'new', count?: number) {
    setSelected(null)
    const eventId = eventOfCard(key)
    const from = ownerOfCard(key)
    const line = draftLines.find((candidate) => candidate.orderEventId === eventId)
    if (!line) return
    setSplit((current) => {
      let persons = current.persons
      let to: string | null = target === 'new' ? null : target
      if (target === 'new') {
        const person = { id: newPersonId(), label: nextPersonLabel(current.persons) }
        persons = [...current.persons, person]
        to = person.id
      }
      const pieces = piecesOf(line).map((piece) => ({ ...piece }))
      const source = pieces.find((piece) => piece.owner === from)
      if (!source) return current
      const moving = Math.min(count ?? source.qty, source.qty)
      source.qty -= moving
      pieces.push({ owner: to, qty: moving })
      return {
        ...current,
        persons,
        allocation: { ...current.allocation, [eventId]: normalize(pieces) },
      }
    })
  }

  function pick(key: string, qty: number) {
    setSelected((current) => (current?.key === key ? null : { key, count: qty }))
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
    setSplit(
      billMode === 'separate' && draftLines.some((line) => line.seatSlotId)
        ? splitFromSeats(draft, seats)
        : {
            view: 'split',
            // Two people to start (6.3): the commonest split, and an empty
            // second column shows where items go.
            persons: [
              { id: newPersonId(), label: 'Person 1' },
              { id: newPersonId(), label: 'Person 2' },
            ],
            allocation: {},
          },
    )
  }

  function merge() {
    setSelected(null)
    setSplit({ view: 'whole', persons: [], allocation: {} })
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
  const allLines = [...bills.flatMap((bill) => bill.lines), ...draftLines]
  const inSplit = split.view === 'split' && draft !== null

  return (
    <div className="h-app flex flex-col bg-slate-100">
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
              outstanding > 0 ? 'bg-occupied-chip text-occupied-ink' : 'bg-open-chip text-open-ink',
            )}
          >
            <span aria-hidden="true" className="size-2 rounded-pill bg-current" />
            {outstanding > 0 ? `Unpaid ${lkrFromPaisa(outstanding)}` : 'Paid'}
          </span>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <main className="flex min-h-0 flex-1 flex-col gap-sp-4 overflow-y-auto p-sp-4">
        {notice ? (
          <p
            role="status"
            className="rounded-control bg-occupied-chip px-sp-4 py-sp-3 text-fs-14 font-semibold text-occupied-ink"
          >
            {notice}
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
                  onSettle={() => setPaying({ kind: 'bill', key: bill.billId, title: bill.label, bill })}
                  due={bill.totalPaisa - bill.paidPaisa}
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
                onDropItem={(key) => move(key, null)}
              >
                <ItemList
                  lines={unassigned}
                  selected={selected}
                  onSelect={pick}
                  onCount={(count) => setSelected((current) => (current ? { ...current, count } : null))}
                />
                <p className="shrink-0 border-t border-occupied-edge px-sp-3 py-sp-2 text-fs-12 font-semibold text-occupied-ink">
                  Give every item to a person before settling the table.
                </p>
              </Column>
            ) : null}

            {split.persons.map((person) => {
              const lines = cardsFor(person.id)
              const totals = priceShare(lines, draft)
              return (
                <Column
                  key={person.id}
                  title={person.label}
                  total={totals.totalPaisa}
                  onRemove={() => removePerson(person.id)}
                  moveHere={
                    selected && ownerOfCard(selected.key) !== person.id
                      ? () => move(selected.key, person.id, selected.count)
                      : undefined
                  }
                  onDropItem={(key) => move(key, person.id)}
                >
                  {lines.length === 0 ? (
                    <div className="m-sp-3 flex flex-1 items-center justify-center rounded-card border-2 border-dashed border-slate-200 text-fs-14 font-semibold text-slate-400">
                      Drag items here
                    </div>
                  ) : (
                    <ItemList
                      lines={lines}
                      selected={selected}
                      onSelect={pick}
                      onCount={(count) =>
                        setSelected((current) => (current ? { ...current, count } : null))
                      }
                    />
                  )}
                  {lines.length > 0 ? (
                    <ColumnFooter
                      totals={totals}
                      due={totals.totalPaisa}
                      onSettle={() =>
                        setPaying({ kind: 'person', key: person.id, title: person.label, lines, totals })
                      }
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
                persons: [...current.persons, { id: newPersonId(), label: nextPersonLabel(current.persons) }],
              })))}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const key = event.dataTransfer.getData('text/plain')
                if (key) move(key, 'new')
              }}
              className={cn(
                'flex w-60 shrink-0 flex-col items-center justify-center gap-sp-2 rounded-panel',
                'border-2 border-dashed border-slate-300 bg-transparent p-sp-4 text-center',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                selected && 'border-brand-500 bg-brand-050',
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
                onSettle={() => setPaying(wholePayables[0]!)}
              />
              {wholePayables[0]!.kind === 'draft' && draftLines.length >= 2 ? (
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
                  onSettle={() => setPaying(payable)}
                />
                {payable.kind === 'draft' && draftLines.length >= 2 ? (
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
              {paidBills.map((bill) => (
                <li
                  key={bill.billId}
                  className="rounded-control bg-open-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-open-ink"
                >
                  {bill.label} · {lkrFromPaisa(bill.totalPaisa)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>

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
      />

      {paying ? (
        <PaymentDialog
          title={paying.title}
          duePaisa={outstandingOf(paying)}
          onCancel={() => setPaying(null)}
          onPay={async (tenders) => {
            // A draft or a person's share becomes a bill only now, at Settle.
            // If the total the server writes differs from the one shown — a
            // round landed, or another tablet billed one of these items — stop
            // rather than charge the guest a figure they were not quoted.
            let billId: string
            if (paying.kind === 'bill') {
              billId = paying.bill.billId
            } else {
              const expected = outstandingOf(paying)
              const bill = await postJson<{ billId: string; totalPaisa: number }>(
                `/api/sessions/${sessionId}/bills`,
                paying.kind === 'draft'
                  ? { type: 'consolidated' }
                  : {
                      type: 'split',
                      personLabel: paying.title,
                      // Card keys carry the event id; the quantity is this
                      // person's units of it.
                      items: paying.lines.map((line) => ({
                        eventId: eventOfCard(line.orderEventId),
                        quantity: line.quantity,
                      })),
                    },
              )
              if (bill.totalPaisa !== expected) {
                setPaying(null)
                setNotice(
                  `${paying.title}'s bill came to ${lkrFromPaisa(bill.totalPaisa)}, not ${lkrFromPaisa(
                    expected,
                  )}. It has been recorded — check it below and settle it.`,
                )
                router.refresh()
                return
              }
              billId = bill.billId
            }

            const result = await postJson<{ sessionClosed: boolean }>(
              `/api/bills/${billId}/payments`,
              { tenders },
            )
            setPaying(null)
            if (result.sessionClosed) {
              try {
                window.localStorage.removeItem(storageKey)
              } catch {
                // Nothing to clean up, then.
              }
              router.push('/')
              return
            }
            // That person is paid: their column goes, and their items are on a
            // bill now, so the draft the server sends back no longer has them.
            if (paying.kind === 'person') removePerson(paying.key)
            setNotice(null)
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
  onDropItem,
  children,
}: {
  title: string
  total: number
  badge?: string
  tone?: 'person' | 'pending'
  onRemove?: () => void
  /** Present while an item from ANOTHER column is picked up. */
  moveHere?: () => void
  onDropItem?: (eventId: string) => void
  children: React.ReactNode
}) {
  const [over, setOver] = useState(false)
  return (
    <section
      onDragOver={
        onDropItem
          ? (event) => {
              event.preventDefault()
              setOver(true)
            }
          : undefined
      }
      onDragLeave={() => setOver(false)}
      onDrop={
        onDropItem
          ? (event) => {
              event.preventDefault()
              setOver(false)
              const eventId = event.dataTransfer.getData('text/plain')
              if (eventId) onDropItem(eventId)
            }
          : undefined
      }
      className={cn(
        'flex w-72 shrink-0 flex-col overflow-hidden rounded-panel',
        tone === 'pending'
          ? 'border-2 border-dashed border-occupied-edge bg-occupied-body'
          : 'border border-slate-200 bg-white shadow-el-1',
        over && 'ring-2 ring-brand-500',
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
}: {
  lines: BillScreenLine[]
  selected?: { key: string; count: number } | null
  onSelect?: (key: string, qty: number) => void
  /** Sets how many of the picked card's units "Move here" will move. */
  onCount?: (count: number) => void
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
            <span className="flex items-center gap-sp-2">
              <StationChip destination={line.destination} />
              {line.modifierText ? (
                <span className="truncate text-fs-12 text-slate-600">{line.modifierText}</span>
              ) : null}
            </span>
          </>
        )
        return (
          <li key={line.orderEventId}>
            {onSelect ? (
              <button
                type="button"
                draggable
                aria-pressed={isSelected}
                onDragStart={(event) => event.dataTransfer.setData('text/plain', line.orderEventId)}
                onClick={() => onSelect(line.orderEventId, line.quantity)}
                className={cn(
                  'flex w-full cursor-grab flex-col items-start gap-sp-1 rounded-card border bg-white p-sp-3 text-left',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                  isSelected ? 'border-brand-500 ring-2 ring-brand-500' : 'border-slate-200',
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

function ColumnFooter({
  totals,
  due,
  onSettle,
}: {
  totals: Totals
  due: number
  onSettle: () => void
}) {
  return (
    <div className="flex shrink-0 flex-col gap-sp-2 border-t border-slate-200 bg-slate-50 p-sp-3">
      {totals.serviceChargeBp > 0 ? (
        <div className="flex justify-between text-fs-12 text-slate-600">
          <span>{lkrFromPaisa(totals.subtotalPaisa)} + service</span>
          <span className="tabular-nums">{lkrFromPaisa(totals.serviceChargePaisa)}</span>
        </div>
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
        Settle {lkrFromPaisa(due)}
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

function LinesCard({ title, lines }: { title: string; lines: BillScreenLine[] }) {
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
              {line.modifierText ? (
                <span className="block truncate text-fs-14 text-slate-600">{line.modifierText}</span>
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

function percentLabel(bp: number): string {
  return (bp / 100).toFixed(bp % 100 === 0 ? 0 : 1).replace(/\.0$/, '')
}

function TotalsCard({
  totals,
  paidPaisa,
  onSettle,
}: {
  totals: Totals
  paidPaisa: number
  onSettle: () => void
}) {
  const due = totals.totalPaisa - paidPaisa
  return (
    <section className="flex shrink-0 flex-col gap-sp-2 rounded-panel bg-white p-sp-4 shadow-el-1">
      <Row label="Subtotal" value={totals.subtotalPaisa} />
      {totals.serviceChargeBp > 0 ? (
        <Row label={`Service ${percentLabel(totals.serviceChargeBp)}%`} value={totals.serviceChargePaisa} />
      ) : null}
      {totals.taxBp > 0 ? (
        <Row label={`Tax ${percentLabel(totals.taxBp)}%`} value={totals.taxPaisa} />
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
      <button
        type="button"
        onClick={onSettle}
        className={cn(
          'mt-sp-2 h-touch-waiter rounded-waiter bg-brand-800 text-fs-18 font-bold text-white shadow-el-2',
          'transition-transform duration-80 ease-standard active:scale-[0.98]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        )}
      >
        Settle {lkrFromPaisa(due)}
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

/** "1,500.50" -> 150050. Blank or unparseable -> null. */
function paisaFromInput(text: string): number | null {
  const cleaned = text.replace(/[,\s]/g, '')
  if (cleaned === '') return null
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

/**
 * Taking the money: cash, card, or part of each.
 *
 * ── Cash records what was APPLIED ────────────────────────────────────────────
 * The waiter types what the guest handed over and the dialog shows the change.
 * What is recorded is the bill's amount, not the note — change never belonged
 * to the restaurant (see `payment_records`).
 *
 * ── Split ────────────────────────────────────────────────────────────────────
 * The waiter types the cash part; the card part is the rest. Both must be more
 * than zero, or it is not a split.
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
  onPay: (tenders: { method: 'cash' | 'card'; amountPaisa: number }[]) => Promise<void>
}) {
  const [method, setMethod] = useState<'cash' | 'card' | 'split'>('cash')
  const [cashText, setCashText] = useState('')
  const [splitCashText, setSplitCashText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const received = paisaFromInput(cashText)
  const change = received !== null ? received - duePaisa : null
  const splitCash = paisaFromInput(splitCashText)
  const splitCard = splitCash !== null ? duePaisa - splitCash : null

  // Quick notes: exact, then the next round 500 / 1,000 / 5,000 above the due.
  const quick = Array.from(
    new Set(
      [duePaisa, ...[50_000, 100_000, 500_000].map((step) => Math.ceil(duePaisa / step) * step)].filter(
        (amount) => amount >= duePaisa,
      ),
    ),
  ).slice(0, 4)

  const tenders: { method: 'cash' | 'card'; amountPaisa: number }[] | null =
    method === 'card'
      ? [{ method: 'card', amountPaisa: duePaisa }]
      : method === 'cash'
        ? received !== null && received >= duePaisa
          ? [{ method: 'cash', amountPaisa: duePaisa }]
          : null
        : splitCash !== null && splitCash > 0 && splitCard !== null && splitCard > 0
          ? [
              { method: 'cash', amountPaisa: splitCash },
              { method: 'card', amountPaisa: splitCard },
            ]
          : null

  const methods = [
    { key: 'cash' as const, label: 'Cash', icon: Banknote },
    { key: 'card' as const, label: 'Card', icon: CreditCard },
    { key: 'split' as const, label: 'Split', icon: Split },
  ]

  const inputClass = cn(
    'h-touch-waiter w-full rounded-control border border-slate-200 bg-white px-sp-4',
    'text-fs-24 font-bold tabular-nums text-slate-900',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
  )

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="payment-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-sp-4"
    >
      <div className="flex max-h-full w-full max-w-md flex-col gap-sp-4 overflow-y-auto rounded-panel bg-white p-sp-5 shadow-el-2">
        <div className="flex flex-col gap-0.5">
          <h2 id="payment-title" className="text-fs-24 font-extrabold text-slate-900">
            Settle {lkrFromPaisa(duePaisa)}
          </h2>
          <p className="text-fs-14 text-slate-600">{title}</p>
        </div>

        <div role="group" aria-label="How the guest is paying" className="flex gap-1 rounded-control bg-slate-100 p-1">
          {methods.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              aria-pressed={method === key}
              onClick={() => {
                setMethod(key)
                setError(null)
              }}
              className={cn(
                'flex h-12 flex-1 items-center justify-center gap-sp-2 rounded-control text-fs-16 font-bold',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
                method === key ? 'bg-white text-brand-700 shadow-el-1' : 'text-slate-600',
              )}
            >
              <Icon aria-hidden="true" className="size-5" />
              {label}
            </button>
          ))}
        </div>

        {method === 'cash' ? (
          <div className="flex flex-col gap-sp-3">
            <label className="flex flex-col gap-sp-1">
              <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                Cash received (LKR)
              </span>
              <input
                inputMode="decimal"
                autoFocus
                value={cashText}
                onChange={(event) => setCashText(event.target.value)}
                className={inputClass}
              />
            </label>
            <div className="flex flex-wrap gap-sp-2">
              {quick.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setCashText(String(amount / 100))}
                  className="h-touch-standard rounded-control border border-slate-200 bg-white px-sp-3 text-fs-14 font-bold text-slate-700 active:scale-[0.97]"
                >
                  {amount === duePaisa ? 'Exact' : lkrFromPaisa(amount)}
                </button>
              ))}
            </div>
            <div className="flex items-baseline justify-between rounded-control bg-slate-100 px-sp-4 py-sp-3">
              <span className="text-fs-16 font-semibold text-slate-600">Change</span>
              <span className="text-fs-24 font-extrabold tabular-nums text-slate-900">
                {change !== null && change >= 0 ? lkrFromPaisa(change) : '—'}
              </span>
            </div>
            {change !== null && change < 0 ? (
              <p className="text-fs-14 font-semibold text-unavailable-ink">
                {lkrFromPaisa(-change)} short. Take the rest by card with Split.
              </p>
            ) : null}
          </div>
        ) : method === 'card' ? (
          <p className="rounded-control bg-slate-100 px-sp-4 py-sp-3 text-fs-16 text-slate-700">
            Charge <strong className="tabular-nums">{lkrFromPaisa(duePaisa)}</strong> on the card
            machine, then confirm here.
          </p>
        ) : (
          <div className="flex flex-col gap-sp-3">
            <label className="flex flex-col gap-sp-1">
              <span className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">
                Cash part (LKR)
              </span>
              <input
                inputMode="decimal"
                autoFocus
                value={splitCashText}
                onChange={(event) => setSplitCashText(event.target.value)}
                className={inputClass}
              />
            </label>
            <div className="flex items-baseline justify-between rounded-control bg-slate-100 px-sp-4 py-sp-3">
              <span className="text-fs-16 font-semibold text-slate-600">Card part</span>
              <span className="text-fs-24 font-extrabold tabular-nums text-slate-900">
                {splitCard !== null && splitCard > 0 ? lkrFromPaisa(splitCard) : '—'}
              </span>
            </div>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-fs-14 font-semibold text-unavailable-ink">
            {error}
          </p>
        ) : null}

        <div className="flex gap-sp-3">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter border border-slate-200 bg-white',
              'text-fs-18 font-bold text-slate-900 shadow-el-1 active:scale-[0.97] disabled:opacity-40',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            Back
          </button>
          <button
            type="button"
            disabled={busy || tenders === null}
            onClick={async () => {
              if (!tenders) return
              setBusy(true)
              setError(null)
              try {
                await onPay(tenders)
              } catch (caught) {
                setError(caught instanceof Error ? caught.message : 'Could not record the payment.')
                setBusy(false)
              }
            }}
            className={cn(
              'h-touch-waiter flex-1 rounded-waiter bg-brand-800 text-fs-18 font-bold text-white shadow-el-2',
              'active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
            )}
          >
            {busy ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </div>
    </div>
  )
}
