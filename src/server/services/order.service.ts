import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { db } from '@/server/db'
import {
  menuItems,
  orderEvents,
  orderRounds,
  orderSessions,
  orderSessionTables,
  printJobs,
  seatSlots,
  tables,
  tenants,
  zones,
} from '@/server/db/schema'
import { lockOpenSession } from '@/server/services/table-session.service'
import { billedSeats, findConsolidatedBill } from '@/server/services/bill.service'
import { buildTicketPayloads } from '@/server/print/ticket'
import { zoneUsesSeats } from '@/lib/design'
import type {
  ProductionDestination,
  SubmitRoundLine,
  SubmitRoundResponse,
  TicketLine,
} from '@/types/orders'

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

// ── Errors ───────────────────────────────────────────────────────────────────
// Typed, so the route maps each to its status without parsing messages — the
// pattern `table-session.service.ts` uses.

/** A dish is 86'd, or no longer on the menu at all (AC-7). */
export class ItemUnavailableError extends Error {
  constructor(readonly itemId: string) {
    super('Item unavailable')
  }
}

/** A dish's price changed after the waiter saw it (AC-9). */
export class PriceChangedError extends Error {
  constructor(
    readonly itemId: string,
    readonly currentPricePaisa: number,
  ) {
    super('Price changed')
  }
}

/** A line names a seat that is not on this session (AC-10). */
export class SeatNotOnSessionError extends Error {
  constructor(readonly seatId: string) {
    super('Seat not on session')
  }
}

/** The submission id already belongs to a round on a DIFFERENT session. */
export class SubmissionIdReusedError extends Error {}

/**
 * The session already has a bill, so nothing more may be added to it.
 *
 * ── Why this is a SERVER rule (code review 2026-10-13) ───────────────────────
 * Story 6.2 moved the order screen to a `settling` state once a bill exists,
 * and that was the only guard: a React `useState`. It died on a page refresh,
 * it never existed on a second tablet, and the API accepted the round either
 * way. The consequence was not a cosmetic one — the round committed, the
 * ticket printed, the kitchen cooked it, and then `generateConsolidatedBill`
 * refused a second bill, so those `ITEM_ADDED` rows could never be covered by
 * any bill. The guest ate food that appeared on no bill and in no total, and
 * nothing in the system flagged it.
 *
 * `UNIQUE (order_event_id)` does not help here: it prevents the same item
 * being billed TWICE, not an item being billed NEVER.
 *
 * Teran chose the refusing side of the trade (2026-10-13): a guest who orders
 * after seeing the bill cannot be served until supplementary billing exists,
 * which Story 6.5 owns. Refusing loudly beats serving food nobody is charged
 * for.
 */
export class SessionAlreadyBilledError extends Error {
  constructor(readonly billId: string) {
    super('Session already billed')
  }
}

/**
 * ONE SEAT has been billed, and this round touches it (Story 6.4, AC-3).
 *
 * The narrower half of the rule above. Per-seat billing exists so a guest can
 * pay and leave while the rest of the table keeps ordering, so a seat bill
 * must close exactly one seat and nothing else — the session-wide refusal
 * would have made AC-2 impossible.
 *
 * Carries the seat LABEL as well as the id: the waiter is holding a tablet and
 * needs to be told "Seat 2 has already been billed", not a uuid.
 */
export class SeatAlreadyBilledError extends Error {
  constructor(
    readonly seatSlotId: string,
    readonly seatLabel: string,
    readonly billId: string,
  ) {
    super('Seat already billed')
  }
}

/** What a send commits, and what the route needs to announce it. */
export type SubmittedRound = SubmitRoundResponse & {
  /** Present only for a NEW round. A replay announces nothing (Trap 3). */
  announcement: {
    tableIds: string[]
    tableLabels: string[]
    usesSeats: boolean
    openedAt: Date
    /**
     * Whether this is a counter sale, from `order_sessions.kind`.
     *
     * NOT `tableIds.length === 0`: a table order whose tables were all released
     * also has none, and it was being announced as a counter sale, refreshing
     * no card at all.
     */
     isCounterSale: boolean
    /** The committed row's timestamp — PostgreSQL's clock, not Node's. */
    submittedAt: Date
    byDestination: Map<ProductionDestination, TicketLine[]>
  } | null
}

async function findRound(executor: Tx | typeof db, submissionId: string) {
  const [round] = await executor
    .select({
      id: orderRounds.id,
      sessionId: orderRounds.sessionId,
      roundNumber: orderRounds.roundNumber,
      itemCount: orderRounds.itemCount,
    })
    .from(orderRounds)
    .where(eq(orderRounds.id, submissionId))
    .limit(1)
  return round ?? null
}

function replayOf(
  round: { id: string; sessionId: string; roundNumber: number; itemCount: number },
  sessionId: string,
): SubmittedRound {
  if (round.sessionId !== sessionId) throw new SubmissionIdReusedError()
  return {
    submissionId: round.id,
    roundNumber: round.roundNumber,
    itemCount: round.itemCount,
    replayed: true,
    announcement: null,
  }
}

/**
 * Sends one round: every staged line becomes an `ITEM_ADDED` event, in one
 * transaction (FR12, Story 4.5).
 *
 * Takes the transaction from the caller, so a future caller — Epic 12's relay
 * consumer ("hands requests to `order.service.submit()`") — runs exactly the
 * same validation, atomicity and audit rules as the tablet.
 *
 * ── Order of operations ──────────────────────────────────────────────────────
 * Step 1 runs BEFORE any lock — it is the fast path for a replay, which must
 * answer even for a session that has since been closed. Everything from step 2
 * is under the session row lock.
 *
 * 1. Replay? Answer from the existing round and write nothing (AC-8).
 * 2. Lock the session and refuse a closed one (`lockOpenSession`).
 * 3. Re-check replay under the lock — two identical requests now serialise, so
 *    the second sees the first's committed round.
 * 4. Every seat must be on this session (AC-10). The session lock also blocks
 *    `deleteSeat`, so a seat cannot vanish between this check and the insert.
 * 5. Every dish must exist, be available, and cost what the waiter was shown
 *    (AC-7, AC-9). Read `FOR SHARE`, so an 86 cannot commit mid-check.
 * 6. Derive the round number under the lock (Trap 1).
 * 7. Insert the round, then the events.
 * 8. Insert one `print_jobs` row per destination (Story 5.0) — in this same
 *    transaction, so an order cannot exist without its tickets queued.
 */
export async function submitRound(
  tx: Tx,
  {
    sessionId,
    staffId,
    submissionId,
    lines,
  }: {
    sessionId: string
    staffId: string
    submissionId: string
    lines: SubmitRoundLine[]
  },
): Promise<SubmittedRound> {
  // 1 — the fast path, before taking any lock. A replay on a session that has
  // since been CLOSED must still answer: the round it describes was committed.
  const earlier = await findRound(tx, submissionId)
  if (earlier) return replayOf(earlier, sessionId)

  // 2
  await lockOpenSession(tx, sessionId)

  // 3
  const racing = await findRound(tx, submissionId)
  if (racing) return replayOf(racing, sessionId)

  // 3b — nothing may be added to a session that has been billed.
  //
  // Under the session lock, so it cannot race a bill being generated: either
  // this round commits first and the bill includes it, or the bill commits
  // first and this is refused. `generateConsolidatedBill` takes the same lock.
  //
  // AFTER the replay checks, deliberately. A retry of a round that was
  // committed BEFORE the bill must still return its original answer — the
  // waiter's tablet retrying a lost response has not added anything, and
  // failing it would strand a round the kitchen already cooked.
  // A CONSOLIDATED bill covers everything unbilled on the session, so once one
  // exists nothing more may be added anywhere.
  const consolidated = await findConsolidatedBill(tx, sessionId)
  if (consolidated) throw new SessionAlreadyBilledError(consolidated.id)

  // A SEAT bill closes exactly one seat. Story 6.4 exists so the other seats
  // carry on ordering, so this refuses the round only if it touches a seat
  // that has been billed. The first version of this guard asked
  // `findOpenBill(sessionId)` and refused every round on the table — correct
  // when a session could hold one bill, and wrong the moment it could hold
  // several.
  const billed = await billedSeats(tx, sessionId)
  if (billed.size > 0) {
    // In LINE order, so the error names the first seat the waiter would see —
    // the same rule the dish and seat checks below follow.
    for (const line of lines) {
      const hit = billed.get(line.seatSlotId)
      // The whole round is refused, not just the offending line. A round is
      // atomic (Story 4.5) and the kitchen ticket assumes it; accepting the
      // rest would print a ticket for half an order.
      if (hit) throw new SeatAlreadyBilledError(line.seatSlotId, hit.seatLabel, hit.billId)
    }
  }

  // 4 — seats
  const seatIds = [...new Set(lines.map((line) => line.seatSlotId))]
  const seatRows = await tx
    .select({ id: seatSlots.id, seatLabel: seatSlots.seatLabel, seatNote: seatSlots.seatNote })
    .from(seatSlots)
    .where(and(eq(seatSlots.sessionId, sessionId), inArray(seatSlots.id, seatIds)))
  const seatsById = new Map(seatRows.map((seat) => [seat.id, seat]))
  for (const line of lines) {
    if (!seatsById.has(line.seatSlotId)) throw new SeatNotOnSessionError(line.seatSlotId)
  }

  // 5 — dishes. `FOR SHARE` lets other sends read the same rows concurrently
  // while blocking an owner's 86 or re-price until this round commits.
  const itemIds = [...new Set(lines.map((line) => line.menuItemId))]
  const itemRows = await tx
    .select({
      id: menuItems.id,
      name: menuItems.name,
      pricePaisa: menuItems.pricePaisa,
      isAvailable: menuItems.isAvailable,
      productionDestination: menuItems.productionDestination,
    })
    .from(menuItems)
    .where(inArray(menuItems.id, itemIds))
    .for('share')
  const itemsById = new Map(itemRows.map((item) => [item.id, item]))
  // In line order, so the error names the first line the waiter would see.
  for (const line of lines) {
    const item = itemsById.get(line.menuItemId)
    if (!item || !item.isAvailable) throw new ItemUnavailableError(line.menuItemId)
    // The quote is a CHECK, never a value (Decision 2). The row below is
    // written with the menu's price, so a tablet can never set one.
    if (item.pricePaisa !== line.quotedPricePaisa) {
      throw new PriceChangedError(line.menuItemId, item.pricePaisa)
    }
  }

  // ── Epic 8 (Story 8.2) goes HERE ──────────────────────────────────────────
  // `inventory.service.decrementBatch(tx, lines)` — the atomic
  // `portion_count >= qty` decrement — runs in this transaction, after the
  // availability check and before the insert, so an oversold dish rolls the
  // whole round back. Not implemented in 4.5.

  // 6 — the next round number, read under the session lock.
  //
  // Taken from BOTH tables. `order_rounds` starts empty, but sessions can hold
  // ITEM_ADDED events from before it existed, and the history treats a NULL
  // round as round 1. Counting only `order_rounds` would give this session's
  // first real send round 1 as well — two different "Round 1"s.
  const [fromRounds] = await tx
    .select({ highest: max(orderRounds.roundNumber) })
    .from(orderRounds)
    .where(eq(orderRounds.sessionId, sessionId))
  const [fromEvents] = await tx
    .select({ highest: sql<number | null>`max(coalesce(${orderEvents.roundNumber}, 1))` })
    .from(orderEvents)
    .where(and(eq(orderEvents.sessionId, sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))
  const roundNumber =
    Math.max(Number(fromRounds?.highest ?? 0), Number(fromEvents?.highest ?? 0)) + 1

  const itemCount = lines.reduce((total, line) => total + line.quantity, 0)

  // 7 — the round first: it is the idempotency record, and if its primary key
  // collides nothing else has been written yet.
  const [committedRound] = await tx
    .insert(orderRounds)
    .values({
      id: submissionId,
      sessionId,
      roundNumber,
      staffId,
      itemCount,
    })
    // The database stamps `submitted_at`; the ticket and the audit row must
    // carry the same instant, so the emit uses this rather than `new Date()`.
    .returning({ submittedAt: orderRounds.submittedAt })

  // Ids are generated here rather than returned, so each ticket line can be
  // tied to its event without relying on RETURNING preserving insert order.
  const eventRows = lines.map((line) => {
    const item = itemsById.get(line.menuItemId)!
    const note = line.modifierText.trim()
    return {
      id: randomUUID(),
      sessionId,
      staffId,
      menuItemId: line.menuItemId,
      eventType: 'ITEM_ADDED' as const,
      seatSlotId: line.seatSlotId,
      quantity: line.quantity,
      unitPricePaisa: item.pricePaisa,
      modifierText: note === '' ? null : note,
      roundNumber,
    }
  })
  await tx.insert(orderEvents).values(eventRows)

  // ── What the route will announce once this commits ────────────────────────
  const byDestination = new Map<ProductionDestination, TicketLine[]>()
  eventRows.forEach((row, index) => {
    const line = lines[index]
    const item = itemsById.get(line.menuItemId)!
    const seat = seatsById.get(line.seatSlotId)!
    const ticketLines = byDestination.get(item.productionDestination) ?? []
    ticketLines.push({
      eventId: row.id,
      name: item.name,
      quantity: row.quantity,
      modifierText: row.modifierText,
      seatLabel: seat.seatLabel,
      seatNote: seat.seatNote,
    })
    byDestination.set(item.productionDestination, ticketLines)
  })

  const [session] = await tx
    .select({
      openedAt: orderSessions.openedAt,
      kind: orderSessions.kind,
      tenantId: orderSessions.tenantId,
      // The restaurant's own timezone, for the time printed on the ticket.
      // Read here and copied onto the job, so the paper does not depend on
      // whether `TZ` was set on the host — see `src/server/time.ts`.
      timeZone: tenants.timezone,
    })
    .from(orderSessions)
    .innerJoin(tenants, eq(tenants.id, orderSessions.tenantId))
    .where(eq(orderSessions.id, sessionId))
    .limit(1)

  const attached = await tx
    .select({ id: tables.id, label: tables.label, zoneName: zones.name })
    .from(orderSessionTables)
    .innerJoin(tables, eq(tables.id, orderSessionTables.tableId))
    .innerJoin(zones, eq(zones.id, tables.zoneId))
    .where(
      and(eq(orderSessionTables.sessionId, sessionId), isNull(orderSessionTables.releasedAt)),
    )
    .orderBy(asc(tables.label))

  // A merge is within one zone, so the first table speaks for the group.
  // A counter sale has no table and no zone, and so no seats.
  const usesSeats = zoneUsesSeats(attached[0]?.zoneName ?? null)
  const tableLabels = attached.map((table) => table.label)

  // ── 8 — the print queue (Story 5.0, AC-1) ────────────────────────────────
  //
  // INSIDE this transaction, on purpose and by requirement. An order that
  // commits without its tickets queued is an order the kitchen never hears
  // about; a ticket queued by a transaction that then rolls back is food nobody
  // ordered. Both are impossible while these rows are written with `tx`.
  //
  // It is also why this sits AFTER the replay checks rather than in the route:
  // a repeat submission returns at step 1 and never reaches here, so a retry of
  // a lost response cannot enqueue a second ticket (Story 4.5, AC-8).
  //
  // No bytes, no socket, no printer. The worker delivers; this only records.
  const tickets = buildTicketPayloads({
    byDestination,
    roundNumber,
    tableLabels,
    usesSeats,
    submittedAt: committedRound!.submittedAt,
    timeZone: session!.timeZone,
  })
  await tx.insert(printJobs).values(
    tickets.map((ticket) => ({
      tenantId: session!.tenantId,
      sessionId,
      roundId: submissionId,
      destination: ticket.destination,
      ticket,
    })),
  )

  return {
    submissionId,
    roundNumber,
    itemCount,
    replayed: false,
    announcement: {
      tableIds: attached.map((table) => table.id),
      tableLabels,
      usesSeats,
      openedAt: session!.openedAt,
      isCounterSale: session!.kind === 'counter',
      submittedAt: committedRound!.submittedAt,
      byDestination,
    },
  }
}
