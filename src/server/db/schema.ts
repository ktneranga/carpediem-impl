import { sql } from 'drizzle-orm'
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core'

// ── Enums ─────────────────────────────────────────────────────────────────────

export const staffRoleEnum = pgEnum('staff_role', ['waiter', 'owner', 'kitchen'])

export const orderEventTypeEnum = pgEnum('order_event_type', [
  'SESSION_OPENED',
  'SESSION_CLOSED',
  'ITEM_ADDED',
  'ITEM_REMOVED',
  'ITEM_MODIFIED',
  'ORDER_SENT_TO_KITCHEN',
  'ORDER_SENT_TO_BAR',
  'ITEM_COMPED',
  'ITEM_VOIDED',
  'PAYMENT_REQUESTED',
  'SESSION_SETTLED',
  // Added in Story 3.8. A merge is an order-level event — it changes which
  // tables one party occupies — so it belongs here rather than in
  // table_status_events, which records availability and has no session.
  'TABLE_MERGED',
  'TABLE_UNMERGED',
])

export const ticketOutputModeEnum = pgEnum('ticket_output_mode', ['print', 'kds', 'both'])

export const tableStatusEnum = pgEnum('table_status', ['open', 'occupied', 'unavailable'])

/**
 * Where an order STARTED — at tables, or at the counter with none (FR64).
 *
 * ── Origin, not current state ────────────────────────────────────────────────
 * `kind` is set once, when the session is created, and never changes. A counter
 * sale whose guest later sits down keeps `kind = 'counter'` and simply gains
 * rows in `order_session_tables`; what it currently occupies is that join table's
 * job, and always was.
 *
 * It was briefly written the other way — flipped to `'table'` on seating — and
 * that made seating a one-way door: `releaseTable` exempts only `'counter'` from
 * the last-table guard, so a guest who bought at the bar, sat down, then went
 * back to the bar could not be un-seated, and the table stayed occupied until the
 * bill settled. Reading it as origin makes the exemption mean what it says and
 * costs nothing else.
 *
 * ── Why a COLUMN and not an inference ────────────────────────────────────────
 * Never infer "counter" from having zero attached rows: a table session passes
 * through zero transiently while un-merging, so a race could silently reclassify
 * a real table order. Epic 9 also wants counter revenue separated, which is a
 * GROUP BY on a column — and on origin, which is the honest basis for that split.
 */
export const sessionKindEnum = pgEnum('session_kind', ['table', 'counter'])

export const paymentMethodEnum = pgEnum('payment_method', ['cash', 'card', 'transfer'])

export const stationTypeEnum = pgEnum('station_type', ['kitchen', 'bar'])

/**
 * Where an ordered item is PRODUCED — FR9's three destinations.
 *
 * ── Why this is not `station_type` ───────────────────────────────────────────
 * `stationTypeEnum` above types a station's CONFIGURATION — which printer it
 * owns, whether it prints or shows a KDS — and is `['kitchen','bar']`. This types
 * an ITEM's routing, and FR9 names three destinations. They are different facts
 * about different rows, and conflating them is how a pizza KOT would end up
 * printing at the bar.
 *
 * That `station_type` still lacks `pizza_kitchen` is a real gap, left alone here
 * deliberately: it belongs to Epic 5's ticket generation and Epic 10's station
 * configuration, which must reconcile the two. Logged in deferred-work.md.
 */
export const productionDestinationEnum = pgEnum('production_destination', [
  'kitchen',
  'pizza_kitchen',
  'bar',
])

export const authModeEnum = pgEnum('auth_mode', [
  'session_short',
  'session_persistent',
  'per_transaction',
  'per_action',
])

// ── Foundation ────────────────────────────────────────────────────────────────

export const tenants = pgTable('tenants', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      text('name').notNull(),
  timezone:  text('timezone').notNull().default('Asia/Colombo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const staff = pgTable('staff', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tenantId:  uuid('tenant_id').notNull().references(() => tenants.id),
  name:      text('name').notNull(),
  role:      staffRoleEnum('role').notNull(),
  pinHash:   text('pin_hash').notNull(),
  isActive:  boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_staff_tenant_id').on(t.tenantId),
])

/**
 * Authentication sessions — proof that a staff member entered their PIN on a device.
 *
 * NOT to be confused with `order_sessions`, which records a TABLE being occupied
 * for the duration of a meal. Two unrelated concepts; the distinct names are
 * deliberate. Architecture calls this table `sessions`; renamed to `staff_sessions`
 * to remove the collision risk.
 *
 * MUTABLE by design — `last_active_at` is written on every request and rows are
 * deleted on logout. This table must NEVER receive the append-only RULE applied
 * to the audit tables in migration 0001.
 */
export const staffSessions = pgTable('staff_sessions', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
  staffId:      uuid('staff_id').notNull().references(() => staff.id),
  // Role is denormalised onto the session on purpose: Story 2.3's middleware runs
  // on every request and must not join to `staff` each time.
  role:         staffRoleEnum('role').notNull(),
  createdAt:    timestamp('created_at',     { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt:    timestamp('expires_at',     { withTimezone: true }).notNull(),
}, (t) => [
  index('idx_staff_sessions_staff_id').on(t.staffId),
  index('idx_staff_sessions_expires_at').on(t.expiresAt),
])

export const zones = pgTable('zones', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
  name:         text('name').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  isActive:     boolean('is_active').notNull().default(true),
}, (t) => [
  index('idx_zones_tenant_id').on(t.tenantId),
])

export const tables = pgTable('tables', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
  zoneId:       uuid('zone_id').notNull().references(() => zones.id),
  label:        text('label').notNull(),
  status:       tableStatusEnum('status').notNull().default('open'),
  capacity:     integer('capacity'),
  displayOrder: integer('display_order').notNull().default(0),
  /**
   * Why this table is out of service — "Cover torn", "Sun bed broken".
   *
   * Null whenever status is not `unavailable`; cleared on return to service.
   * This is the current state only; the history lives in table_status_events.
   */
  unavailableReason: text('unavailable_reason'),
}, (t) => [
  index('idx_tables_tenant_id').on(t.tenantId),
  index('idx_tables_zone_id').on(t.zoneId),
])

/**
 * Availability history for tables — append-only.
 *
 * A separate table because every other audit table in this schema hangs off a
 * session (`order_events`, `payment_records`, `comp_records`, `dispute_records`
 * all carry a notNull `session_id`), and a table taken out of service has no
 * session — that is the precondition. Relaxing `order_events.session_id` to
 * nullable would have weakened a core invariant for every order event in order
 * to accommodate one event that is not an order event at all.
 *
 * Protected by the same BEFORE UPDATE OR DELETE trigger as the other audit
 * tables (0005_table_status_events_append_only.sql). An availability log that
 * can be edited is not a log.
 */
export const tableStatusEvents = pgTable('table_status_events', {
  id:         uuid('id').primaryKey().defaultRandom(),
  tenantId:   uuid('tenant_id').notNull().references(() => tenants.id),
  tableId:    uuid('table_id').notNull().references(() => tables.id),
  staffId:    uuid('staff_id').notNull().references(() => staff.id),
  fromStatus: tableStatusEnum('from_status').notNull(),
  toStatus:   tableStatusEnum('to_status').notNull(),
  /** Required going out of service, null coming back in. */
  reason:     text('reason'),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_table_status_events_table_id').on(t.tableId),
  index('idx_table_status_events_created_at').on(t.createdAt),
])

// ── Menu ──────────────────────────────────────────────────────────────────────

export const menuCategories = pgTable('menu_categories', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
  name:         text('name').notNull(),
  displayOrder: integer('display_order').notNull().default(0),
  isActive:     boolean('is_active').notNull().default(true),
}, (t) => [
  index('idx_menu_categories_tenant_id').on(t.tenantId),
])

export const menuItems = pgTable('menu_items', {
  id:               uuid('id').primaryKey().defaultRandom(),
  tenantId:         uuid('tenant_id').notNull().references(() => tenants.id),
  categoryId:       uuid('category_id').notNull().references(() => menuCategories.id),
  name:             text('name').notNull(),
  // `pricePaisa`, not `pricePaysa`. The COLUMN was always `price_paisa`; only
  // this TypeScript key was misspelled, nothing read it yet, and Story 4.2 puts
  // the name into the `/api/menu` contract — so it was fixed before it spread.
  pricePaisa:       integer('price_paisa').notNull(),
  /**
   * A photograph of the dish. Nullable, and usually null.
   *
   * `ux-design-specification.md:411` ruled product images out entirely — "No
   * product images. Practical constraint for SaaS — restaurants configure their
   * own menus and cannot be expected to photograph 100+ items." Teran reversed
   * that on 2026-09-12 for the card redesign.
   *
   * The original constraint is still true, which is why this is OPTIONAL and why
   * the card's category-icon tile is a designed fallback rather than an error
   * state: a restaurant that photographs nothing gets a menu that still looks
   * deliberate, and one that photographs its best dishes gets those.
   */
  imageUrl:         text('image_url'),
  // FR9. Defaulted so the column can be NOT NULL on a table that already has
  // rows; the seed sets it explicitly per item.
  productionDestination: productionDestinationEnum('production_destination')
    .notNull()
    .default('kitchen'),
  portionCount:     integer('portion_count'),
  isAvailable:      boolean('is_available').notNull().default(true),
  ticketOutputMode: ticketOutputModeEnum('ticket_output_mode').notNull().default('print'),
  displayOrder:     integer('display_order').notNull().default(0),
}, (t) => [
  index('idx_menu_items_tenant_id').on(t.tenantId),
  index('idx_menu_items_category_id').on(t.categoryId),
])

// ── Orders ────────────────────────────────────────────────────────────────────

export const orderSessions = pgTable('order_sessions', {
  id:               uuid('id').primaryKey().defaultRandom(),
  tenantId:         uuid('tenant_id').notNull().references(() => tenants.id),
  // NULLABLE since Story 3.9. A counter sale is attached to no table at all.
  // For a table session this remains the PRIMARY table — breadcrumbs, labels and
  // ticket headers — with every table it occupies in order_session_tables.
  tableId:          uuid('table_id').references(() => tables.id),
  kind:             sessionKindEnum('kind').notNull().default('table'),
  openedByStaffId:  uuid('opened_by_staff_id').notNull().references(() => staff.id),
  closedByStaffId:  uuid('closed_by_staff_id').references(() => staff.id),
  openedAt:         timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt:         timestamp('closed_at', { withTimezone: true }),
  coverCount:       integer('cover_count').notNull().default(1),
}, (t) => [
  index('idx_order_sessions_tenant_id').on(t.tenantId),
  index('idx_order_sessions_table_id').on(t.tableId),
  // `idx_order_sessions_one_open_per_table` USED to live here, on table_id where
  // closed_at IS NULL. It moved to order_session_tables in Story 3.8: once a
  // session can span several tables, this column is only the PRIMARY table, and
  // a partial index here could not see the others. A partial index also cannot
  // reach into another table to ask whether a session is open, which is why the
  // join row carries its own `released_at`.
])

/**
 * Which tables a seating occupies. One row per table, including the primary.
 *
 * A party can be seated across several tables within one zone (FR62). Keeping
 * ONE session and mapping it to N tables means orders, bills, payments and the
 * audit trail — all of which key on `session_id` — work unchanged. Linked
 * sessions would have meant fanning out across a group on every read, in
 * application code, forever.
 *
 * `released_at` is what makes the invariant self-contained: the partial unique
 * index below is the single source of "one open session per table", and setting
 * `released_at` is both how un-merge works and how a close releases a group.
 */
export const orderSessionTables = pgTable('order_session_tables', {
  sessionId:  uuid('session_id').notNull().references(() => orderSessions.id),
  tableId:    uuid('table_id').notNull().references(() => tables.id),
  attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.sessionId, t.tableId] }),
  // THE concurrency control for seating. Two devices racing to seat the same
  // table both insert; PostgreSQL serialises them, one commits, the other raises
  // 23505 and the route turns that into a 409. Never a read-then-write check.
  //
  // The name is referenced in code — see OPEN_SESSION_INDEX in
  // src/app/api/tables/[tableId]/sessions/route.ts. Renaming it here without
  // updating that constant turns every concurrent tap into a 500, silently.
  uniqueIndex('idx_one_open_session_per_table').on(t.tableId).where(sql`${t.releasedAt} IS NULL`),
  index('idx_order_session_tables_session_id').on(t.sessionId),
])

// ── Append-only tables ────────────────────────────────────────────────────────
// PostgreSQL BEFORE triggers (0001_append_only_rules.sql) prevent UPDATE/DELETE.
// Corrections are made by inserting compensating records — never by mutation.

/**
 * A person on an order — the unit a bill can be split by (FR10).
 *
 * ── Why a table and not the integer that used to live on order_events ────────
 * `order_events.seat_slot` was a bare `integer`. An integer cannot be renamed,
 * cannot be deleted, and cannot be referenced by a bill — and Story 4.5 writes
 * `seat_slot_id` on every event, while Epic 6.4 bills a seat by id
 * (`POST /api/sessions/:sessionId/seats/:seatId/bill`). Converted while
 * `order_events` held 14 rows and none had a seat value; every story that writes
 * items would have made it more expensive.
 *
 * ── Why session_id and not table_id ──────────────────────────────────────────
 * FR10 says "seat slots on a single table", which predates merged tables and
 * counter sales. A merged group is ONE session across several tables and shares
 * one seat list — "Seat 4" is one person, not one per table — and a counter sale
 * has no table at all yet two friends at the bar can still want separate bills.
 */
export const seatSlots = pgTable('seat_slots', {
  id:        uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => orderSessions.id),
  seatLabel: text('seat_label').notNull(),
  /**
   * How staff recognise the person: "red shirt", "curly hair", "bald man".
   *
   * A waiter cannot ask four strangers their names, so this is the memory aid
   * that makes a seat a person. It renders on the seat chips and belongs on the
   * kitchen ticket, where it tells the runner who to hand the plate to.
   *
   * It must NEVER appear on a guest-facing bill. Handing someone a slip reading
   * "Bald man · LKR 2,400" is a bad thirty seconds. Teran's decision,
   * 2026-09-12; recorded against Epic 6 in deferred-work.md so whoever builds
   * bill generation receives it as a requirement.
   *
   * No length CHECK: the 40-character cap is a UI affordance, and a constraint
   * here would turn a waiter's long typo into a 500 mid-service.
   */
  seatNote:  text('seat_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_seat_slots_session_id').on(t.sessionId),
  // What actually stops two devices both creating "Seat 2". The label is derived
  // server-side and a collision is caught as 23505, then retried — the database
  // decides this race, as it decides every other race in this codebase.
  // Only the LABEL is unique: two people in red shirts is not an error.
  uniqueIndex('idx_seat_slots_session_label').on(t.sessionId, t.seatLabel),
])

export const orderEvents = pgTable('order_events', {
  id:             uuid('id').primaryKey().defaultRandom(),
  sessionId:      uuid('session_id').notNull().references(() => orderSessions.id),
  staffId:        uuid('staff_id').notNull().references(() => staff.id),
  menuItemId:     uuid('menu_item_id').references(() => menuItems.id),
  eventType:      orderEventTypeEnum('event_type').notNull(),
  // Was `seatSlot: integer('seat_slot')`. See the note on `seatSlots` above for
  // why identity was needed. Nullable: an event that is not an item — a session
  // opening, a table merging — belongs to no seat.
  seatSlotId:     uuid('seat_slot_id').references(() => seatSlots.id),
  quantity:       integer('quantity').notNull().default(1),
  // `unitPricePaisa`, not `unitPricePaysa`. The column was always
  // `unit_price_paisa`; only the key was misspelled, nothing reads it, and
  // Story 4.5 is about to write to it. Same fix Story 4.2 made on menu_items.
  unitPricePaisa: integer('unit_price_paisa'),
  /**
   * Audit PROSE for session-level events — not item data.
   *
   * `"B1 + B3"` on TABLE_MERGED, `"walkout"` on SESSION_CLOSED, the table label
   * on TABLE_UNMERGED. Story 4.3's notes floated reusing this for an item's
   * modifier text; it cannot be, because Epic 7's dispute timeline reads both
   * kinds of row in one query and renders them side by side to a customer. One
   * column carrying two meanings discriminated only by `event_type` is a query
   * nobody can read correctly. `modifierText` below is the item's field.
   */
  notes:          text('notes'),
  /**
   * The waiter's free-text modifier — "no ice", "extra spicy" (FR8).
   *
   * Free TEXT, deliberately. `ux:427` describes structured modifier groups
   * ("Spice: Mild / Medium / Hot") and `ux:59` per-waiter pinned shortcuts, but
   * FR8 asks only for "modifiers or special instructions", the epic's own
   * examples are free text, and no modifier model exists anywhere in this
   * schema. The structured version is logged against Epic 10 (menu management)
   * in deferred-work.md rather than invented here.
   */
  modifierText:   text('modifier_text'),
  /**
   * Which round of this session's ordering an ITEM belongs to.
   *
   * 1 for the first submission, 2 after "Add More Items", and so on.
   *
   * ── Nullable on purpose, and never defaulted ────────────────────────────────
   * Session-level audit rows — SESSION_OPENED, TABLE_MERGED, SESSION_CLOSED —
   * belong to no round and leave this null. `notNull().default(1)` would stamp
   * every one of them as part of round 1, and Epic 7 shows these rows TO A
   * CUSTOMER during a bill dispute. A merge event claiming to belong to a round
   * nobody ordered in is a fabricated fact, and this table is append-only: the
   * trigger from migration 0001 refuses UPDATE, so it could never be corrected.
   *
   * ── How the next round number is derived (Story 4.5 writes it) ─────────────
   * `max(round_number) + 1` for the session, derived INSIDE the submit
   * transaction, under a `FOR UPDATE` on the session row — `lockOpenSession` in
   * table-session.service.ts already does exactly that lock and is exported.
   *
   * This is the same race the seat labels had: two waiters submitting to one
   * session at the same moment both read "the last round was 1" and both write
   * round 2. Story 4.5 AC-4 requires that neither set of items is lost or
   * duplicated. Holding the session lock serialises them — which is what made
   * concurrent Add Seat calls stop colliding entirely once 4.3's review moved
   * that lock inside the transaction. Do not pre-check and hope.
   */
  roundNumber:    integer('round_number'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_order_events_session_id').on(t.sessionId),
  index('idx_order_events_staff_id').on(t.staffId),
  index('idx_order_events_created_at').on(t.createdAt),
  index('idx_order_events_seat_slot_id').on(t.seatSlotId),
  // The history view groups by exactly this pair, and so do Story 4.5's
  // round derivation, Epic 5's `Table 7 · Round 2` ticket header and Epic 7's
  // per-round dispute timeline.
  index('idx_order_events_session_round').on(t.sessionId, t.roundNumber),
])

export const paymentRecords = pgTable('payment_records', {
  id:               uuid('id').primaryKey().defaultRandom(),
  sessionId:        uuid('session_id').notNull().references(() => orderSessions.id),
  staffId:          uuid('staff_id').notNull().references(() => staff.id),
  amountPaysa:      integer('amount_paisa').notNull(),
  method:           paymentMethodEnum('method').notNull(),
  coveredSeatSlots: text('covered_seat_slots'),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_payment_records_session_id').on(t.sessionId),
])

export const compRecords = pgTable('comp_records', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  sessionId:           uuid('session_id').notNull().references(() => orderSessions.id),
  orderEventId:        uuid('order_event_id').notNull().references(() => orderEvents.id),
  staffId:             uuid('staff_id').notNull().references(() => staff.id),
  authorizedByStaffId: uuid('authorized_by_staff_id').notNull().references(() => staff.id),
  amountPaysa:         integer('amount_paisa').notNull(),
  reason:              text('reason').notNull(),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_comp_records_session_id').on(t.sessionId),
])

export const disputeRecords = pgTable('dispute_records', {
  id:                uuid('id').primaryKey().defaultRandom(),
  sessionId:         uuid('session_id').notNull().references(() => orderSessions.id),
  raisedByStaffId:   uuid('raised_by_staff_id').notNull().references(() => staff.id),
  resolvedByStaffId: uuid('resolved_by_staff_id').references(() => staff.id),
  description:       text('description').notNull(),
  resolution:        text('resolution'),
  createdAt:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt:        timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  index('idx_dispute_records_session_id').on(t.sessionId),
])

// ── Configuration ─────────────────────────────────────────────────────────────

export const printerConfigs = pgTable('printer_configs', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tenantId:  uuid('tenant_id').notNull().references(() => tenants.id),
  name:      text('name').notNull(),
  ipAddress: text('ip_address').notNull(),
  port:      integer('port').notNull().default(9100),
  isActive:  boolean('is_active').notNull().default(true),
}, (t) => [
  index('idx_printer_configs_tenant_id').on(t.tenantId),
])

export const stationConfigs = pgTable('station_configs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  tenantId:        uuid('tenant_id').notNull().references(() => tenants.id),
  name:            text('name').notNull(),
  type:            stationTypeEnum('type').notNull(),
  printerConfigId: uuid('printer_config_id').references(() => printerConfigs.id),
  isActive:        boolean('is_active').notNull().default(true),
}, (t) => [
  index('idx_station_configs_tenant_id').on(t.tenantId),
])

export const tenantConfig = pgTable('tenant_config', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tenantId:       uuid('tenant_id').notNull().references(() => tenants.id),
  restaurantName: text('restaurant_name').notNull(),
  brandColor:     text('brand_color').notNull().default('#2288B4'),
  currencyCode:   text('currency_code').notNull().default('LKR'),
  taxRatePercent: integer('tax_rate_percent').notNull().default(0),

  // ── Auth feature flags (prd.md:304-310) ───────────────────────────────────
  // NOTE: NFR-S6 states a 30-minute idle timeout while the PRD's flag table
  // specifies 5. The flag table wins — it is what tenant provisioning reads and
  // Carpe Diem's row is explicitly 5. The NFR-S6 mismatch is recorded for the PRD.
  authMode:              authModeEnum('auth_mode').notNull().default('session_short'),
  sessionTimeoutMinutes: integer('session_timeout_minutes').notNull().default(5),
  financialActionReauth: boolean('financial_action_reauth').notNull().default(true),

  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('idx_tenant_config_tenant_id').on(t.tenantId),
])
