import 'server-only'
import { and, asc, count, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import {
  orderEvents,
  orderSessions,
  orderSessionTables,
  seatSlots,
  tables,
  tableStatusEvents,
} from '@/server/db/schema'
import type { db } from '@/server/db'

/**
 * Table session lifecycle — opening and closing a seating.
 *
 * NOT to be confused with `session.service.ts`, which is STAFF AUTH sessions.
 * Two entirely different things called "session"; keep them apart.
 *
 * Both functions take a transaction handle rather than opening their own, so the
 * caller composes. Story 6.5 closes a session as part of recording the final
 * payment, and that must be one transaction with the payment write — a service
 * that opened its own could not participate.
 */

/** Every terminal state a seating can reach. */
export type SessionCloseReason = 'abandoned' | 'walkout' | 'settled'

/**
 * Reasons a client may request over HTTP.
 *
 * `settled` is deliberately excluded: it belongs to Story 6.5's payment flow and
 * accepting it from a client would let anyone close a table as paid with no
 * payment record behind it — a hole straight through the audit trail.
 */
export const CLIENT_CLOSE_REASONS = ['abandoned', 'walkout'] as const

/** Drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Raised when the table was taken out of service between read and write. */
export class TableWentUnavailableError extends Error {}

/** Raised when another device closed the session first. */
export class SessionAlreadyClosedError extends Error {}

/** Raised when un-merging a table that is not attached to the session. */
export class TableNotAttachedError extends Error {}

/**
 * Raised when deleting a seat would leave the session with none.
 *
 * Thrown from INSIDE the delete transaction, under the session row lock — the
 * same shape as `SessionNeedsATableError`, and for the same reason. Story 3.9's
 * review found the last-TABLE guard counting in one transaction that closed
 * before the write began, so two devices both passed. One story later, the same
 * mistake was available here.
 */
export class SessionNeedsASeatError extends Error {}

/**
 * Raised when a seat id is not on the session it was addressed under.
 *
 * Added by the 4.3 review. `deleteSeat` used to end with a DELETE scoped by both
 * ids and never look at the row count, so a foreign or already-removed seat id
 * removed nothing and the route reported **200 success** — while `PATCH` on the
 * identical input returned 404. The client's `onSuccess` then filtered that id
 * out of its cache, so the screen reported a removal that had not happened.
 */
export class SeatNotFoundError extends Error {}

/** Raised when deleting a seat that order items still point at. */
export class SeatHasItemsError extends Error {
  constructor(readonly itemCount: number) {
    super('Seat has items')
  }
}

/**
 * Raised when releasing a table would leave the session attached to nothing.
 *
 * Thrown from INSIDE the release transaction, after the session row is locked.
 * The route used to check this itself, in a separate transaction that closed
 * before the write began — so two devices un-merging the two tables of a pair
 * both read a count of 2, both passed, and both committed, leaving an open
 * session with zero attachments. The check has to hold the same lock as the
 * write or it is decoration.
 */
export class SessionNeedsATableError extends Error {}

/**
 * Opens a seating on a table.
 *
 * Caller is responsible for having checked the table exists and is not
 * `unavailable`, and for catching the unique-violation that enforces
 * one-open-session-per-table. This function owns the writes, not the policy.
 */
export async function openSession(
  tx: Tx,
  {
    tableId,
    tenantId,
    staffId,
    additionalTableIds = [],
    additionalTableLabels = [],
  }: {
    tableId: string
    tenantId: string
    staffId: string
    /** Story 3.8 — seating one party across several tables in the same zone. */
    additionalTableIds?: string[]
    /** Labels of those same tables, for the audit note. */
    additionalTableLabels?: string[]
  },
): Promise<{ id: string; openedAt: Date }> {
  const [created] = await tx
    .insert(orderSessions)
    // table_id is the PRIMARY table — breadcrumbs, labels, ticket headers. Every
    // table the party occupies, including this one, is in order_session_tables.
    .values({ tenantId, tableId, openedByStaffId: staffId })
    .returning({ id: orderSessions.id, openedAt: orderSessions.openedAt })

  const allTableIds = [tableId, ...additionalTableIds]

  // The insert that decides races. The partial unique index on
  // order_session_tables (table_id WHERE released_at IS NULL) makes a second
  // open attachment impossible; a loser gets 23505 and the route turns it into
  // a 409. This is why there is no read-then-write check.
  await tx
    .insert(orderSessionTables)
    .values(allTableIds.map((id) => ({ sessionId: created.id, tableId: id })))

  await occupyTables(tx, allTableIds)

  await writeAuditEvent(tx, { sessionId: created.id, staffId, eventType: 'SESSION_OPENED' })

  // Seat 1, in the SAME transaction. AC-1 says a single-guest table needs no
  // setup, and a session that committed without a seat would be a session the
  // order screen cannot assign an item to.
  await createSeat(tx, { sessionId: created.id, seatLabel: 'Seat 1' })

  // Seating one party across several tables at once IS a merge, and AC-10 asks
  // for every merge to be auditable. SESSION_OPENED alone records that a session
  // began — not that it began on three tables. The join rows carry that fact,
  // but the event stream is what Epic 7's audit view reads, and without this it
  // could not answer "who put these tables together".
  if (additionalTableIds.length > 0) {
    await writeAuditEvent(tx, {
      sessionId: created.id,
      staffId,
      eventType: 'TABLE_MERGED',
      notes: additionalTableLabels.join(' + '),
    })
  }

  return created
}

/**
 * Opens a COUNTER sale — an order attached to no table at all (FR64).
 *
 * Separate from `openSession` on purpose. One function that "sometimes takes a
 * table" is exactly how the table-shaped assumptions leak back in: every guard
 * would need a null branch, and the invariants genuinely differ — a table
 * session must hold at least one table for its whole life, a counter session
 * must be able to hold none. They share `writeAuditEvent`, which is the part
 * that actually has to be identical.
 *
 * No unique constraint applies here, deliberately. `idx_one_open_session_per_table`
 * constrains TABLES; a counter session has none, so three customers buying at
 * the bar at once produce three open counter sessions and nothing serialises
 * them.
 */
export async function openCounterSession(
  tx: Tx,
  { tenantId, staffId }: { tenantId: string; staffId: string },
): Promise<{ id: string; openedAt: Date }> {
  const [created] = await tx
    .insert(orderSessions)
    // No tableId and no order_session_tables rows. `kind` is what makes this a
    // counter sale — never the absence of join rows, which a table session
    // passes through transiently while un-merging.
    .values({ tenantId, kind: 'counter', openedByStaffId: staffId })
    .returning({ id: orderSessions.id, openedAt: orderSessions.openedAt })

  await writeAuditEvent(tx, { sessionId: created.id, staffId, eventType: 'SESSION_OPENED' })

  // A counter sale gets a seat like anything else — two friends at the bar can
  // still want separate bills, and the order screen is the same screen.
  await createSeat(tx, { sessionId: created.id, seatLabel: 'Seat 1' })

  return created
}

/**
 * Locks a session row and asserts it is still open.
 *
 * `FOR UPDATE` on a row that does not match locks nothing and raises nothing —
 * it simply returns no rows. So a lock without the `closed_at` predicate is a
 * lock that cannot tell "open" from "closed" from "never existed", and every
 * guard built on it inherits that blindness. `deleteSeat` had exactly that hole
 * until the 4.3 review: a missing session read zero seats, tripped the
 * last-seat guard, and told the waiter "This is the only seat on the order."
 *
 * `attachTables` and `releaseTable` have carried the predicate all along. This
 * extracts the shape so a fourth caller cannot forget it.
 */
export async function lockOpenSession(tx: Tx, sessionId: string): Promise<void> {
  const [session] = await tx
    .select({ id: orderSessions.id })
    .from(orderSessions)
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
    .for('update')
    .limit(1)

  if (!session) throw new SessionAlreadyClosedError()
}

/**
 * The next free seat label for a session — "Seat 1", "Seat 2", …
 *
 * Derived from the COUNT of existing seats, then made safe by the unique index
 * rather than by this read. Two devices adding a seat at the same instant both
 * see the same count and both propose the same label; one commits, the other
 * takes a 23505 and retries. That is deliberate: this codebase decides races in
 * the database, and a pre-check that "looks" atomic is the exact defect Story
 * 3.9's review found in the last-table guard.
 */
export async function nextSeatLabel(tx: Tx, sessionId: string): Promise<string> {
  const rows = await tx
    .select({ seatLabel: seatSlots.seatLabel })
    .from(seatSlots)
    .where(eq(seatSlots.sessionId, sessionId))

  // The highest NUMBER used, not the row count — deleting Seat 2 of three must
  // not make the next seat "Seat 3" and collide with the one already there.
  const highest = rows.reduce((max, row) => {
    const match = /^Seat (\d+)$/.exec(row.seatLabel)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)

  return `Seat ${highest + 1}`
}

/**
 * Creates one seat.
 *
 * Shared by the route and by both session-open paths, so a seat created on open
 * and a seat created by a tap are the same row written the same way.
 */
export async function createSeat(
  tx: Tx,
  { sessionId, seatLabel, seatNote }: { sessionId: string; seatLabel: string; seatNote?: string | null },
): Promise<{ id: string; seatLabel: string; seatNote: string | null }> {
  const [created] = await tx
    .insert(seatSlots)
    .values({
      sessionId,
      seatLabel,
      // Trimmed, and empty becomes NULL — a cleared note must be genuinely
      // cleared, not an empty string the chip then renders as a blank pill.
      seatNote: seatNote?.trim() ? seatNote.trim() : null,
    })
    .returning({
      id: seatSlots.id,
      seatLabel: seatSlots.seatLabel,
      seatNote: seatSlots.seatNote,
    })

  return created
}

/**
 * Deletes a seat, refusing the three cases that would break the session.
 *
 * Every guard holds the SAME lock as the write, and they run in the order that
 * makes each refusal the TRUE one. Existence is checked before the last-seat
 * count: a seat id from another session is "no such seat" whether this session
 * has one seat or six, and answering it with "this is the only seat" — which is
 * what the pre-review ordering did — sends the waiter to fix the wrong thing.
 */
export async function deleteSeat(
  tx: Tx,
  { sessionId, seatId }: { sessionId: string; seatId: string },
): Promise<void> {
  // Locks the session AND asserts it is open, so two concurrent deletes
  // serialise and the second sees the count the first left behind.
  await lockOpenSession(tx, sessionId)

  const remaining = await tx
    .select({ id: seatSlots.id })
    .from(seatSlots)
    .where(eq(seatSlots.sessionId, sessionId))

  // One query answers both questions. Scoped to the session, so a seat id that
  // belongs to a different order simply is not in the list.
  if (!remaining.some((seat) => seat.id === seatId)) throw new SeatNotFoundError()

  if (remaining.length <= 1) throw new SessionNeedsASeatError()

  // `order_events` is APPEND-ONLY (migration 0001's trigger). If a seat with
  // items were deleted, the rows pointing at it could never be repaired — the
  // trigger refuses updates — and restoring the seat is impossible because it
  // would be a new row with a new id. The FK would refuse too, but a 500 tells
  // the waiter nothing; this tells them how many items are in the way.
  //
  // Counts EVERY event referencing the seat, not just ITEM_ADDED. That is
  // deliberate — a voided item's row still points here and would still be
  // orphaned — but it means the message will overstate the live item count once
  // Story 4.5 writes voids. Logged in deferred-work.md against 4.5.
  const [items] = await tx
    .select({ total: count() })
    .from(orderEvents)
    .where(eq(orderEvents.seatSlotId, seatId))

  const itemCount = Number(items?.total ?? 0)
  if (itemCount > 0) throw new SeatHasItemsError(itemCount)

  const removed = await tx
    .delete(seatSlots)
    .where(and(eq(seatSlots.id, seatId), eq(seatSlots.sessionId, sessionId)))
    .returning({ id: seatSlots.id })

  // Belt and braces: the existence check above already ran under the lock, so
  // this cannot fire. It exists so that no future edit can reintroduce a delete
  // that silently removes nothing and reports success.
  if (removed.length === 0) throw new SeatNotFoundError()
}

/**
 * Marks tables occupied, refusing if any went out of service first.
 *
 * Re-asserts `not unavailable` INSIDE the transaction: the status was read
 * before it opened, so a manager marking a table out of service in that gap
 * would otherwise be silently reverted — the attachment succeeds (the unique
 * index says nothing about tables.status) and this UPDATE writes 'occupied'
 * over their change, seating guests at a table taken out of service.
 */
async function occupyTables(tx: Tx, tableIds: string[]): Promise<void> {
  // A counter session attaches nothing. Guarded explicitly rather than relying
  // on `inArray(col, [])`, whose generated SQL is a Drizzle implementation
  // detail this code should not depend on.
  if (tableIds.length === 0) return

  const updated = await tx
    .update(tables)
    .set({ status: 'occupied' })
    .where(and(inArray(tables.id, tableIds), ne(tables.status, 'unavailable')))
    .returning({ id: tables.id })

  if (updated.length !== tableIds.length) {
    // At least one table is unavailable. Throwing rolls back the whole
    // transaction — the session, every attachment, and the audit row.
    throw new TableWentUnavailableError()
  }
}

/**
 * Attaches further tables to a session that is already open (AC-4).
 *
 * The order, its items and its audit trail are untouched — this only changes
 * which tables the party occupies.
 */
export async function attachTables(
  tx: Tx,
  {
    sessionId,
    tableIds,
    staffId,
    tableLabels,
  }: { sessionId: string; tableIds: string[]; staffId: string; tableLabels: string[] },
): Promise<void> {
  // Re-assert that the session is still OPEN, holding a row lock for the rest
  // of the transaction.
  //
  // The route read the session before this transaction began. Without this, a
  // close committing in that gap left the merge inserting an un-released
  // attachment against a CLOSED session and marking the table `occupied` — and
  // that table was then permanently stuck: close, un-merge and out-of-service
  // all refuse it (no open session / status is not `open`), and re-opening dies
  // on the unique index. Only SQL could recover it.
  //
  // FOR UPDATE also serialises against `closeSession`, which updates this same
  // row: whichever commits first, the loser sees the result rather than racing
  // past it.
  const [live] = await tx
    .select({ id: orderSessions.id, kind: orderSessions.kind })
    .from(orderSessions)
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
    .for('update')
    .limit(1)

  if (!live) throw new SessionAlreadyClosedError()

  // UPSERT, not a plain insert.
  //
  // The join row's primary key is (session_id, table_id), so a table that was
  // once part of THIS session already has a row — released, but present. A plain
  // insert hit that key and raised 23505, which the route reports as
  // BOTH_TABLES_OCCUPIED: "that table already has its own order". It does not.
  // The effect was that un-merging a table by mistake made it impossible to put
  // back, with a message describing a situation that was not happening.
  //
  // Re-attaching therefore REOPENS the existing row. The pair's attach/release
  // history is not kept here — order_events carries TABLE_MERGED and
  // TABLE_UNMERGED with the staff member and the labels, and that is the audit
  // trail. This table is current state.
  //
  // The partial unique index is untouched by this: a table attached to a
  // DIFFERENT open session has no primary-key conflict, so the insert proceeds
  // and violates `idx_one_open_session_per_table` instead — still a 23505, still
  // a 409, and now it means what it says.
  await tx
    .insert(orderSessionTables)
    .values(tableIds.map((id) => ({ sessionId, tableId: id })))
    .onConflictDoUpdate({
      target: [orderSessionTables.sessionId, orderSessionTables.tableId],
      set: { releasedAt: null, attachedAt: sql`now()` },
    })

  await occupyTables(tx, tableIds)

  // A counter sale whose guest sat down gains a PRIMARY TABLE — for breadcrumbs,
  // labels and ticket headers — but keeps `kind = 'counter'`, because that column
  // records where the order started, not what it currently occupies.
  //
  // Flipping it to 'table' here is what made seating a one-way door: the
  // last-table guard exempts only 'counter', so the guest who went back to the
  // bar could never be un-seated. See the note on `sessionKindEnum`.
  if (live.kind === 'counter') {
    await tx
      .update(orderSessions)
      .set({ tableId: tableIds[0] })
      .where(eq(orderSessions.id, sessionId))
  }

  await writeAuditEvent(tx, {
    sessionId,
    staffId,
    eventType: 'TABLE_MERGED',
    notes: tableLabels.join(' + '),
  })
}

/**
 * Releases one table from an open session (AC-7).
 *
 * `released_at` is the whole mechanism: it frees the table's slot in the partial
 * unique index and returns it to the floor, while the session and its order
 * continue on whatever tables remain.
 */
export async function releaseTable(
  tx: Tx,
  {
    sessionId,
    tableId,
    staffId,
    tableLabel,
  }: { sessionId: string; tableId: string; staffId: string; tableLabel: string },
): Promise<void> {
  // Lock the session, THEN count what is attached.
  //
  // The route did this itself in a separate transaction that closed before the
  // write began, so two devices releasing the two tables of a pair both read a
  // count of 2, both passed the guard, and both committed — leaving an open
  // session attached to nothing: invisible on the floor plan, unreachable from
  // any card, impossible to close through the UI, recoverable only by SQL. That
  // is exactly the orphan state the un-merge route's own doc comment claims to
  // prevent, and exactly the read-then-write this codebase refuses everywhere
  // else. Taking the lock first serialises the two callers so the second one
  // sees a count of 1 and is refused.
  // `isNull(closedAt)` matters, and so does the explicit missing-row branch.
  //
  // Without the filter a CLOSED session was happily locked and processed, unlike
  // `attachTables` directly above. And `locked?.kind !== 'counter'` sent a
  // MISSING row into the last-table guard — optional chaining makes it
  // `undefined`, which is not `'counter'` — so a session that no longer exists
  // read zero attachments and was reported as "this is the only table on the
  // order". Two paths that should agree on "no longer open" did not, and the
  // waiter got a story about the last table instead of the truth.
  const [locked] = await tx
    .select({ kind: orderSessions.kind })
    .from(orderSessions)
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
    .for('update')
    .limit(1)

  if (!locked) throw new SessionAlreadyClosedError()

  // The guard exists to stop a TABLE session becoming unreachable — no card, no
  // way to close it. A counter session is reachable without any table, so
  // releasing its last one is legitimate and must not be refused (AC-6).
  const wasCounter = locked.kind === 'counter'
  if (!wasCounter) {
    const attached = await attachedTableIds(tx, sessionId)
    if (attached.length <= 1) {
      throw new SessionNeedsATableError()
    }
  }

  const released = await tx
    .update(orderSessionTables)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(orderSessionTables.sessionId, sessionId),
        eq(orderSessionTables.tableId, tableId),
        isNull(orderSessionTables.releasedAt),
      ),
    )
    .returning({ tableId: orderSessionTables.tableId })

  if (released.length === 0) {
    throw new TableNotAttachedError()
  }

  await freeTables(tx, [tableId])

  // If the released table was the session's primary, promote another. Leaving a
  // stale primary would break breadcrumbs and ticket headers, which read
  // order_sessions.table_id directly.
  const [session] = await tx
    .select({ tableId: orderSessions.tableId })
    .from(orderSessions)
    .where(eq(orderSessions.id, sessionId))
    .limit(1)

  if (session?.tableId === tableId) {
    // SEATING IS REVERSIBLE — the guest went back to standing at the bar.
    //
    // A counter-origin session that has just released its last table has no
    // primary to promote and must not keep a stale one, or breadcrumbs and ticket
    // headers would name a table that is back on the floor. It returns to the
    // counter list, where it is reachable exactly as before it was seated.
    //
    // Only reachable for `kind = 'counter'`: a table-origin session is refused by
    // the guard above long before this, which is Story 3.8's AC-11 unchanged.
    if (wasCounter && (await attachedTableIds(tx, sessionId)).length === 0) {
      await tx
        .update(orderSessions)
        .set({ tableId: null })
        .where(eq(orderSessions.id, sessionId))
      return
    }

    // ORDERED. `LIMIT 1` alone returned whatever PostgreSQL happened to produce
    // first, and this value is user-visible — breadcrumbs and ticket headers
    // read `order_sessions.table_id` directly — so the same party could print
    // under different table names on two identical runs. Earliest attachment is
    // the meaningful choice: it is the table the party was seated at first.
    const [next] = await tx
      .select({ tableId: orderSessionTables.tableId })
      .from(orderSessionTables)
      .where(
        and(
          eq(orderSessionTables.sessionId, sessionId),
          isNull(orderSessionTables.releasedAt),
        ),
      )
      .orderBy(asc(orderSessionTables.attachedAt), asc(orderSessionTables.tableId))
      .limit(1)

    if (next) {
      await tx
        .update(orderSessions)
        .set({ tableId: next.tableId })
        .where(eq(orderSessions.id, sessionId))
    }
  }

  await writeAuditEvent(tx, {
    sessionId,
    staffId,
    eventType: 'TABLE_UNMERGED',
    notes: tableLabel,
  })
}

/**
 * Returns tables to `open`.
 *
 * `unavailable` is a property of the table, not the seating — a table taken out
 * of service while occupied must stay out of service after the party leaves.
 */
async function freeTables(tx: Tx, tableIds: string[]): Promise<void> {
  // Closing a counter session releases nothing — see occupyTables above.
  if (tableIds.length === 0) return

  await tx
    .update(tables)
    .set({ status: 'open' })
    .where(and(inArray(tables.id, tableIds), eq(tables.status, 'occupied')))
}

/** Every table currently attached to a session. */
export async function attachedTableIds(tx: Tx, sessionId: string): Promise<string[]> {
  const rows = await tx
    .select({ tableId: orderSessionTables.tableId })
    .from(orderSessionTables)
    .where(
      and(eq(orderSessionTables.sessionId, sessionId), isNull(orderSessionTables.releasedAt)),
    )

  return rows.map((r) => r.tableId)
}

/**
 * Closes a seating and returns the table to `open`.
 *
 * The UPDATE is conditional on `closed_at IS NULL` and the row count decides the
 * winner. The partial unique index does NOT help here — it constrains open
 * sessions, not closes — so this predicate is the entire concurrency control.
 * A read-then-write check would be a race.
 */
export async function closeSession(
  tx: Tx,
  {
    sessionId,
    staffId,
    reason,
  }: { sessionId: string; staffId: string; reason: SessionCloseReason },
): Promise<{ closedAt: Date; releasedTableIds: string[] }> {
  const closed = await tx
    .update(orderSessions)
    .set({ closedAt: new Date(), closedByStaffId: staffId })
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
    .returning({ closedAt: orderSessions.closedAt })

  if (closed.length === 0 || !closed[0].closedAt) {
    throw new SessionAlreadyClosedError()
  }

  // EVERY table in the group, not just the primary.
  //
  // This took a tableId argument before Story 3.8 and released exactly one
  // table. On a merged session that would have left the others occupied with no
  // session behind them — precisely the permanently-stuck state Story 3.6 was
  // written to eliminate. The tables come from the join table so the set is
  // always whatever is actually attached.
  const tableIds = await attachedTableIds(tx, sessionId)

  await tx
    .update(orderSessionTables)
    .set({ releasedAt: new Date() })
    .where(
      and(eq(orderSessionTables.sessionId, sessionId), isNull(orderSessionTables.releasedAt)),
    )

  await freeTables(tx, tableIds)

  await writeAuditEvent(tx, {
    sessionId,
    staffId,
    eventType: 'SESSION_CLOSED',
    notes: reason,
  })

  // The released set is RETURNED, not discarded.
  //
  // The caller has to emit one `table:status_changed` per released table, and
  // it has no other way to learn what they were — by the time it runs, the join
  // rows are released. Returning only `closedAt` meant the close route emitted
  // for the single table its URL named, so closing a merged group left every
  // other table in it occupied on every device except the one that acted, with
  // a stale sessionId and a running timer, until an unrelated refetch.
  return { closedAt: closed[0].closedAt, releasedTableIds: tableIds }
}

/** Raised when the transition is not open↔unavailable. */
export class InvalidAvailabilityTransitionError extends Error {}

/**
 * Takes a table out of service, or returns it.
 *
 * Availability is a property of the TABLE, not of any seating — which is why it
 * cannot be audited through `order_events` like opens and closes are: that table
 * requires a `session_id`, and a table being taken out of service has no
 * session. The history goes to `table_status_events` instead.
 *
 * Only `open ↔ unavailable` is legal here. An `occupied` table has guests at it
 * and must be closed or settled first — the caller returns 409 for that, and
 * this guard is the backstop if it ever forgets.
 */
export async function setTableAvailability(
  tx: Tx,
  {
    tableId,
    tenantId,
    staffId,
    toStatus,
    reason,
  }: {
    tableId: string
    tenantId: string
    staffId: string
    toStatus: 'open' | 'unavailable'
    reason: string | null
  },
  // Narrowed from the full status union: the transition is always open↔unavailable,
  // so `occupied` was advertising a case this function cannot produce. The
  // returned value is guaranteed accurate because the UPDATE predicate asserted
  // it before the row was written — a concurrent racer loses the UPDATE and
  // throws rather than being audited under a transition that never happened.
): Promise<{ fromStatus: 'open' | 'unavailable' }> {
  // The predicate carries the guard, so a concurrent change loses rather than
  // being silently overwritten — the same principle as closeSession's
  // `closed_at IS NULL`. A read-then-write check here would be a race.
  const fromStatus = toStatus === 'unavailable' ? 'open' : 'unavailable'

  const updated = await tx
    .update(tables)
    .set({
      status: toStatus,
      // Cleared on the way back in: the reason describes the current state, and
      // a stale one on an open table would be read as still applying.
      unavailableReason: toStatus === 'unavailable' ? reason : null,
    })
    .where(and(eq(tables.id, tableId), eq(tables.status, fromStatus)))
    .returning({ id: tables.id })

  if (updated.length === 0) {
    // The table was not in the status this transition starts from — occupied,
    // or already moved by another device.
    throw new InvalidAvailabilityTransitionError()
  }

  await tx.insert(tableStatusEvents).values({
    tenantId,
    tableId,
    staffId,
    fromStatus,
    toStatus,
    reason,
  })

  return { fromStatus }
}

/**
 * Appends one row to the audit trail, in the caller's transaction.
 *
 * `order_events` is append-only — 0001_append_only_rules.sql installs a BEFORE
 * UPDATE OR DELETE trigger. Corrections are made by inserting a compensating
 * record, never by mutation.
 *
 * `notes` carries the bare reason string and nothing else. Epic 7's audit view
 * and Epic 9's dashboard will filter on it, and a sentence is not filterable.
 */
async function writeAuditEvent(
  tx: Tx,
  {
    sessionId,
    staffId,
    eventType,
    notes,
  }: {
    sessionId: string
    staffId: string
    eventType: 'SESSION_OPENED' | 'SESSION_CLOSED' | 'TABLE_MERGED' | 'TABLE_UNMERGED'
    notes?: string
  },
): Promise<void> {
  await tx.insert(orderEvents).values({
    sessionId,
    staffId,
    eventType,
    // menuItemId stays null — this is a session-level event, not an item one.
    notes: notes ?? null,
  })
}
