import 'server-only'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import {
  orderSessionTables,
  orderSessions,
  paymentRecords,
  printJobs,
  staff,
  tables,
  tenantConfig,
  tenants,
} from '@/server/db/schema'
import {
  getBill,
  loadSessionBills,
  MissingTenantConfigError,
  NothingToBillError,
  priceBillable,
} from '@/server/services/bill.service'
import { lockOpenSession } from '@/server/services/table-session.service'
import { loadSessionPayments } from '@/server/services/payment.service'
import { buildReceiptPayload, receiptTextLines } from '@/server/print/ticket'
import type { ReceiptLine, ReceiptPayload } from '@/types/tickets'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The recorded bill does not exist. */
export class ReceiptBillNotFoundError extends Error {}

/**
 * The table's total is not what the waiter's screen showed (Teran, 2026-11-11).
 * Settle refuses a changed total; so does Print, rather than hand the guest a
 * bill the waiter never saw.
 */
export class BillTotalChangedError extends Error {
  constructor(readonly currentTotalPaisa: number) {
    super('The bill changed')
  }
}

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
async function readHeading(tx: Tx, sessionId: string, staffId: string | null) {
  const [session] = await tx
    .select({
      tenantId: orderSessions.tenantId,
      kind: orderSessions.kind,
      dailyNumber: orderSessions.dailyNumber,
      businessDate: orderSessions.businessDate,
      primaryTableId: orderSessions.tableId,
      // Who looked after the table: the one picked, else who opened it.
      serverId: sql<string>`coalesce(${orderSessions.servedByStaffId}, ${orderSessions.openedByStaffId})`,
      timeZone: tenants.timezone,
      configTenantId: tenantConfig.tenantId,
      restaurantName: tenantConfig.restaurantName,
      receiptHeader: tenantConfig.receiptHeader,
      receiptFooter: tenantConfig.receiptFooter,
      receiptQrUrl: tenantConfig.receiptQrUrl,
      receiptQrCaption: tenantConfig.receiptQrCaption,
      receiptLogo: tenantConfig.receiptLogo,
      // The database clock, not Node's, and `clock_timestamp()` rather than
      // `now()`: `now()` is when the TRANSACTION began, which is before the
      // session lock wait and the payment writes it may follow.
      now: sql<string>`clock_timestamp()`,
    })
    .from(orderSessions)
    .innerJoin(tenants, eq(tenants.id, orderSessions.tenantId))
    .leftJoin(tenantConfig, eq(tenantConfig.tenantId, orderSessions.tenantId))
    .where(eq(orderSessions.id, sessionId))
    .limit(1)

  // `printBill` and `printDraft` hold the session lock, so a missing row is a
  // bug, not a race. And a missing `tenant_config` is a broken installation:
  // both entry points refuse the same way (`MissingTenantConfigError`) rather
  // than one printing a restaurant called "Bill".
  if (!session) throw new ReceiptBillNotFoundError()
  if (!session.configTenantId) throw new MissingTenantConfigError()

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
  // Every counter-origin session IS a bar tab in this app (`tabSequence`).
  //
  // A table order whose tables were all released is not a counter order: it
  // keeps its primary table's name (`order_sessions.table_id`), and only an
  // order with no table at all falls back to COUNTER.
  let tableLabels = labels
  if (tableLabels.length === 0) {
    if (session.kind === 'counter') {
      tableLabels = ['Bar tab']
    } else {
      const [primary] = session.primaryTableId
        ? await tx.select({ label: tables.label }).from(tables).where(eq(tables.id, session.primaryTableId)).limit(1)
        : []
      tableLabels = [primary?.label ?? 'COUNTER']
    }
  }

  // The cashier: whoever tapped Print, or took the payment the receipt follows.
  // Same tenant only — a stale header never names someone else's staff.
  const [cashier] = staffId
    ? await tx
        .select({ name: staff.name })
        .from(staff)
        .where(and(eq(staff.id, staffId), eq(staff.tenantId, session.tenantId)))
        .limit(1)
    : []

  const [server] = await tx.select({ name: staff.name }).from(staff).where(eq(staff.id, session.serverId)).limit(1)

  return {
    tenantId: session.tenantId,
    cashierName: cashier?.name ?? null,
    serverName: server?.name ?? null,
    logo: session.receiptLogo ?? null,
    qr: session.receiptQrUrl
      ? { url: session.receiptQrUrl.trim(), caption: session.receiptQrCaption ?? null }
      : null,
    restaurantName: session.restaurantName ?? 'Bill',
    headerLines: receiptTextLines(session.receiptHeader ?? null),
    footerLines: receiptTextLines(session.receiptFooter ?? null),
    tableLabels,
    printedAt: new Date(session.now).toISOString(),
    timeZone: session.timeZone,
    dailyNumber: session.dailyNumber,
    businessDate: session.businessDate,
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
 * Whether the guest already holds a printed BILL for exactly what was just paid
 * (Teran, 2026-11-13). Then the automatic receipt at payment is skipped:
 * the guest checked that bill and paid it, a second slip says nothing new.
 *
 * True when a BILL job for this order — the draft printed before Settle, or
 * this recorded bill printed — is not dead, has the same total and the same
 * guest label (split / seat), and no item was added, removed, changed, comped
 * or voided after it was queued. Anything changed since → the receipt prints,
 * so the guest has the right figures. Print receipt still prints one on demand.
 */
export async function billAlreadyHandedOver(tx: Tx, billId: string): Promise<boolean> {
  const bill = await getBill(tx, billId)
  // A short payment (Teran, 2026-11-21): the printed bill showed the full
  // total, so the guest gets a receipt that says what they actually paid.
  if (!bill || bill.shortPaisa > 0) return false
  const billLabel =
    bill.type === 'seat' ? bill.seatLabel : bill.type === 'split' ? guestBillLabel(bill.personLabel) : null

  const result = await tx.execute(sql`
    select exists (
      select 1
        from print_jobs j
       where j.session_id = ${bill.sessionId}
         and j.status <> 'dead'
         and j.ticket->>'kind' = 'receipt'
         and j.ticket->>'title' = 'BILL'
         and (j.ticket->>'totalPaisa')::int = ${bill.totalPaisa}
         and (j.bill_id = ${billId}
              or (j.bill_id is null
                  and coalesce(j.ticket->>'billLabel', '') = ${billLabel ?? ''}))
         and j.created_at > coalesce((
               select max(e.created_at)
                 from order_events e
                where e.session_id = ${bill.sessionId}
                  and e.event_type in ('ITEM_ADDED', 'ITEM_REMOVED', 'ITEM_MODIFIED',
                                       'ITEM_COMPED', 'ITEM_VOIDED')
             ), '-infinity'::timestamptz)
    ) as handed_over`)
  return Boolean((result.rows[0] as { handed_over?: boolean } | undefined)?.handed_over)
}

/**
 * Prints a RECORDED bill — a seat billed early, a bill written at Settle, a
 * paid one. `RECEIPT` once fully paid, with its tenders; `COPY` when a job for
 * this bill has already been PRINTED (a pending, retrying or dead job never
 * reached paper, so the next one is still the first the guest sees).
 */
export async function printBill(
  tx: Tx,
  { billId, staffId = null }: { billId: string; staffId?: string | null },
): Promise<{ jobId: string }> {
  const bill = await getBill(tx, billId)
  // A cancelled bill (Story 7.5) is never handed to a guest again.
  if (!bill || bill.cancelledAt) throw new ReceiptBillNotFoundError()
  await lockOpenSession(tx, bill.sessionId)

  const heading = await readHeading(tx, bill.sessionId, staffId)

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
  // A short payment (Teran, 2026-11-21) closed the bill: a receipt, not a bill.
  const title = paid + bill.shortPaisa >= bill.totalPaisa ? 'RECEIPT' : 'BILL'

  // A COPY is the SAME document printed again. The bill the guest checked
  // before paying is not a copy of the receipt that prints after it (Teran,
  // 2026-11-10: the receipt prints by itself at payment), so only earlier jobs
  // with this title count — and only ones that REACHED PAPER (Teran,
  // 2026-11-11): a job still pending, retrying or dead has not been seen by the
  // guest, so the next one is still the first.
  const [{ printed }] = await tx
    .select({ printed: sql<number>`count(*)::int` })
    .from(printJobs)
    .where(
      and(
        eq(printJobs.billId, billId),
        eq(printJobs.status, 'printed'),
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
    discountBp: bill.discountBp,
    discountPaisa: bill.discountPaisa,
    serviceChargeWaived: bill.serviceChargeWaived,
    serviceChargePaisa: bill.serviceChargePaisa,
    serviceChargeBp: bill.serviceChargeBp,
    taxPaisa: bill.taxPaisa,
    taxBp: bill.taxBp,
    totalPaisa: bill.totalPaisa,
    tenders: tenderRows,
    shortPaisa: bill.shortPaisa > 0 ? bill.shortPaisa : undefined,
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
    expectedTotalPaisa,
    staffId = null,
  }: {
    sessionId: string
    /** Who tapped Print — named on the paper as the cashier. */
    staffId?: string | null
    items?: { eventId: string; quantity: number }[]
    personLabel?: string | null
    /** The total the waiter's screen showed; a different one refuses (BillTotalChangedError). */
    expectedTotalPaisa?: number
  },
): Promise<{ jobId: string }> {
  await lockOpenSession(tx, sessionId)
  const priced = await priceBillable(tx, { sessionId, items })
  // An empty draft is not a bill. `priceBillable` returns zeroes for it rather
  // than refusing, because the bill screen shows an empty draft as "nothing to
  // pay"; paper with no lines is never what a waiter meant to print.
  if (priced.events.length === 0) throw new NothingToBillError()
  if (expectedTotalPaisa !== undefined && priced.totals.totalPaisa !== expectedTotalPaisa) {
    throw new BillTotalChangedError(priced.totals.totalPaisa)
  }

  const heading = await readHeading(tx, sessionId, staffId)
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
    discountBp: priced.totals.discountBp,
    discountPaisa: priced.totals.discountPaisa,
    serviceChargeWaived: priced.totals.serviceChargeWaived,
    serviceChargePaisa: priced.totals.serviceChargePaisa,
    serviceChargeBp: priced.totals.serviceChargeBp,
    taxPaisa: priced.totals.taxPaisa,
    taxBp: priced.totals.taxBp,
    totalPaisa: priced.totals.totalPaisa,
    tenders: [],
  })

  return enqueue(tx, { tenantId: priced.tenantId, sessionId, billId: null, payload })
}

/**
 * ONE receipt for orders paid together (Teran, 2026-11-16): every paid bill's
 * lines, the summed money, and the tenders. Headed by the first order, naming
 * every table. Each bill keeps its own record; only the paper is shared.
 */
export async function printCombinedReceipt(
  tx: Tx,
  { billIds, staffId = null }: { billIds: string[]; staffId?: string | null },
): Promise<{ jobId: string }> {
  const loaded = (await Promise.all(billIds.map((id) => getBill(tx, id)))).filter(
    (bill): bill is NonNullable<typeof bill> => bill !== null && bill.cancelledAt === null,
  )
  if (loaded.length === 0) throw new ReceiptBillNotFoundError()

  const sessionIds = [...new Set(loaded.map((bill) => bill.sessionId))]
  const headings = await Promise.all(sessionIds.map((id) => readHeading(tx, id, staffId)))
  const heading = headings[0]!
  const tableLabels = [...new Set(headings.flatMap((h) => h.tableLabels))]

  const tenderRows = await tx
    .select({
      method: paymentRecords.method,
      amountPaisa: paymentRecords.amountPaisa,
      cashReceivedPaisa: paymentRecords.cashReceivedPaisa,
    })
    .from(paymentRecords)
    .where(inArray(paymentRecords.billId, loaded.map((bill) => bill.billId)))
    .orderBy(asc(paymentRecords.createdAt), asc(paymentRecords.id))
  // One line per method: the guest paid once. The note handed over is the
  // cash paid plus the change recorded beside the last cash share.
  const tenders: ReceiptPayload['tenders'] = []
  for (const method of ['cash', 'card', 'transfer'] as const) {
    const rows = tenderRows.filter((row) => row.method === method)
    if (rows.length === 0) continue
    const amountPaisa = rows.reduce((total, row) => total + row.amountPaisa, 0)
    const changePaisa = rows.reduce((total, row) => total + (row.cashReceivedPaisa !== null ? row.cashReceivedPaisa - row.amountPaisa : 0), 0)
    tenders.push({ method, amountPaisa, cashReceivedPaisa: method === 'cash' ? amountPaisa + changePaisa : null })
  }

  const sum = (pick: (bill: (typeof loaded)[number]) => number) => loaded.reduce((total, bill) => total + pick(bill), 0)
  // A rate prints only when every bill used the same one.
  const same = (pick: (bill: (typeof loaded)[number]) => number) => (loaded.every((bill) => pick(bill) === pick(loaded[0]!)) ? pick(loaded[0]!) : 0)

  const payload = buildReceiptPayload({
    ...heading,
    tableLabels,
    title: 'RECEIPT',
    copy: false,
    billLabel: 'Paid together',
    lines: loaded.flatMap((bill) =>
      bill.lines.map(
        (line): ReceiptLine => ({
          quantity: line.quantity,
          name: line.name,
          amountPaisa: line.amountPaisa,
          optionText: line.optionText,
          modifierText: line.modifierText,
        }),
      ),
    ),
    comps: loaded.flatMap((bill) => bill.comps.map((comp) => ({ reason: comp.reason, amountPaisa: comp.amountPaisa }))),
    subtotalPaisa: sum((bill) => bill.subtotalPaisa),
    discountBp: same((bill) => bill.discountBp),
    discountPaisa: sum((bill) => bill.discountPaisa),
    serviceChargeWaived: loaded.every((bill) => bill.serviceChargeWaived),
    serviceChargePaisa: sum((bill) => bill.serviceChargePaisa),
    serviceChargeBp: loaded.find((bill) => bill.serviceChargePaisa > 0)?.serviceChargeBp ?? 0,
    taxPaisa: sum((bill) => bill.taxPaisa),
    taxBp: same((bill) => bill.taxBp) || (loaded.find((bill) => bill.taxPaisa > 0)?.taxBp ?? 0),
    totalPaisa: sum((bill) => bill.totalPaisa),
    tenders,
  })
  return enqueue(tx, { tenantId: heading.tenantId, sessionId: loaded[0]!.sessionId, billId: null, payload })
}

/**
 * ONE bill for orders about to be paid together, before Settle (Teran,
 * 2026-11-16): every order's unpaid bills and unbilled items, priced as Settle
 * will price them, summed. Nothing is written but the print job. A total
 * different from the one on the cashier's screen is refused.
 */
export async function printTogetherBill(
  tx: Tx,
  { sessionIds, staffId = null, expectedTotalPaisa }: { sessionIds: string[]; staffId?: string | null; expectedTotalPaisa: number },
): Promise<{ jobId: string }> {
  const lines: ReceiptLine[] = []
  const comps: ReceiptPayload['comps'] = []
  const parts: { subtotal: number; discount: number; discountBp: number; service: number; serviceBp: number; waived: boolean; tax: number; taxBp: number; total: number }[] = []
  const paidBillIds: string[] = []
  const headings = []

  for (const sessionId of [...new Set(sessionIds)]) {
    await lockOpenSession(tx, sessionId)
    headings.push(await readHeading(tx, sessionId, staffId))
    const payments = await loadSessionPayments(tx, sessionId)
    for (const bill of await loadSessionBills(tx, sessionId)) {
      const paid = payments.get(bill.billId)?.paidPaisa ?? 0
      if (bill.totalPaisa - bill.shortPaisa - paid <= 0) continue
      if (paid > 0) paidBillIds.push(bill.billId)
      for (const line of bill.lines) {
        lines.push({ quantity: line.quantity, name: line.name, amountPaisa: line.amountPaisa, optionText: line.optionText, modifierText: line.modifierText })
      }
      comps.push(...bill.comps.map((comp) => ({ reason: comp.reason, amountPaisa: comp.amountPaisa })))
      parts.push({ subtotal: bill.subtotalPaisa, discount: bill.discountPaisa, discountBp: bill.discountBp, service: bill.serviceChargePaisa, serviceBp: bill.serviceChargeBp, waived: bill.serviceChargeWaived, tax: bill.taxPaisa, taxBp: bill.taxBp, total: bill.totalPaisa })
    }
    const priced = await priceBillable(tx, { sessionId }).catch(() => null)
    if (priced && priced.events.length > 0) {
      priced.events.forEach((event, index) => {
        lines.push({
          quantity: priced.lineQuantities[index]!,
          name: event.customName ?? event.itemName ?? 'Unknown item',
          amountPaisa: priced.lineAmounts[index]!,
          optionText: event.optionText,
          modifierText: event.modifierText,
        })
      })
      comps.push(...priced.comps.map((comp, index) => ({ reason: comp.reason, amountPaisa: priced.compAmounts[index]! })))
      const t = priced.totals
      parts.push({ subtotal: t.subtotalPaisa, discount: t.discountPaisa, discountBp: t.discountBp, service: t.serviceChargePaisa, serviceBp: t.serviceChargeBp, waived: t.serviceChargeWaived, tax: t.taxPaisa, taxBp: t.taxBp, total: t.totalPaisa })
    }
  }
  if (lines.length === 0) throw new NothingToBillError()

  // What has been paid on a part-paid bill comes off, as on any BILL.
  const tenderRows = paidBillIds.length
    ? await tx
        .select({ method: paymentRecords.method, amountPaisa: paymentRecords.amountPaisa, cashReceivedPaisa: paymentRecords.cashReceivedPaisa })
        .from(paymentRecords)
        .where(inArray(paymentRecords.billId, paidBillIds))
    : []
  const owed = parts.reduce((sum, part) => sum + part.total, 0) - tenderRows.reduce((sum, row) => sum + row.amountPaisa, 0)
  if (owed !== expectedTotalPaisa) throw new BillTotalChangedError(owed)

  const sum = (pick: (part: (typeof parts)[number]) => number) => parts.reduce((total, part) => total + pick(part), 0)
  const same = (pick: (part: (typeof parts)[number]) => number) => (parts.every((part) => pick(part) === pick(parts[0]!)) ? pick(parts[0]!) : 0)
  const heading = headings[0]!
  const payload = buildReceiptPayload({
    ...heading,
    tableLabels: [...new Set(headings.flatMap((h) => h.tableLabels))],
    title: 'BILL',
    copy: false,
    billLabel: 'Paying together',
    lines,
    comps,
    subtotalPaisa: sum((part) => part.subtotal),
    discountBp: same((part) => part.discountBp),
    discountPaisa: sum((part) => part.discount),
    serviceChargeWaived: parts.every((part) => part.waived),
    serviceChargePaisa: sum((part) => part.service),
    serviceChargeBp: parts.find((part) => part.service > 0)?.serviceBp ?? 0,
    taxPaisa: sum((part) => part.tax),
    taxBp: same((part) => part.taxBp) || (parts.find((part) => part.tax > 0)?.taxBp ?? 0),
    totalPaisa: sum((part) => part.total),
    tenders: tenderRows,
  })
  return enqueue(tx, { tenantId: heading.tenantId, sessionId: sessionIds[0]!, billId: null, payload })
}
