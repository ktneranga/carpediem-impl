'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Banknote, CreditCard, Receipt, Split, Users } from 'lucide-react'
import { lkrFromPaisa } from '@/lib/format'
import { routeForDestination } from '@/lib/design'
import { cn } from '@/lib/utils'
import { ActionStripShell } from '@/components/pos/action-strip-chrome'
import type { ProductionDestination } from '@/types/orders'

export type BillScreenLine = {
  orderEventId: string
  name: string
  quantity: number
  amountPaisa: number
  modifierText: string | null
  destination: ProductionDestination | null
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
  type: 'consolidated' | 'seat'
  seatLabel: string | null
  paidPaisa: number
  lines: BillScreenLine[]
}

/** What no bill covers yet, priced exactly as a bill would be. Nothing stored. */
export type BillScreenDraft = Totals & { lines: BillScreenLine[] }

/**
 * Something on this screen the waiter can settle: a recorded bill that is not
 * fully paid, or the draft for everything still unbilled.
 */
type Payable =
  | { kind: 'bill'; key: string; title: string; bill: BillScreenBill }
  | { kind: 'draft'; key: 'draft'; title: string; draft: BillScreenDraft }

function outstandingOf(payable: Payable): number {
  return payable.kind === 'bill'
    ? payable.bill.totalPaisa - payable.bill.paidPaisa
    : payable.draft.totalPaisa
}

function totalsOf(payable: Payable): Totals {
  return payable.kind === 'bill' ? payable.bill : payable.draft
}

function linesOf(payable: Payable): BillScreenLine[] {
  return payable.kind === 'bill' ? payable.bill.lines : payable.draft.lines
}

function itemCount(lines: BillScreenLine[]): number {
  return lines.reduce((total, line) => total + line.quantity, 0)
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
 * The bill screen (Story 6.5, design 27.png).
 *
 * One payable — the ordinary case — is drawn as the design draws it: the lines
 * on the left, totals and a single Settle on the right. Several (a seat billed
 * early alongside the rest of the table) are drawn as cards side by side, each
 * with its own Settle, the shape of the design's split screen.
 *
 * Not here yet, deliberately, rather than drawn and dead: Split bill (Stories
 * 6.1/6.3, next), Comp a line (Epic 7) and Print bill. "Close table" is not a
 * button because settling the last bill closes the table itself.
 */
export function BillScreen({
  sessionId,
  tableLabel,
  billMode,
  bills,
  draft,
}: {
  sessionId: string
  tableLabel: string
  billMode: 'one' | 'separate'
  bills: BillScreenBill[]
  draft: BillScreenDraft | null
}) {
  const router = useRouter()
  const [paying, setPaying] = useState<Payable | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const payables: Payable[] = [
    ...bills
      .filter((bill) => bill.paidPaisa < bill.totalPaisa)
      .map((bill) => ({
        kind: 'bill' as const,
        key: bill.billId,
        title: bill.seatLabel ?? 'Whole table',
        bill,
      })),
    ...(draft
      ? [
          {
            kind: 'draft' as const,
            key: 'draft' as const,
            // "Whole table" when nothing has been billed yet; once a seat has
            // its own bill, this is what is left for everyone else.
            title: bills.length === 0 ? 'Whole table' : 'Rest of the table',
            draft,
          },
        ]
      : []),
  ]
  const paidBills = bills.filter((bill) => bill.paidPaisa >= bill.totalPaisa)

  const billTotal =
    bills.reduce((total, bill) => total + bill.totalPaisa, 0) + (draft?.totalPaisa ?? 0)
  const settled = bills.reduce((total, bill) => total + Math.min(bill.paidPaisa, bill.totalPaisa), 0)
  const outstanding = billTotal - settled
  const allLines = [...bills.flatMap((bill) => bill.lines), ...(draft?.lines ?? [])]

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
              {billMode === 'one' ? 'paying together' : 'paying separately'}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-sp-1 rounded-pill bg-slate-100 px-sp-3 py-sp-1 text-fs-12 font-bold text-slate-700">
            {billMode === 'one' ? (
              <Receipt aria-hidden="true" className="size-4" />
            ) : (
              <Users aria-hidden="true" className="size-4" />
            )}
            {billMode === 'one' ? 'One bill' : 'Separate bills'}
          </span>
        </div>

        <span
          className={cn(
            'flex shrink-0 items-center gap-sp-2 rounded-pill px-sp-4 py-sp-2 text-fs-14 font-bold',
            outstanding > 0 ? 'bg-occupied-chip text-occupied-ink' : 'bg-open-chip text-open-ink',
          )}
        >
          <span aria-hidden="true" className="size-2 rounded-pill bg-current" />
          {outstanding > 0 ? `Unpaid ${lkrFromPaisa(outstanding)}` : 'Paid'}
        </span>
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

        {payables.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-panel border border-dashed border-slate-200 bg-white p-sp-5 text-center text-fs-16 text-slate-600">
            {allLines.length === 0
              ? 'Nothing has been sent to the kitchen yet, so there is nothing to bill.'
              : 'Everything on this table is paid.'}
          </div>
        ) : payables.length === 1 ? (
          // The design's one-bill layout: lines left, money right.
          // 2 : 1 — the items get two parts of the width and the money one
          // (Teran, 2026-10-25), so the list a guest checks is the big thing.
          <div className="flex min-h-0 flex-1 flex-col gap-sp-4 md:flex-row">
            <div className="flex min-h-0 flex-col md:min-w-0 md:flex-[2_2_0%]">
              <LinesCard title={payables[0]!.title} lines={linesOf(payables[0]!)} />
            </div>
            <div className="flex shrink-0 flex-col gap-sp-4 md:min-w-0 md:flex-[1_1_0%]">
              <TotalsCard
                totals={totalsOf(payables[0]!)}
                paidPaisa={payables[0]!.kind === 'bill' ? payables[0]!.bill.paidPaisa : 0}
                onSettle={() => setPaying(payables[0]!)}
              />
            </div>
          </div>
        ) : (
          // Several things to settle: one card each, side by side.
          <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-sp-4">
            {payables.map((payable) => (
              <div key={payable.key} className="flex min-h-0 flex-col gap-sp-3">
                <LinesCard title={payable.title} lines={linesOf(payable)} />
                <TotalsCard
                  totals={totalsOf(payable)}
                  paidPaisa={payable.kind === 'bill' ? payable.bill.paidPaisa : 0}
                  onSettle={() => setPaying(payable)}
                />
              </div>
            ))}
          </div>
        )}

        {paidBills.length > 0 ? (
          <section className="flex flex-col gap-sp-2">
            <h2 className="text-fs-12 font-bold tracking-micro text-slate-600 uppercase">Paid</h2>
            <ul className="flex flex-wrap gap-sp-2">
              {paidBills.map((bill) => (
                <li
                  key={bill.billId}
                  className="rounded-control bg-open-chip px-sp-3 py-sp-2 text-fs-14 font-semibold text-open-ink"
                >
                  {bill.seatLabel ?? 'Whole table'} · {lkrFromPaisa(bill.totalPaisa)}
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
            // A draft becomes a bill only now, at Settle. If the total the
            // server writes differs from the one shown — a round landed in
            // between — stop rather than charge the guest a figure they were
            // not quoted.
            let billId: string
            if (paying.kind === 'draft') {
              const bill = await postJson<{ billId: string; totalPaisa: number }>(
                `/api/sessions/${sessionId}/bills`,
                { type: 'consolidated' },
              )
              if (bill.totalPaisa !== paying.draft.totalPaisa) {
                setPaying(null)
                setNotice(
                  `The bill came to ${lkrFromPaisa(bill.totalPaisa)}, not ${lkrFromPaisa(
                    paying.draft.totalPaisa,
                  )} — something was added. Check it and settle again.`,
                )
                router.refresh()
                return
              }
              billId = bill.billId
            } else {
              billId = paying.bill.billId
            }

            const result = await postJson<{ sessionClosed: boolean }>(
              `/api/bills/${billId}/payments`,
              { tenders },
            )
            setPaying(null)
            if (result.sessionClosed) {
              // Settled and the table is free. The floor is where the waiter
              // goes next, and the card there is already back to open.
              router.push('/')
              return
            }
            setNotice(null)
            router.refresh()
          }}
        />
      ) : null}
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
