CREATE TABLE "cash_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"counted_paisa" integer NOT NULL,
	"staff_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "cash_counts_counted_non_negative" CHECK ("cash_counts"."counted_paisa" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "long_open_minutes" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_counts" ADD CONSTRAINT "cash_counts_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cash_counts_tenant_date" ON "cash_counts" USING btree ("tenant_id","business_date","created_at");--> statement-breakpoint
-- Every count is kept for ever; a recount adds a row (Story 9.3).
CREATE TRIGGER immutable_cash_counts
  BEFORE UPDATE OR DELETE ON "cash_counts"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
