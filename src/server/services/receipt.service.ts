import 'server-only'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import {
  orderSessionTables,
  orderSessions,
  paymentRecords,
  printJobs,
  tables,
  tenantConfig,
  tenants,
} from '@/server/db/schema'
import { getBill, NothingToBillError, priceBillable } from '@/server/services/bill.service'
import { lockOpenSession } from '@/server/services/table-session.service'
import { buildReceiptPayload, receiptTextLines } from '@/server/print/ticket'
import type { ReceiptLine, ReceiptPayload } from '@/types/tickets'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The recorded bill does not exist. */
export class ReceiptBillNotFoundError extends Error {}

/**
 * Printing the guest's bill (Story 6.6, FR69).
 *
 * ── Nothing is written but the job ───────────────────────────────────────────
 * Printing a draft writes NO `bills` row. Story 6.5's rule holds: reading what
 * a table owes changes nothing, so a waiter can print the bill, take it to the
 * guest, and still add a dessert. The bill is recorded at Settle, as before.
 *
 * ── The server prices it ─────────────────────────────────────────────────────
 * A draft or a person's share goes through `priceBillable` — the code Settle
 * writes with — and a recorded bill is read back from `bills`/`bill_lines`.
 * Nothing the client sends is printed as money.
 *
 * ── Under the session lock ───────────────────────────────────────────────────
 * Both entry points take `lockOpenSession`, the lock Settle and payment take:
 * a closed order refuses (SessionAlreadyClosedError), and "is this a COPY?"
 * cannot race a second tap on another tablet.
 */

/**
 * Who a part-of-the-table bill is for, as it may appear on GUEST paper.
 *
 * A split column, and `bills.person_label`, can hold the seat NOTE —
 * `bill/page.tsx` names people `seatNote ?? seatLabel`, so "red shirt" is a
 * real value. Teran's rule (2026-09-12): a seat note never reaches a guest's
 * bill. Only the neutral forms pass; anything else prints "Split bill".
 */
export function guestBillLabel(label: string | null | undefined): string {
  const trimmed = (label ?? '').trim()
  return /^(Person|Seat) \d+$/.test(trimmed) ? trimmed : 'Split bill'
}

/** Everything about the order and the restaurant the paper needs. */
async function readHeading(tx: Tx, sessionId: string) {
  const [session] = await tx
    .select({
      tenantId: orderSessions.tenantId,
      kind: orderSessions.kind,
      dailyNumber: orderSessions.dailyNumber,
      businessDate: orderSessions.businessDate,
      timeZone: tenants.timezone,
      restaurantName: tenantConfig.restaurantName,
      receiptHeader: tenantConfig.receiptHeader,
      receiptFooter: tenantConfig.receiptFooter,
      // The database clock, not Node's: the time printed is when Print was
      // tapped, as PostgreSQL saw it — the clock every other record uses.
      now: sql<string>`now()`,
    })
    .from(orderSessions)
    .innerJoin(tenants, eq(tenants.id, orderSessions.tenantId))
    .leftJoin(tenantConfig, eq(tenantConfig.tenantId, orderSessions.tenantId))
    .where(eq(orderSessions.id, sessionId))
    .limit(1)

  const attached = await tx
    .select({ label: tables.label })
    .from(orderSessionTables)
    .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
    .where(and(eq(orderSessionTables.sessionId, sessionId), isNull(orderSessionTables.releasedAt)))
  const labels = attached
    .map((row) => row.label)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  // A bar tab prints as "Bar tab", NEVER by `tabName`: that adds the staff's
  // nickname for the guest ("white shirt"), which must not reach their paper.
  const tableLabels =
    labels.length > 0 ? labels : [session!.kind === 'counter' ? 'Bar tab' : 'COUNTER']

  return {
    tenantId: session!.tenantId,
    restaurantName: session!.restaurantName ?? 'Bill',
    headerLines: receiptTextLines(session!.receiptHeader ?? null),
    footerLines: receiptTextLines(session!.receiptFooter ?? null),
    tableLabels,
    printedAt: new Date(session!.now).toISOString(),
    timeZone: session!.timeZone,
    dailyNumber: session!.dailyNumber,
    businessDate: session!.businessDate,
  }
}

async function enqueue(
  tx: Tx,
  { tenantId, sessionId, billId, payload }: { tenantId: string; sessionId: string; billId: string | null; payload: ReceiptPayload },
): Promise<{ jobId: string }> {
  const [job] = await tx
    .insert(printJobs)
    .values({ tenantId, sessionId, roundId: null, destination: 'cashier', billId, ticket: payload })
    .returning({ id: printJobs.id })
  return { jobId: job!.id }
}

/**
 * Prints a RECORDED bill — a seat billed early, a bill written at Settle, a
 * paid one. `RECEIPT` once fully paid, with its tenders; `COPY` when a job for
 * this bill has already been queued and has not died (a dead job never reached
 * paper, so the next one is still the first the guest sees).
 */
export async function printBill(tx: Tx, { billId }: { billId: string }): Promise<{ jobId: string }> {
  const bill = await getBill(tx, billId)
  if (!bill) throw new ReceiptBillNotFoundError()
  await lockOpenSession(tx, bill.sessionId)

  const heading = await readHeading(tx, bill.sessionId)

  const tenderRows = await tx
    .select({
      method: paymentRecords.method,
      amountPaisa: paymentRecords.amountPaisa,
      cashReceivedPaisa: paymentRecords.cashReceivedPaisa,
    })
    .from(paymentRecords)
    .where(eq(paymentRecords.billId, billId))
    .orderBy(asc(paymentRecords.createdAt), asc(paymentRecords.id))
  const paid = tenderRows.reduce((total, row) => total + row.amountPaisa, 0)
  const title = paid >= bill.totalPaisa ? 'RECEIPT' : 'BILL'

  // A COPY is the SAME document printed again. The bill the guest checked
  // before paying is not a copy of the receipt that prints after it (Teran,
  // 2026-11-10: the receipt prints by itself at payment), so only earlier jobs
  // with this title count.
  const [{ printed }] = await tx
    .select({ printed: sql<number>`count(*)::int` })
    .from(printJobs)
    .where(
      and(
        eq(printJobs.billId, billId),
        ne(printJobs.status, 'dead'),
        sql`${printJobs.ticket}->>'title' = ${title}`,
      ),
    )

  const billLabel =
    bill.type === 'seat' ? bill.seatLabel : bill.type === 'split' ? guestBillLabel(bill.personLabel) : null

  const payload = buildReceiptPayload({
    ...heading,
    title,
    copy: printed > 0,
    billLabel,
    lines: bill.lines.map(
      (line): ReceiptLine => ({
        quantity: line.quantity,
        name: line.name,
        amountPaisa: line.amountPaisa,
        optionText: line.optionText,
        modifierText: line.modifierText,
      }),
    ),
    comps: bill.comps.map((comp) => ({ reason: comp.reason, amountPaisa: comp.amountPaisa })),
    subtotalPaisa: bill.subtotalPaisa,
    serviceChargePaisa: bill.serviceChargePaisa,
    serviceChargeBp: bill.serviceChargeBp,
    taxPaisa: bill.taxPaisa,
    taxBp: bill.taxBp,
    totalPaisa: bill.totalPaisa,
    tenders: tenderRows,
  })

  return enqueue(tx, { tenantId: heading.tenantId, sessionId: bill.sessionId, billId, payload })
}

/**
 * Prints what the table owes before any bill is recorded: the whole unbilled
 * table, or one person's share of a split (`items`). Priced by `priceBillable`
 * — the same figures Settle will write — and never stored as a bill.
 */
export async function printDraft(
  tx: Tx,
  {
    sessionId,
    items,
    personLabel,
  }: { sessionId: string; items?: { eventId: string; quantity: number }[]; personLabel?: string | null },
): Promise<{ jobId: string }> {
  await lockOpenSession(tx, sessionId)
  const priced = await priceBillable(tx, { sessionId, items })
  // An empty draft is not a bill. `priceBillable` returns zeroes for it rather
  // than refusing, because the bill screen shows an empty draft as "nothing to
  // pay"; paper with no lines is never what a waiter meant to print.
  if (priced.events.length === 0) throw new NothingToBillError()

  const heading = await readHeading(tx, sessionId)
  const payload = buildReceiptPayload({
    ...heading,
    title: 'BILL',
    copy: false,
    billLabel: items ? guestBillLabel(personLabel) : null,
    lines: priced.events.map(
      (event, index): ReceiptLine => ({
        quantity: priced.lineQuantities[index]!,
        name: event.customName ?? event.itemName ?? 'Unknown item',
        amountPaisa: priced.lineAmounts[index]!,
        optionText: event.optionText,
        modifierText: event.modifierText,
      }),
    ),
    comps: priced.comps.map((comp, index) => ({
      reason: comp.reason,
      amountPaisa: priced.compAmounts[index]!,
    })),
    subtotalPaisa: priced.totals.subtotalPaisa,
    serviceChargePaisa: priced.totals.serviceChargePaisa,
    serviceChargeBp: priced.totals.serviceChargeBp,
    taxPaisa: priced.totals.taxPaisa,
    taxBp: priced.totals.taxBp,
    totalPaisa: priced.totals.totalPaisa,
    tenders: [],
  })

  return enqueue(tx, { tenantId: priced.tenantId, sessionId, billId: null, payload })
}
