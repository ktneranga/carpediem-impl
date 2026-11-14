CREATE TYPE "public"."vendor_access_kind" AS ENUM('sign_in', 'export');--> statement-breakpoint
CREATE TABLE "vendor_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "vendor_access_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_access_events" ADD CONSTRAINT "vendor_access_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_vendor_access_events_tenant_created" ON "vendor_access_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- Vendor sign-ins and exports are a record, never edited or removed.
CREATE TRIGGER immutable_vendor_access_events
  BEFORE UPDATE OR DELETE ON "vendor_access_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
