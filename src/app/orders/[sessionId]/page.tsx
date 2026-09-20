import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { dishCount } from '@/server/orders/item-count'
import { z } from 'zod'
import { db } from '@/server/db'
import { loadSubmittedRounds } from '@/server/orders/submitted-rounds'
import {
  orderEvents,
  orderSessions,
  orderSessionTables,
  seatSlots,
  staff,
  tables,
  tenantConfig,
  zones,
} from '@/server/db/schema'
import { OrderScreen } from '@/components/pos/order-screen'

/**
 * Order entry screen, addressed by SESSION.
 *
 * ── Why this replaced `/tables/[tableId]` ────────────────────────────────────
 * The old page began `.from(tables)` and INNER JOINed its way to the session, so
 * a counter sale (FR64) — a session with no table at all — could never be
 * returned by it. Not "was not handled": could not be expressed. Every route in
 * the system was addressed by table, which is why Story 3.9 was sequenced before
 * Epic 4 rather than after: five more order screens built on that assumption
 * would all have needed retrofitting.
 *
 * The query is inverted accordingly. It starts at the session and LEFT joins
 * outward to whatever tables it happens to occupy — none, one, or a merged
 * group.
 *
 * ── Structure divergence ─────────────────────────────────────────────────────
 * architecture.md:741 places order entry inside a `(waiter)` route group. No
 * route groups exist yet — src/app is flat — so this sits at the plain path, the
 * same divergence the previous page recorded. Whoever adds the groups moves this
 * and `/tables/[tableId]` together.
 */
export default async function OrderPage({
  params,
}: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = await params

  // Validate the shape before it reaches PostgreSQL. `order_sessions.id` is a
  // uuid column, so a malformed segment raises 22P02 mid-query — and with no
  // error.tsx anywhere under src/app that throw becomes a full-page server
  // error rather than the redirect this route already has for a stale bookmark.
  if (!z.string().uuid().safeParse(sessionId).success) redirect('/')

  const headersList = await headers()
  const staffId = headersList.get('x-staff-id')

  // LEFT joins from the session outward. A counter sale returns exactly one row
  // with nulls for the table columns; a merged group returns one row per table,
  // and we take the primary for the heading.
  const rows = await db
    .select({
      sessionId: orderSessions.id,
      openedAt: orderSessions.openedAt,
      coverCount: orderSessions.coverCount,
      kind: orderSessions.kind,
      primaryTableId: orderSessions.tableId,
      tableId: tables.id,
      tableLabel: tables.label,
      capacity: tables.capacity,
      zoneName: zones.name,
    })
    .from(orderSessions)
    .leftJoin(
      orderSessionTables,
      and(
        eq(orderSessionTables.sessionId, orderSessions.id),
        isNull(orderSessionTables.releasedAt),
      ),
    )
    .leftJoin(tables, eq(tables.id, orderSessionTables.tableId))
    .leftJoin(zones, eq(zones.id, tables.zoneId))
    .where(and(eq(orderSessions.id, sessionId), isNull(orderSessions.closedAt)))

  // No open session — closed by another device, or a bookmarked URL from a
  // finished sitting. Back to the floor rather than an order screen with nothing
  // behind it.
  if (rows.length === 0) redirect('/')

  const session = rows[0]

  // The heading names the primary table for a table order, and every table when
  // the party is merged. `order_sessions.table_id` is the primary; if it is not
  // among the attached rows (it was un-merged and a new primary promoted), fall
  // back to the first row rather than showing nothing.
  const attached = rows.filter((row) => row.tableId !== null)
  const primary = attached.find((row) => row.tableId === session.primaryTableId) ?? attached[0]

  const groupLabels = attached
    .map((row) => row.tableLabel)
    .filter((label): label is string => label !== null)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const tableLabel =
    groupLabels.length > 1 ? groupLabels.join(' + ') : (primary?.tableLabel ?? null)

  // Summed across a merged group, exactly as the floor card does it.
  const capacity = attached.reduce<number | null>(
    (total, row) => (row.capacity == null ? total : (total ?? 0) + row.capacity),
    null,
  )

  const [staffRow] = staffId
    ? await db.select({ name: staff.name }).from(staff).where(eq(staff.id, staffId)).limit(1)
    : []

  const [config] = await db
    .select({ taxRatePercent: tenantConfig.taxRatePercent })
    .from(tenantConfig)
    .limit(1)

  // Drives which close reasons the screen offers, and the walkout message's
  // count. DISHES — the sum of ITEM_ADDED quantities (`dishCount`) — not rows;
  // ITEM_REMOVED is not subtracted because nothing writes it yet. Every
  // "items" figure in the app uses the same expression.
  const [items] = await db
    .select({ total: dishCount })
    .from(orderEvents)
    .where(and(eq(orderEvents.sessionId, session.sessionId), eq(orderEvents.eventType, 'ITEM_ADDED')))

  // Seats come with the page, not from a fetch the screen makes after mounting.
  // That is what makes AC-5 true on a second tablet: the seats are in the first
  // paint, so a waiter who picks up another device sees the party as it stands
  // rather than an empty row that fills in a moment later.
  //
  // Keyed on the SESSION, so a merged group across three tables has one seat
  // list and a counter sale has seats like anything else (Decision 2).
  const seats = await db
    .select({
      id: seatSlots.id,
      seatLabel: seatSlots.seatLabel,
      seatNote: seatSlots.seatNote,
    })
    .from(seatSlots)
    .where(eq(seatSlots.sessionId, session.sessionId))
    // STABLE order, so a seat never moves under a waiter's finger. Not strictly
    // creation order — `created_at` is transaction time, so seats written in one
    // transaction tie and fall back to uuid order. Matches the GET route's
    // ordering exactly, which is the property that actually matters: the server
    // render and any later refetch must agree.
    .orderBy(asc(seatSlots.createdAt), asc(seatSlots.id))

  // Already-submitted items, grouped by round, so AC-6's read-only history is
  // in the FIRST paint. The same function backs `GET .../orders`, so this render
  // and a later refetch cannot disagree about order or grouping.
  const submittedRounds = await loadSubmittedRounds(session.sessionId)

  return (
    <OrderScreen
      // Keyed by session. Every piece of screen state — the selected seat, an
      // open note editor, the modifier sheet — belongs to ONE order, and
      // without a key a route change from one session to another would reuse
      // the component and carry that state onto the wrong table.
      key={session.sessionId}
      sessionId={session.sessionId}
      staffName={staffRow?.name ?? 'Unknown'}
      zoneName={primary?.zoneName ?? null}
      tableLabel={tableLabel}
      capacity={capacity}
      coverCount={session.coverCount}
      openedAt={session.openedAt.toISOString()}
      itemCount={Number(items?.total ?? 0)}
      seats={seats}
      submittedRounds={submittedRounds}
      taxRatePercent={config?.taxRatePercent ?? 0}
    />
  )
}
