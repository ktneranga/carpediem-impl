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
  seatSlots,
  tables,
  zones,
} from '@/server/db/schema'
import { lockOpenSession } from '@/server/services/table-session.service'
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

/** What a send commits, and what the route needs to announce it. */
export type SubmittedRound = SubmitRoundResponse & {
  /** Present only for a NEW round. A replay announces nothing (Trap 3). */
  announcement: {
    tableIds: string[]
    tableLabels: string[]
    usesSeats: boolean
    openedAt: Date
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
 * ── Order of operations, all under one lock ──────────────────────────────────
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
  await tx.insert(orderRounds).values({
    id: submissionId,
    sessionId,
    roundNumber,
    staffId,
    itemCount,
  })

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
    .select({ openedAt: orderSessions.openedAt })
    .from(orderSessions)
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

  return {
    submissionId,
    roundNumber,
    itemCount,
    replayed: false,
    announcement: {
      tableIds: attached.map((table) => table.id),
      tableLabels: attached.map((table) => table.label),
      // A merge is within one zone, so the first table speaks for the group.
      // A counter sale has no table and no zone, and so no seats.
      usesSeats: zoneUsesSeats(attached[0]?.zoneName ?? null),
      openedAt: session!.openedAt,
      byDestination,
    },
  }
}
