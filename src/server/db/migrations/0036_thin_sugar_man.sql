CREATE TYPE "public"."cash_drawer_kind" AS ENUM('sale', 'no_sale');--> statement-breakpoint
CREATE TYPE "public"."cash_drawer_reason" AS ENUM('change', 'float', 'other');--> statement-breakpoint
CREATE TABLE "cash_drawer_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "cash_drawer_kind" NOT NULL,
	"reason" "cash_drawer_reason",
	"note" text,
	"payment_record_id" uuid,
	"print_job_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "cash_drawer_openings_kind_shape" CHECK (("cash_drawer_openings"."kind" = 'sale' AND "cash_drawer_openings"."payment_record_id" IS NOT NULL AND "cash_drawer_openings"."reason" IS NULL)
     OR ("cash_drawer_openings"."kind" = 'no_sale' AND "cash_drawer_openings"."payment_record_id" IS NULL AND "cash_drawer_openings"."reason" IS NOT NULL)),
	CONSTRAINT "cash_drawer_openings_note" CHECK (("cash_drawer_openings"."note" IS NULL OR char_length("cash_drawer_openings"."note") <= 120)
     AND ("cash_drawer_openings"."reason" IS DISTINCT FROM 'other' OR char_length(btrim(coalesce("cash_drawer_openings"."note", ''))) > 0))
);
--> statement-breakpoint
ALTER TABLE "print_jobs" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_drawer_openings" ADD CONSTRAINT "cash_drawer_openings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_openings" ADD CONSTRAINT "cash_drawer_openings_payment_record_id_payment_records_id_fk" FOREIGN KEY ("payment_record_id") REFERENCES "public"."payment_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_openings" ADD CONSTRAINT "cash_drawer_openings_print_job_id_print_jobs_id_fk" FOREIGN KEY ("print_job_id") REFERENCES "public"."print_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_openings" ADD CONSTRAINT "cash_drawer_openings_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cash_drawer_openings_tenant_created" ON "cash_drawer_openings" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_session_unless_cashier" CHECK ("print_jobs"."session_id" IS NOT NULL OR "print_jobs"."destination" = 'cashier');--> statement-breakpoint
-- Story 6.7 — hand-written rules.
--
-- Every drawer opening is kept for ever (NFR-D1).
CREATE TRIGGER immutable_cash_drawer_openings
  BEFORE UPDATE OR DELETE ON "cash_drawer_openings"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();--> statement-breakpoint
-- The ONE definition of "which business day is this moment" (migration 0032's
-- rule: the tenant's zone, turning over at `business_day_start_hour`). The
-- order-number trigger and the end-of-day reads both call it.
CREATE OR REPLACE FUNCTION business_date_at(p_tenant_id uuid, p_at timestamptz) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT ((p_at AT TIME ZONE t.timezone) - make_interval(hours => t.business_day_start_hour))::date
    FROM tenants t WHERE t.id = p_tenant_id
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION assign_order_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.business_date := business_date_at(NEW.tenant_id, COALESCE(NEW.opened_at, now()));
  INSERT INTO order_number_counters AS c (tenant_id, business_date, last_number)
       VALUES (NEW.tenant_id, NEW.business_date, 1)
  ON CONFLICT (tenant_id, business_date) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO NEW.daily_number;
  RETURN NEW;
END;
$$;
