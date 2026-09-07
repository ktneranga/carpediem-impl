import 'server-only'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { orderEvents, orderSessions, tables } from '@/server/db/schema'
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

/**
 * Opens a seating on a table.
 *
 * Caller is responsible for having checked the table exists and is not
 * `unavailable`, and for catching the unique-violation that enforces
 * one-open-session-per-table. This function owns the writes, not the policy.
 */
export async function openSession(
  tx: Tx,
  { tableId, tenantId, staffId }: { tableId: string; tenantId: string; staffId: string },
): Promise<{ id: string; openedAt: Date }> {
  const [created] = await tx
    .insert(orderSessions)
    .values({ tenantId, tableId, openedByStaffId: staffId })
    .returning({ id: orderSessions.id, openedAt: orderSessions.openedAt })

  // Re-assert `not unavailable` inside the transaction.
  //
  // The status was read before the transaction opened, so a manager marking the
  // table out of service in that gap would otherwise be silently reverted: the
  // insert succeeds (the partial unique index says nothing about tables.status)
  // and this UPDATE writes 'occupied' over their change, seating guests at a
  // table taken out of service.
  const updated = await tx
    .update(tables)
    .set({ status: 'occupied' })
    .where(and(eq(tables.id, tableId), ne(tables.status, 'unavailable')))
    .returning({ id: tables.id })

  if (updated.length === 0) {
    // Throwing rolls back the session insert too, which is what we want.
    throw new TableWentUnavailableError()
  }

  await writeAuditEvent(tx, { sessionId: created.id, staffId, eventType: 'SESSION_OPENED' })

  return created
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
    tableId,
    staffId,
    reason,
  }: { sessionId: string; tableId: string; staffId: string; reason: SessionCloseReason },
): Promise<{ closedAt: Date }> {
  const closed = await tx
    .update(orderSessions)
    .set({ closedAt: new Date(), closedByStaffId: staffId })
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))
    .returning({ closedAt: orderSessions.closedAt })

  if (closed.length === 0 || !closed[0].closedAt) {
    throw new SessionAlreadyClosedError()
  }

  // `unavailable` is a property of the table, not the seating — a table taken
  // out of service while occupied must stay out of service after the party
  // leaves. Only an occupied table returns to open.
  await tx
    .update(tables)
    .set({ status: 'open' })
    .where(and(eq(tables.id, tableId), eq(tables.status, 'occupied')))

  await writeAuditEvent(tx, {
    sessionId,
    staffId,
    eventType: 'SESSION_CLOSED',
    notes: reason,
  })

  return { closedAt: closed[0].closedAt }
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
    eventType: 'SESSION_OPENED' | 'SESSION_CLOSED'
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
