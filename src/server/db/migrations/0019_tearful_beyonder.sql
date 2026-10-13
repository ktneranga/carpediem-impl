-- Story 6.2 code review (2026-10-13) — three fixes.
--
-- ── 1. A bill's ITEMISATION becomes a snapshot too ──────────────────────────
-- `bill_lines` stored only `amount_paisa`; the dish name and seat label were
-- read by joining `menu_items` and `seat_slots` when the bill was rendered. So
-- the money was immutable and the words were not: renaming a dish rewrote it on
-- every historical bill, and deleting one made a real charge render as
-- "Unknown item" — on the document Epic 7 shows a customer in a dispute.
--
-- ── 2. Migration 0018's seed UPDATEs were unscoped ──────────────────────────
-- 0018 ran `UPDATE tenant_config SET financial_action_reauth = false;` with no
-- WHERE at all, and `SET service_charge_bp = 1000 WHERE service_charge_bp = 0`,
-- which matched every row because the column had just been created DEFAULT 0.
-- Both encoded one restaurant's decision as a global data change. 0018 is left
-- exactly as it was applied — editing a migration this database already ran
-- would diverge the file from the live schema with nothing to detect it — so
-- the correction is here, scoped by tenant name.
--
-- ── 3. financial_action_reauth defaults FALSE ───────────────────────────────
-- A `true` default meant any tenant_config row created from now on demanded a
-- fresh PIN that nothing can collect: Story 2.4 owns that prompt and is
-- deferred. The route would refuse every bill with no way forward.

-- Nullable first, backfilled, then constrained. A plain `ADD COLUMN ... NOT
-- NULL` fails against bill_lines that already exist.
ALTER TABLE "bill_lines" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "seat_label" text;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "modifier_text" text;--> statement-breakpoint

-- Backfill from the join these columns replace. This is the last moment the
-- join is trustworthy — it is correct for rows written before today, because
-- nothing has had the chance to rename a dish since they were billed.
--
-- The trigger is disabled for exactly this statement: `bill_lines` is
-- append-only and a backfill is an UPDATE. Re-enabled below, in the same
-- transaction, so a failure here rolls the whole migration back rather than
-- leaving the table writable.
ALTER TABLE "bill_lines" DISABLE TRIGGER "immutable_bill_lines";--> statement-breakpoint
UPDATE "bill_lines" bl
   SET "name"          = coalesce(mi."name", 'Unknown item'),
       "seat_label"    = ss."seat_label",
       "modifier_text" = oe."modifier_text"
  FROM "order_events" oe
  LEFT JOIN "menu_items" mi ON mi."id" = oe."menu_item_id"
  LEFT JOIN "seat_slots" ss ON ss."id" = oe."seat_slot_id"
 WHERE oe."id" = bl."order_event_id";--> statement-breakpoint
ALTER TABLE "bill_lines" ENABLE TRIGGER "immutable_bill_lines";--> statement-breakpoint

-- Any row the join could not resolve would be a bill_line pointing at a missing
-- order_event, which the foreign key forbids. Belt and braces before NOT NULL.
UPDATE "bill_lines" SET "name" = 'Unknown item' WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "tenant_config" ALTER COLUMN "financial_action_reauth" SET DEFAULT false;--> statement-breakpoint

-- Scoped to the restaurant the decision was made for, replacing 0018's
-- unscoped writes. Carpe Diem charges 10% service (Teran, 2026-10-02) and runs
-- the demo with re-auth off (Teran, 2026-10-02, option 1).
UPDATE "tenant_config" SET "service_charge_bp" = 1000
 WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "name" = 'Carpe Diem');--> statement-breakpoint
UPDATE "tenant_config" SET "financial_action_reauth" = false
 WHERE "tenant_id" IN (SELECT "id" FROM "tenants" WHERE "name" = 'Carpe Diem');
