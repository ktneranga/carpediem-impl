-- Story 6.2 — bills, their lines, and the service-charge rate.
--
-- ── A bill is a SNAPSHOT ────────────────────────────────────────────────────
-- The money and the RATES used are stored, not recomputed on read: a bill
-- handed to a guest must not change when a menu price or the service rate does.
--
-- ── No status column, on purpose ────────────────────────────────────────────
-- "Open" means the payments recorded against a bill sum to less than its total.
-- Story 6.5 answers that once payment_records gains bill_id. A mutable status
-- would be a second source of truth about whether money is owed.
--
-- ── service_charge_bp is BASIS POINTS ───────────────────────────────────────
-- 1000 = 10.00%. tax_rate_percent next to it is an integer percent and cannot
-- express SSCL's 2.5%; that limitation is not worth inheriting twice.

CREATE TYPE "public"."bill_type" AS ENUM('consolidated', 'seat');--> statement-breakpoint
CREATE TABLE "bill_comps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"comp_record_id" uuid NOT NULL,
	"amount_paisa" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"order_event_id" uuid NOT NULL,
	"amount_paisa" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"type" "bill_type" NOT NULL,
	"subtotal_paisa" integer NOT NULL,
	"service_charge_paisa" integer NOT NULL,
	"tax_paisa" integer NOT NULL,
	"total_paisa" integer NOT NULL,
	"service_charge_bp" integer NOT NULL,
	"tax_bp" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "service_charge_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_comps" ADD CONSTRAINT "bill_comps_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_comps" ADD CONSTRAINT "bill_comps_comp_record_id_comp_records_id_fk" FOREIGN KEY ("comp_record_id") REFERENCES "public"."comp_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_order_event_id_order_events_id_fk" FOREIGN KEY ("order_event_id") REFERENCES "public"."order_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bill_comps_comp_record" ON "bill_comps" USING btree ("comp_record_id");--> statement-breakpoint
CREATE INDEX "idx_bill_comps_bill_id" ON "bill_comps" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bill_lines_order_event" ON "bill_lines" USING btree ("order_event_id");--> statement-breakpoint
CREATE INDEX "idx_bill_lines_bill_id" ON "bill_lines" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "idx_bills_session_id" ON "bills" USING btree ("session_id");
--> statement-breakpoint
-- ── Append-only, exactly like order_events and payment_records ──────────────
-- A bill is a financial fact. Correcting one is a new record (Epic 7), never an
-- UPDATE. Note the contrast with print_jobs, which deliberately has NO trigger
-- because it is working state.
CREATE OR REPLACE TRIGGER immutable_bills
  BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();--> statement-breakpoint
CREATE OR REPLACE TRIGGER immutable_bill_lines
  BEFORE UPDATE OR DELETE ON bill_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();--> statement-breakpoint
CREATE OR REPLACE TRIGGER immutable_bill_comps
  BEFORE UPDATE OR DELETE ON bill_comps
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();--> statement-breakpoint

-- Carpe Diem charges 10% service. Seeded here rather than left at 0 so the
-- demo bills are correct the moment the column exists; Story 10.5 gives the
-- owner a screen to change it.
UPDATE tenant_config SET service_charge_bp = 1000 WHERE service_charge_bp = 0;--> statement-breakpoint

-- The demo runs with financial re-auth OFF (Teran, 2026-10-02). The flag's
-- behaviour IS implemented in the bill route — when it is true a fresh PIN is
-- required in the request body — but Story 2.4 owns the UI that collects one,
-- and it is deferred post-demo. Leaving the flag true would have meant a
-- configuration promising a protection nothing could satisfy.
UPDATE tenant_config SET financial_action_reauth = false;
