# Story 1.3: Establish Database Schema & Migration Pipeline

Status: done

## Story

As a developer,
I want the complete Drizzle ORM schema defined with automated migrations on container startup and append-only constraints applied at the database layer,
so that the database structure is always correct when the app starts and audit records are protected from modification at the PostgreSQL level.

## Acceptance Criteria

1. **Given** `src/server/db/schema.ts` **When** a developer reviews the schema **Then** the following tables are defined: `tenants`, `staff`, `zones`, `tables`, `menu_categories`, `menu_items`, `order_sessions`, `order_events`, `payment_records`, `comp_records`, `dispute_records`, `printer_configs`, `station_configs`, `tenant_config`; each with appropriate columns, data types, and foreign key constraints

2. **Given** any monetary column in the schema (price, amount, total, subtotal) **When** the column type is inspected **Then** it is `integer` (paisa — LKR × 100) at every layer: schema definition, Drizzle types, and all application code; no `decimal`, `numeric`, or `float` type is used for money

3. **Given** a fresh Docker container start **When** the container entrypoint script runs before the Next.js process starts **Then** `drizzle-kit migrate` executes and applies all pending migrations in `src/server/db/migrations/` without operator action; if no pending migrations exist, the command exits cleanly

4. **Given** the append-only constraint migration has been applied **When** any process attempts an `UPDATE` or `DELETE` on a row in `order_events`, `payment_records`, `comp_records`, or `dispute_records` **Then** PostgreSQL rejects the operation with an error; the record remains unchanged; this holds for direct SQL queries, the ORM, and any database user

5. **Given** `src/server/db/index.ts` **When** the module initializes the connection pool **Then** `pg.Pool` is created with `max: parseInt(process.env.DATABASE_POOL_MAX ?? '10')` (NaN guard included); `DATABASE_POOL_MAX=20` is documented in `.env.example` with a comment explaining the recommended value

6. **Given** the migrations directory **When** it is inspected **Then** it contains at minimum two ordered migration files: initial schema creation and the append-only trigger application; both committed to the repository

## Tasks / Subtasks

- [x] Task 1: Write `src/server/db/schema.ts` with all 14 tables (AC: 1, 2)
  - [x] Import Drizzle pg-core primitives: `pgTable`, `pgEnum`, `uuid`, `text`, `integer`, `boolean`, `timestamp`, `index`
  - [x] Define four enums: `staffRoleEnum`, `orderEventTypeEnum`, `ticketOutputModeEnum`, `tableStatusEnum`
  - [x] Define `tenants` table — foundational; all other tables reference it via `tenant_id`
  - [x] Define `staff` table with `pin_hash text NOT NULL` (PIN stored hashed, never plaintext)
  - [x] Define `zones` and `tables` tables (tables references zones)
  - [x] Define `menu_categories` and `menu_items` tables — `price_paisa INTEGER` (no decimal/float)
  - [x] Define `order_sessions` table — `opened_by_staff_id`, `closed_by_staff_id` (nullable), `opened_at`, `closed_at` (nullable)
  - [x] Define APPEND-ONLY tables: `order_events`, `payment_records`, `comp_records`, `dispute_records` — no soft-delete columns, no updated_at
  - [x] Define `printer_configs`, `station_configs`, `tenant_config` configuration tables
  - [x] Add indexes for high-traffic FK columns: `session_id` on order_events, `tenant_id` on all tenant-scoped tables
  - [x] Verify `pnpm exec tsc --noEmit` passes with schema.ts in place

- [x] Task 2: Generate initial migration SQL via drizzle-kit (AC: 6)
  - [x] Run `pnpm drizzle-kit generate` — reads schema.ts, writes SQL to `src/server/db/migrations/`
  - [x] Inspect generated SQL file to confirm all 14 tables, columns, FKs, and indexes are present
  - [x] Confirm monetary columns use `INTEGER` (not NUMERIC or DECIMAL) in generated SQL
  - [x] Confirm enums are created as PostgreSQL `CREATE TYPE ... AS ENUM` statements

- [x] Task 3: Write append-only trigger migration manually (AC: 4, 6)
  - [x] Create `src/server/db/migrations/0001_append_only_rules.sql` as a hand-authored file (NOT drizzle-kit generated)
  - [x] Define `prevent_immutable_table_mutation()` PL/pgSQL function that raises EXCEPTION with table name and operation in the message
  - [x] Attach BEFORE UPDATE OR DELETE trigger on `order_events` → calls the function
  - [x] Attach BEFORE UPDATE OR DELETE trigger on `payment_records` → calls the function
  - [x] Attach BEFORE UPDATE OR DELETE trigger on `comp_records` → calls the function
  - [x] Attach BEFORE UPDATE OR DELETE trigger on `dispute_records` → calls the function
  - [x] Add the manual migration to drizzle-kit's journal file so it is tracked as applied

- [x] Task 4: Add migration scripts to package.json and create docker/scripts/migrate.sh (AC: 3)
  - [x] Add `"db:generate": "drizzle-kit generate"` to package.json scripts
  - [x] Add `"db:migrate": "drizzle-kit migrate"` to package.json scripts
  - [x] Create `docker/scripts/` directory
  - [x] Create `docker/scripts/migrate.sh` — thin shell script that runs `pnpm db:migrate`; exits non-zero on failure to halt container startup

- [x] Task 5: Verify AC5 and run end-to-end migration test (AC: 3, 4, 5)
  - [x] Confirm `src/server/db/index.ts` already has correct pool config with NaN guard (from Story 1.1 P5 patch — no change needed, just verify)
  - [x] Confirm `DATABASE_POOL_MAX=20` entry exists in `.env.example` with explanation comment (from Story 1.1 — verify present)
  - [x] Spin up a local test PostgreSQL: `docker run -d --name cdrms-test -e POSTGRES_PASSWORD=password -e POSTGRES_DB=cdrms -p 5432:5432 postgres:17-alpine`
  - [x] Run `DATABASE_URL=postgres://postgres:password@localhost:5432/cdrms pnpm db:migrate` and confirm both migrations apply cleanly
  - [x] Connect to DB and verify triggers: attempt `UPDATE order_events SET notes='x' WHERE false` → confirm error raised
  - [x] Stop and remove test container: `docker stop cdrms-test && docker rm cdrms-test`

### Review Findings (2026-06-21)

- [x] [Review][Decision→Patch] `dispute_records` trigger changed to DELETE-only (Option B applied) — The table has `resolved_by_staff_id`, `resolved_at`, and `resolution` columns that can only be written at resolution time, but the `BEFORE UPDATE` trigger blocks all mutations. A dispute inserted with those fields NULL can never be updated to mark it resolved. Two options: (A) drop the three resolution columns from `dispute_records` and design resolution tracking in Story 7.x; (B) remove `dispute_records` from the append-only trigger list and allow UPDATEs on it. [src/server/db/schema.ts:168, src/server/db/migrations/0001_append_only_rules.sql]

- [x] [Review][Patch] No partial unique index prevents multiple concurrent open sessions per table — FIXED: `uniqueIndex(...).where(sql\`${t.closedAt} IS NULL\`)` added; generated in migration 0002 — `order_sessions` has no constraint on `(table_id) WHERE closed_at IS NULL`; two waiters can simultaneously open sessions on the same table, splitting order history and corrupting bill totals. [src/server/db/schema.ts:108]

- [x] [Review][Patch] `payment_records.method` is unconstrained `text` — FIXED: `paymentMethodEnum('cash','card','transfer')` added; column converted in migration 0002 — typos (`'Csh'`, `'CASH'`) are permanently stored in an append-only table with no correction path; payment method grouping in reports silently fragments. Must be a `pgEnum`. [src/server/db/schema.ts:143]

- [x] [Review][Patch] `station_configs.type` is unconstrained `text` — FIXED: `stationTypeEnum('kitchen','bar')` added; column converted in migration 0002 — an unrecognised value silently breaks kitchen/bar ticket routing with no DB-level rejection. Must be a `pgEnum`. [src/server/db/schema.ts:194]

- [x] [Review][Patch] `0001_append_only_rules.sql` trigger creation is non-idempotent — FIXED: all triggers use `CREATE OR REPLACE TRIGGER`; idempotent re-run verified — `CREATE TRIGGER` fails on re-run (CI reset, fresh deploy over partial migration); use `CREATE OR REPLACE TRIGGER` (PostgreSQL 14+ / 17 supported). [src/server/db/migrations/0001_append_only_rules.sql]

- [x] [Review][Defer] Missing CHECK constraints for positive/range integers (`cover_count >= 1`, `quantity > 0`, `amount_paisa > 0`, `portion_count IS NULL OR portion_count > 0`, `port BETWEEN 1 AND 65535`) — deferred, application-layer Zod validation per architecture; adding CHECKs to append-only tables is irreversible
- [x] [Review][Defer] `taxRatePercent` no `CHECK (tax_rate_percent BETWEEN 0 AND 10000)` — deferred, tax config belongs to Story 10.x
- [x] [Review][Defer] `migrate.sh` has no `pg_isready` health check before running migrations — deferred, Docker Compose `depends_on` health check is Story 1.4
- [x] [Review][Defer] `TRUNCATE` bypasses BEFORE row-level triggers on append-only tables — deferred, TRUNCATE privilege should be revoked from the app DB user in Story 1.4
- [x] [Review][Defer] `updatedAt` on `tenant_config` not auto-refreshed on UPDATE (no ON UPDATE trigger) — deferred, Story 10.x tenant config management
- [x] [Review][Defer] No unique constraint on `(tenant_id, label)` in `tables` and `(tenant_id, name)` in `zones` — deferred, Story 3.x zone/table CRUD will enforce at the application layer
- [x] [Review][Defer] `orderEvents.menuItemId` nullable with no enforcement that it is non-null for item-type events — deferred, application-layer Zod validation per architecture
- [x] [Review][Defer] `order_sessions.closedAt` could be earlier than `openedAt` — deferred, application-layer validation
- [x] [Review][Defer] No `onDelete`/`onUpdate` referential action on any FK (all default NO ACTION) — deferred, intentional per architecture; cascade semantics designed when tenant offboarding (Story 10.x) is implemented
- [x] [Review][Defer] `brandColor` stored as unconstrained `text` — deferred, input validated at API layer (Story 10.x)
- [x] [Review][Defer] `drizzle.config.ts` `DATABASE_URL!` non-null assertion — deferred, already tracked in deferred-work.md from Story 1.1 CR
- [x] [Review][Defer] `db:generate` and `db:migrate` scripts rely on implicit config resolution (no `--config` flag) — deferred, drizzle.config.ts at root makes this low-risk
- [x] [Review][Defer] `compRecords.amountPaysa` has no positivity constraint — deferred, application-layer Zod validation per architecture

## Dev Notes

### ⚠️ Critical: This is the most deferred-work-sensitive story in Epic 1

Story 1.1 created `drizzle.config.ts`, `src/server/db/index.ts`, and the empty `src/server/db/migrations/` directory (with `.gitkeep`). This story FILLS those stubs. Do NOT re-create or overwrite files that already exist correctly — check first.

**What already exists and is correct — DO NOT TOUCH:**
- `drizzle.config.ts` — correct, points to schema.ts and migrations/
- `src/server/db/index.ts` — correct pool config with NaN guard (Story 1.1 P5 patch)
- `.env.example` — already has `DATABASE_POOL_MAX=20` entry
- `src/server/db/migrations/.gitkeep` — delete this when first migration is generated

**What Story 1.3 creates (new files only):**
- `src/server/db/schema.ts` — NEW
- `src/server/db/migrations/0000_*.sql` — generated by drizzle-kit
- `src/server/db/migrations/0001_append_only_rules.sql` — hand-authored
- `src/server/db/migrations/meta/_journal.json` — managed by drizzle-kit (also update for manual migration)
- `docker/scripts/migrate.sh` — NEW
- `docker/scripts/` directory — NEW

---

### Schema Design: All 14 Tables

**Drizzle ORM version: 0.45.2 — use this exact import style:**

```typescript
import {
  pgTable, pgEnum,
  uuid, text, integer, boolean, timestamp,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core'
```

**Enums (define before tables that use them):**

```typescript
export const staffRoleEnum = pgEnum('staff_role', ['waiter', 'owner', 'kitchen'])

export const orderEventTypeEnum = pgEnum('order_event_type', [
  'SESSION_OPENED', 'SESSION_CLOSED',
  'ITEM_ADDED', 'ITEM_REMOVED', 'ITEM_MODIFIED',
  'ORDER_SENT_TO_KITCHEN', 'ORDER_SENT_TO_BAR',
  'ITEM_COMPED', 'ITEM_VOIDED',
  'PAYMENT_REQUESTED', 'SESSION_SETTLED',
])

export const ticketOutputModeEnum = pgEnum('ticket_output_mode', ['print', 'kds', 'both'])

export const tableStatusEnum = pgEnum('table_status', ['open', 'occupied', 'unavailable'])
```

**Table definitions — COMPLETE reference:**

```typescript
// ── Foundation ────────────────────────────────────────────────────────────────

export const tenants = pgTable('tenants', {
  id:        uuid('id').primaryKey().defaultRandom(),
  name:      text('name').notNull(),
  timezone:  text('timezone').notNull().default('Asia/Colombo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const staff = pgTable('staff', {
  id:       uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name:     text('name').notNull(),
  role:     staffRoleEnum('role').notNull(),
  pinHash:  text('pin_hash').notNull(),     // bcrypt hash — NEVER store plaintext PIN
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_staff_tenant_id').on(t.tenantId),
])

export const zones = pgTable('zones', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
  name:         text('name').notNull(),        // "Beach", "Rooftop", "Poolside"
  displayOrder: integer('display_order').notNull().default(0),
  isActive:     boolean('is_active').notNull().default(true),
}, (t) => [
  index('idx_zones_tenant_id').on(t.tenantId),
])

export const tables = pgTable('tables', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull().references(() => tenants.id),
  zoneId:       uuid('zone_id').notNull().references(() => zones.id),
  label:        text('label').notNull(),       // "T1", "SB3", "Rooftop Bar"
  status:       tableStatusEnum('status').notNull().default('open'),
  capacity:     integer('capacity'),           // null = no fixed capacity
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
  pricePaysa:       integer('price_paisa').notNull(),  // LKR × 100 — NEVER decimal
  portionCount:     integer('portion_count'),           // null = unlimited
  isAvailable:      boolean('is_available').notNull().default(true),
  ticketOutputMode: ticketOutputModeEnum('ticket_output_mode').notNull().default('print'),
  displayOrder:     integer('display_order').notNull().default(0),
}, (t) => [
  index('idx_menu_items_tenant_id').on(t.tenantId),
  index('idx_menu_items_category_id').on(t.categoryId),
])

// ── Orders ────────────────────────────────────────────────────────────────────

export const orderSessions = pgTable('order_sessions', {
  id:                uuid('id').primaryKey().defaultRandom(),
  tenantId:          uuid('tenant_id').notNull().references(() => tenants.id),
  tableId:           uuid('table_id').notNull().references(() => tables.id),
  openedByStaffId:   uuid('opened_by_staff_id').notNull().references(() => staff.id),
  closedByStaffId:   uuid('closed_by_staff_id').references(() => staff.id),  // null until closed
  openedAt:          timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt:          timestamp('closed_at', { withTimezone: true }),           // null until closed
  coverCount:        integer('cover_count').notNull().default(1),
}, (t) => [
  index('idx_order_sessions_tenant_id').on(t.tenantId),
  index('idx_order_sessions_table_id').on(t.tableId),
])

// ── APPEND-ONLY tables — PostgreSQL BEFORE triggers prevent UPDATE/DELETE ─────
// DO NOT add updated_at, soft_delete, or any mutable column to these tables.
// Corrections are made by inserting new compensating records, never by modifying existing ones.

export const orderEvents = pgTable('order_events', {
  id:             uuid('id').primaryKey().defaultRandom(),
  sessionId:      uuid('session_id').notNull().references(() => orderSessions.id),
  staffId:        uuid('staff_id').notNull().references(() => staff.id),
  menuItemId:     uuid('menu_item_id').references(() => menuItems.id),   // null for session-level events
  eventType:      orderEventTypeEnum('event_type').notNull(),
  seatSlot:       integer('seat_slot'),               // null = unassigned seat
  quantity:       integer('quantity').notNull().default(1),
  unitPricePaysa: integer('unit_price_paisa'),         // price snapshot at event time (paisa)
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
  amountPaysa:      integer('amount_paisa').notNull(),   // LKR × 100
  method:           text('method').notNull(),             // 'cash' | 'card' | 'transfer'
  coveredSeatSlots: text('covered_seat_slots'),           // JSON: null = full session; "[1,2]" = specific seats
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
  amountPaysa:         integer('amount_paisa').notNull(),  // LKR × 100 — comped amount
  reason:              text('reason').notNull(),
  createdAt:           timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_comp_records_session_id').on(t.sessionId),
])

export const disputeRecords = pgTable('dispute_records', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  sessionId:          uuid('session_id').notNull().references(() => orderSessions.id),
  raisedByStaffId:    uuid('raised_by_staff_id').notNull().references(() => staff.id),
  resolvedByStaffId:  uuid('resolved_by_staff_id').references(() => staff.id),  // null until resolved
  description:        text('description').notNull(),
  resolution:         text('resolution'),                // null until resolved
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt:         timestamp('resolved_at', { withTimezone: true }),           // null until resolved
}, (t) => [
  index('idx_dispute_records_session_id').on(t.sessionId),
])

// ── Configuration ─────────────────────────────────────────────────────────────

export const printerConfigs = pgTable('printer_configs', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tenantId:  uuid('tenant_id').notNull().references(() => tenants.id),
  name:      text('name').notNull(),          // "Kitchen Printer", "Bar Printer"
  ipAddress: text('ip_address').notNull(),
  port:      integer('port').notNull().default(9100),
  isActive:  boolean('is_active').notNull().default(true),
}, (t) => [
  index('idx_printer_configs_tenant_id').on(t.tenantId),
])

export const stationConfigs = pgTable('station_configs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  tenantId:        uuid('tenant_id').notNull().references(() => tenants.id),
  name:            text('name').notNull(),    // "Kitchen KDS", "Bar KDS"
  type:            text('type').notNull(),    // 'kitchen' | 'bar'
  printerConfigId: uuid('printer_config_id').references(() => printerConfigs.id),
  isActive:        boolean('is_active').notNull().default(true),
}, (t) => [
  index('idx_station_configs_tenant_id').on(t.tenantId),
])

export const tenantConfig = pgTable('tenant_config', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tenantId:       uuid('tenant_id').notNull().references(() => tenants.id),
  restaurantName: text('restaurant_name').notNull(),
  brandColor:     text('brand_color').notNull().default('#2288B4'),   // hex — post-MVP: configurable per tenant
  currencyCode:   text('currency_code').notNull().default('LKR'),
  taxRatePercent: integer('tax_rate_percent').notNull().default(0),   // 18 = 18%; stored as whole percent integer
  updatedAt:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('idx_tenant_config_tenant_id').on(t.tenantId),
])
```

---

### What Is NOT in This Story's Schema

- **`sessions` table** — for staff auth sessions (`session_id`, `staff_id`, `role`, `last_active_at`, `expires_at`). Added in Story 2.2 (session middleware). When Story 2.2 adds this table to schema.ts, a delta migration will be generated.
- **`sync_state` table** — for post-MVP cloud sync cursor tracking. Not included.
- No `created_by` / `updated_by` / `deleted_at` soft-delete patterns on any table. Audit is done via `order_events` append-only log.

---

### Money Rule — Strictly Integer (Paisa)

```typescript
// CORRECT — price_paisa: integer (LKR × 100)
pricePaysa: integer('price_paisa').notNull()   // 24850 = LKR 248.50

// WRONG — never use these column types for money
// priceDecimal: decimal('price')   ← forbidden
// priceNumeric: numeric('price')   ← forbidden
// priceFloat:   real('price')      ← forbidden
```

Display conversion (only at the UI layer):
```typescript
const displayPrice = (paisa: number) => `LKR ${(paisa / 100).toFixed(2)}`
```

---

### drizzle-kit generate — How It Works

`drizzle-kit generate` reads `schema.ts`, diffs against the current migration state (tracked in `meta/_journal.json`), and generates a new SQL file. It does NOT need a live database connection.

```bash
pnpm drizzle-kit generate
# → writes src/server/db/migrations/0000_{name}.sql
# → writes src/server/db/migrations/meta/_journal.json
# → writes src/server/db/migrations/meta/0000_snapshot.json
```

Remove `.gitkeep` from `migrations/` before or after running generate — it will be overwritten.

**After generate, inspect the SQL file to verify:**
- All enums created with `CREATE TYPE ... AS ENUM`
- All 14 tables present
- All `price_paisa`, `amount_paisa`, `unit_price_paisa` columns are `INTEGER` (not `NUMERIC`)
- Foreign key constraints present

---

### Append-Only Trigger Migration (Manual File)

The generated migration does NOT create the append-only triggers. Write `0001_append_only_rules.sql` manually:

```sql
-- 0001_append_only_rules.sql
-- Append-only enforcement: BEFORE triggers on audit/financial tables
-- PostgreSQL rejects UPDATE and DELETE with a descriptive error.
-- This is a database-layer guarantee independent of application code.

CREATE OR REPLACE FUNCTION prevent_immutable_table_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '[immutable-table] % on % is not permitted. Insert a compensating record instead.',
    TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER immutable_order_events
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE TRIGGER immutable_payment_records
  BEFORE UPDATE OR DELETE ON payment_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE TRIGGER immutable_comp_records
  BEFORE UPDATE OR DELETE ON comp_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();

CREATE TRIGGER immutable_dispute_records
  BEFORE UPDATE OR DELETE ON dispute_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
```

**CRITICAL — Update the drizzle-kit journal** so it knows about this manual migration. After drizzle-kit generates `0000_*.sql`, the `meta/_journal.json` contains one entry. Add `0001_append_only_rules` as a second entry manually. The journal format:

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": <timestamp>,
      "tag": "0000_initial_schema",
      "breakpoints": true
    },
    {
      "idx": 1,
      "version": "7",
      "when": <timestamp>,
      "tag": "0001_append_only_rules",
      "breakpoints": true
    }
  ]
}
```

Use the actual tag name from `0000_*.sql` for the first entry. Use the current Unix timestamp (milliseconds) for `when` in the second entry.

---

### Why BEFORE Trigger Instead of PostgreSQL RULE

The architecture mentions "PostgreSQL RULE." PostgreSQL RULEs with `DO INSTEAD NOTHING` silently swallow the operation — they do NOT raise an error. The AC explicitly requires an error to be raised. BEFORE triggers with `RAISE EXCEPTION` are the correct PostgreSQL mechanism for enforced rejection with an error message. This is the standard industry pattern for append-only tables.

---

### docker/scripts/migrate.sh

```bash
#!/bin/sh
set -e

echo "[migrate] Applying database migrations..."
pnpm db:migrate
echo "[migrate] Migrations complete."
```

`set -e` ensures the container start halts if migrations fail. The Docker entrypoint (Story 1.4) will call this script before launching `pnpm start`.

Make the script executable: `chmod +x docker/scripts/migrate.sh` (on Linux/Mac) — on Windows, Git tracks the executable bit; do `git update-index --chmod=+x docker/scripts/migrate.sh` if needed.

---

### package.json Scripts to Add

Add to the existing `scripts` block:

```json
"db:generate": "drizzle-kit generate",
"db:migrate":  "drizzle-kit migrate"
```

Do NOT add `db:push` — push is dev-only and bypasses the migration file pipeline. All schema changes must go through `generate` → commit migration → `migrate`.

---

### Local Test PostgreSQL (for Task 5 verification)

You need a running PostgreSQL to test migrations. Without Docker Compose (Story 1.4), use a throwaway container:

```bash
# Start test DB
docker run -d \
  --name cdrms-test \
  -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=cdrms \
  -p 5432:5432 \
  postgres:17-alpine

# Run migrations
DATABASE_URL=postgres://postgres:password@localhost:5432/cdrms pnpm db:migrate

# Verify triggers work — should raise an error:
# (use any UUID that exists, or insert a test row first)
docker exec -it cdrms-test psql -U postgres -d cdrms \
  -c "INSERT INTO tenants(name) VALUES ('Test');" \
  -c "UPDATE tenants SET name='X';"  # this is fine, tenants is mutable
  # then test an append-only table:
  # INSERT first, then try UPDATE — should get the trigger error

# Clean up
docker stop cdrms-test && docker rm cdrms-test
```

---

### Drizzle v0.45 — Index Syntax (second argument array form)

Drizzle ORM 0.45 uses the **array form** for indexes (not the object form from v0.32 and earlier):

```typescript
// ✅ CORRECT — v0.45 array form
export const myTable = pgTable('my_table', { ... }, (t) => [
  index('idx_name').on(t.column),
  uniqueIndex('idx_unique').on(t.column),
])

// ❌ WRONG — v0.28 object form (no longer works in 0.45)
export const myTable = pgTable('my_table', { ... }, (t) => ({
  idx: index('idx_name').on(t.column),
}))
```

---

### Existing Files — Verify but Do Not Change

**`drizzle.config.ts` (already correct):**
```typescript
import { defineConfig } from 'drizzle-kit'
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

**`src/server/db/index.ts` (already correct — Story 1.1 P5 patch):**
```typescript
const poolMax = parseInt(process.env.DATABASE_POOL_MAX ?? '10', 10)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isNaN(poolMax) ? 10 : poolMax,
})
```

**`.env.example` (verify this line exists):**
```
DATABASE_POOL_MAX=20   # recommended for single-restaurant deployment (default: 10)
```

If the line is present → AC5 passes, no change needed.
If missing → add it (unlikely — it was added in Story 1.1).

---

### AC3 Partial Deferral

AC3 requires the container entrypoint to call `drizzle-kit migrate` before Next.js starts. The `docker/scripts/migrate.sh` script is created in this story, but its integration into the container entrypoint is Story 1.4 (Docker Compose & Dockerfile). Story 1.3 delivers the script and verifies it works locally via the throwaway Docker postgres. Full end-to-end container verification is in Story 1.4.

---

### Story 1.1 & 1.2 Learnings Carried Forward

- **pnpm 11 `allowBuilds`**: No new build-script packages in this story — no pnpm-workspace.yaml changes needed.
- **`drizzle-kit` is a devDependency**: `pnpm db:generate` and `pnpm db:migrate` require `drizzle-kit` installed. In Docker (Story 1.4), devDependencies must be present at migration time. Noted for Story 1.4 Dockerfile design.
- **`drizzle.config.ts` `!` assertion**: The `DATABASE_URL!` non-null assertion in drizzle.config.ts is flagged in deferred-work.md (D7 from Story 1.1 CR). Do not "fix" it in this story — it is a known acceptable deferral until CI/CD.
- **`server-only` boundary**: `src/server/db/schema.ts` and `src/server/db/index.ts` are under `src/server/` — they must NEVER be imported by client components. The `server-only` guard in `index.ts` already enforces this. `schema.ts` does not need `server-only` because it exports pure TypeScript types that Route Handlers import; however it should never appear in any `'use client'` file.
- **TypeScript strict mode**: All schema columns use explicit `.notNull()` or leave nullable deliberately. Drizzle infers the TypeScript type from nullability — `text('col').notNull()` → `string`, `text('col')` → `string | null`. This is load-bearing — do not add `.notNull()` where null IS valid (e.g., `closedAt`, `closedByStaffId`).

---

### Naming Conventions (from architecture)

```
Tables:   plural snake_case   → order_events, menu_items, staff
Columns:  snake_case          → staff_id, created_at, price_paisa
FKs:      {singular}_id       → session_id, tenant_id, staff_id
Indexes:  idx_{table}_{col}   → idx_order_events_session_id
Enums:    snake_case name      → staff_role, order_event_type
```

Drizzle TypeScript keys use `camelCase` (e.g., `sessionId`, `createdAt`) — Drizzle maps these to the `snake_case` column names automatically via the string argument.

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (2026-06-21)

### Debug Log References

- **Migration port conflict**: Used port 5433 (not 5432) for throwaway Docker container to avoid collision with any local PostgreSQL. `DATABASE_URL` set with port 5433 for the migration test run.
- **`.gitkeep` auto-removed**: `pnpm drizzle-kit generate` replaced the `.gitkeep` placeholder with actual migration files — no manual deletion needed.
- **Journal timestamp**: Manual migration entry in `_journal.json` uses `when: 1782027900000` (epoch ms, ~78 seconds after migration 0000). Drizzle-kit uses this for ordering only; the exact value is not critical.

### Completion Notes List

- **AC1 ✅** — All 14 tables defined in `src/server/db/schema.ts` with Drizzle v0.45 array-form index syntax. 4 enums: `staff_role`, `order_event_type`, `ticket_output_mode`, `table_status`.
- **AC2 ✅** — All monetary columns (`price_paisa`, `amount_paisa`, `unit_price_paisa`) use `integer` in schema.ts and `INTEGER` in generated SQL. Zero decimal/numeric/float columns.
- **AC3 ✅ (partial — container integration deferred to Story 1.4)** — `docker/scripts/migrate.sh` created with `set -e`. `db:generate` and `db:migrate` scripts added to `package.json`. Both migrations apply cleanly via `pnpm db:migrate` against `postgres:17-alpine`.
- **AC4 ✅** — `0001_append_only_rules.sql` creates `prevent_immutable_table_mutation()` trigger function and 8 BEFORE triggers (UPDATE+DELETE on each of the 4 append-only tables). Verified: `UPDATE order_events` and `DELETE FROM order_events` both produce `ERROR: [immutable-table] ... is not permitted`.
- **AC5 ✅** — `src/server/db/index.ts` already correct from Story 1.1 P5 patch (`NaN` guard at line 13). `.env.example` has `DATABASE_POOL_MAX=20` with comment. No changes made.
- **AC6 ✅** — Two ordered migration files committed: `0000_plain_eternity.sql` (drizzle-kit generated) and `0001_append_only_rules.sql` (hand-authored). Journal updated with both entries.
- **TypeScript** — `pnpm exec tsc --noEmit` exits 0 both before and after schema.ts creation.
- **`sessions` table** — NOT added. Belongs to Story 2.2 (auth). When added, `drizzle-kit generate` will create a delta migration.

### File List

- `src/server/db/schema.ts` — NEW: Complete Drizzle ORM schema, 14 tables, 4 enums
- `src/server/db/migrations/0000_plain_eternity.sql` — NEW: Generated initial schema SQL (drizzle-kit)
- `src/server/db/migrations/0001_append_only_rules.sql` — NEW: Hand-authored append-only trigger migration
- `src/server/db/migrations/meta/_journal.json` — MODIFIED: Added entry for migration 0001
- `src/server/db/migrations/meta/0000_snapshot.json` — NEW: Drizzle-kit schema snapshot (auto-generated)
- `docker/scripts/migrate.sh` — NEW: Container entrypoint migration script
- `package.json` — MODIFIED: Added `db:generate` and `db:migrate` scripts
