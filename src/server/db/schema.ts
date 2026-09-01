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
])

export const ticketOutputModeEnum = pgEnum('ticket_output_mode', ['print', 'kds', 'both'])

export const tableStatusEnum = pgEnum('table_status', ['open', 'occupied', 'unavailable'])

export const paymentMethodEnum = pgEnum('payment_method', ['cash', 'card', 'transfer'])

export const stationTypeEnum = pgEnum('station_type', ['kitchen', 'bar'])

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
}, (t) => [
  index('idx_tables_tenant_id').on(t.tenantId),
  index('idx_tables_zone_id').on(t.zoneId),
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
  pricePaysa:       integer('price_paisa').notNull(),
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
  tableId:          uuid('table_id').notNull().references(() => tables.id),
  openedByStaffId:  uuid('opened_by_staff_id').notNull().references(() => staff.id),
  closedByStaffId:  uuid('closed_by_staff_id').references(() => staff.id),
  openedAt:         timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt:         timestamp('closed_at', { withTimezone: true }),
  coverCount:       integer('cover_count').notNull().default(1),
}, (t) => [
  index('idx_order_sessions_tenant_id').on(t.tenantId),
  index('idx_order_sessions_table_id').on(t.tableId),
  uniqueIndex('idx_order_sessions_one_open_per_table').on(t.tableId).where(sql`${t.closedAt} IS NULL`),
])

// ── Append-only tables ────────────────────────────────────────────────────────
// PostgreSQL BEFORE triggers (0001_append_only_rules.sql) prevent UPDATE/DELETE.
// Corrections are made by inserting compensating records — never by mutation.

export const orderEvents = pgTable('order_events', {
  id:             uuid('id').primaryKey().defaultRandom(),
  sessionId:      uuid('session_id').notNull().references(() => orderSessions.id),
  staffId:        uuid('staff_id').notNull().references(() => staff.id),
  menuItemId:     uuid('menu_item_id').references(() => menuItems.id),
  eventType:      orderEventTypeEnum('event_type').notNull(),
  seatSlot:       integer('seat_slot'),
  quantity:       integer('quantity').notNull().default(1),
  unitPricePaysa: integer('unit_price_paisa'),
  notes:          text('notes'),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_order_events_session_id').on(t.sessionId),
  index('idx_order_events_staff_id').on(t.staffId),
  index('idx_order_events_created_at').on(t.createdAt),
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
