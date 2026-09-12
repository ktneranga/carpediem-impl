CREATE TABLE "table_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"from_status" "table_status" NOT NULL,
	"to_status" "table_status" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "unavailable_reason" text;--> statement-breakpoint
ALTER TABLE "table_status_events" ADD CONSTRAINT "table_status_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_status_events" ADD CONSTRAINT "table_status_events_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_status_events" ADD CONSTRAINT "table_status_events_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_table_status_events_table_id" ON "table_status_events" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "idx_table_status_events_created_at" ON "table_status_events" USING btree ("created_at");