import 'server-only'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import { orderSessions, orderSessionTables, tables } from '@/server/db/schema'
import {
  findConsolidatedBill,
  generateConsolidatedBill,
  hasUnbilledItems,
  loadSessionBills,
  priceBillable,
} from '@/server/services/bill.service'
import { isFullyPaid, loadSessionPayments, recordPayments, type Tender } from '@/server/services/payment.service'
import { lockOpenSession } from '@/server/services/table-session.service'
import { tabName, tabSequence } from '@/server/orders/tab-sequence'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Pay together (Teran, 2026-11-16): two or more orders — a sun bed and a
 * table, say — paid in one go by one guest. The orders stay separate: each
 * gets its own bill and its own payment rows, so the dashboard, end of day and
 * audit stay right per order. Only the paying, and the receipt, are shared.
 */

/** The totals moved since the cashier saw them — refuse, never charge a different figure. */
export class PayTogetherTotalChangedError extends Error {
  constructor(readonly totalPaisa: number) {
    super('Total changed')
  }
}
/** An order with a whole-table bill AND items not on it: settle it on its own first. */
export class PayTogetherNeedsOwnSettleError extends Error {
  constructor(readonly label: string) {
    super('Settle on its own')
  }
}
/** Nothing is owed on these orders. */
export class PayTogetherNothingOwedError extends Error {}
/** The tenders do not add up to the total: pay together pays in full. */
export class PayTogetherNotInFullError extends Error {}

/** One line of what an order still owes, for the combined bill. */
export type OwedLine = {
  key: string
  name: string
  quantity: number
  amountPaisa: number
  optionText: string | null
  modifierText: string | null
}

export type OpenOrderToPay = {
  sessionId: string
  label: string
  dailyNumber: number
  /** Unpaid bills plus whatever is not billed yet, priced as Settle would. */
  owedPaisa: number
  /** What the guest is paying for, shown together on the bill screen (Teran, 2026-11-16). */
  lines: OwedLine[]
  /** Discount, service and tax on this order, summed. Positive or negative. */
  chargesPaisa: number
}

/** Where an order is, as staff name it: its tables, or its bar tab. */
async function orderLabel(executor: Tx | typeof db, session: { id: string; kind: string; tabLabel: string | null }) {
  const attached = await executor
    .select({ label: tables.label })
    .from(orderSessionTables)
    .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
    .where(and(eq(orderSessionTables.sessionId, session.id), isNull(orderSessionTables.releasedAt)))
  const labels = attached.map((row) => row.label).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (labels.length > 0) return labels.join(' + ')
  return tabName(await tabSequence(session.id), session.tabLabel)
}

/**
 * What one order still owes, and for what: the lines of its unpaid bills, and
 * its unbilled items priced as Settle would price them. A part-paid bill's
 * lines show in full; the payment so far comes off in `chargesPaisa`.
 */
async function owedOn(sessionId: string): Promise<{ owedPaisa: number; lines: OwedLine[]; chargesPaisa: number }> {
  const lines: OwedLine[] = []
  let owedPaisa = 0
  let linesPaisa = 0
  const recorded = await loadSessionBills(db, sessionId)
  const payments = await loadSessionPayments(db, sessionId)
  for (const bill of recorded) {
    const outstanding = bill.totalPaisa - bill.shortPaisa - (payments.get(bill.billId)?.paidPaisa ?? 0)
    if (outstanding <= 0) continue
    owedPaisa += outstanding
    for (const line of bill.lines) {
      lines.push({ key: `${bill.billId}:${line.orderEventId}`, name: line.name, quantity: line.quantity, amountPaisa: line.amountPaisa, optionText: line.optionText, modifierText: line.modifierText })
      linesPaisa += line.amountPaisa
    }
  }
  const priced = await db
    .transaction((tx) => priceBillable(tx, { sessionId }))
    .catch(() => null)
  if (priced && priced.events.length > 0) {
    owedPaisa += priced.totals.totalPaisa
    priced.events.forEach((event, index) => {
      const amountPaisa = priced.lineAmounts[index]!
      lines.push({
        key: `draft:${event.eventId}`,
        name: event.customName ?? event.itemName ?? 'Item',
        quantity: priced.lineQuantities[index]!,
        amountPaisa,
        optionText: event.optionText,
        modifierText: event.modifierText,
      })
      linesPaisa += amountPaisa
    })
  }
  return { owedPaisa, lines, chargesPaisa: owedPaisa - linesPaisa }
}

/** Every other open order that owes something — the picker's list. */
export async function listOpenOrdersToPay(exceptSessionId: string): Promise<OpenOrderToPay[]> {
  const open = await db
    .select({ id: orderSessions.id, kind: orderSessions.kind, tabLabel: orderSessions.tabLabel, dailyNumber: orderSessions.dailyNumber })
    .from(orderSessions)
    .where(isNull(orderSessions.closedAt))
    .orderBy(asc(orderSessions.dailyNumber))
  const rows: OpenOrderToPay[] = []
  for (const session of open) {
    if (session.id === exceptSessionId) continue
    const owed = await owedOn(session.id)
    if (owed.owedPaisa <= 0) continue
    rows.push({ sessionId: session.id, label: await orderLabel(db, session), dailyNumber: session.dailyNumber, ...owed })
  }
  return rows
}

/**
 * Bills what is unbilled on each order, then pays every unpaid bill in full
 * from the tenders, in one transaction. Orders are locked in id order, so two
 * tablets paying overlapping groups cannot deadlock.
 */
export async function payTogether(
  tx: Tx,
  {
    sessionIds,
    staffId,
    tenders,
    cashReceivedPaisa,
    expectedTotalPaisa,
  }: {
    sessionIds: string[]
    staffId: string
    tenders: Tender[]
    cashReceivedPaisa: number | null
    expectedTotalPaisa: number
  },
): Promise<{ billIds: string[]; sessions: { sessionId: string; allPaid: boolean }[]; cashRecordId: string | null }> {
  const ordered = [...new Set(sessionIds)].sort()
  const payable: { billId: string; sessionId: string; outstanding: number }[] = []

  for (const sessionId of ordered) {
    await lockOpenSession(tx, sessionId)
    if (await hasUnbilledItems(tx, sessionId)) {
      if (await findConsolidatedBill(tx, sessionId)) {
        const [session] = await tx
          .select({ id: orderSessions.id, kind: orderSessions.kind, tabLabel: orderSessions.tabLabel })
          .from(orderSessions)
          .where(eq(orderSessions.id, sessionId))
        throw new PayTogetherNeedsOwnSettleError(await orderLabel(tx, session!))
      }
      await generateConsolidatedBill(tx, { sessionId, staffId })
    }
    const unpaid = await tx.execute(sql`
      select b.id, (b.total_paisa - b.short_paisa - coalesce((select sum(p.amount_paisa) from payment_records p where p.bill_id = b.id), 0))::int as outstanding
        from bills b where b.session_id = ${sessionId} and b.cancelled_at is null
       order by b.created_at`)
    for (const row of unpaid.rows as { id: string; outstanding: number }[]) {
      if (row.outstanding > 0) payable.push({ billId: row.id, sessionId, outstanding: row.outstanding })
    }
  }

  const total = payable.reduce((sum, bill) => sum + bill.outstanding, 0)
  if (total <= 0) throw new PayTogetherNothingOwedError()
  if (total !== expectedTotalPaisa) throw new PayTogetherTotalChangedError(total)
  if (tenders.reduce((sum, tender) => sum + tender.amountPaisa, 0) !== total) throw new PayTogetherNotInFullError()

  // Fill each bill from the tenders in order: cash first, then card/transfer.
  const pool = tenders.map((tender) => ({ ...tender }))
  const plan = payable.map((bill) => {
    let need = bill.outstanding
    const take: Tender[] = []
    for (const tender of pool) {
      if (need === 0) break
      const used = Math.min(need, tender.amountPaisa)
      if (used <= 0) continue
      tender.amountPaisa -= used
      need -= used
      const same = take.find((entry) => entry.method === tender.method)
      if (same) same.amountPaisa += used
      else take.push({ method: tender.method, amountPaisa: used })
    }
    return { ...bill, tenders: take }
  })

  // The note the guest handed over sits beside the LAST cash share, so the
  // change on paper is right: that share + the change.
  const cashTotal = tenders.filter((t) => t.method === 'cash').reduce((sum, t) => sum + t.amountPaisa, 0)
  const change = cashReceivedPaisa === null ? 0 : cashReceivedPaisa - cashTotal
  const lastCash = [...plan].reverse().find((bill) => bill.tenders.some((t) => t.method === 'cash'))

  let cashRecordId: string | null = null
  for (const bill of plan) {
    const cashShare = bill.tenders.find((t) => t.method === 'cash')?.amountPaisa ?? 0
    const paid = await recordPayments(tx, {
      billId: bill.billId,
      staffId,
      tenders: bill.tenders,
      cashReceivedPaisa: bill === lastCash && cashReceivedPaisa !== null ? cashShare + Math.max(change, 0) : null,
    })
    cashRecordId ??= paid.cashRecordId
  }

  const sessions = await Promise.all(
    ordered.map(async (sessionId) => ({ sessionId, allPaid: await isFullyPaid(tx, sessionId) })),
  )
  return { billIds: plan.map((bill) => bill.billId), sessions, cashRecordId }
}

