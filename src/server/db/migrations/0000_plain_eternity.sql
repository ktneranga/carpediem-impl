CREATE TYPE "public"."order_event_type" AS ENUM('SESSION_OPENED', 'SESSION_CLOSED', 'ITEM_ADDED', 'ITEM_REMOVED', 'ITEM_MODIFIED', 'ORDER_SENT_TO_KITCHEN', 'ORDER_SENT_TO_BAR', 'ITEM_COMPED', 'ITEM_VOIDED', 'PAYMENT_REQUESTED', 'SESSION_SETTLED');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('waiter', 'owner', 'kitchen');--> statement-breakpoint
CREATE TYPE "public"."table_status" AS ENUM('open', 'occupied', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."ticket_output_mode" AS ENUM('print', 'kds', 'both');--> statement-breakpoint
CREATE TABLE "comp_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"order_event_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"authorized_by_staff_id" uuid NOT NULL,
	"amount_paisa" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispute_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"raised_by_staff_id" uuid NOT NULL,
	"resolved_by_staff_id" uuid,
	"description" text NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_paisa" integer NOT NULL,
	"portion_count" integer,
	"is_available" boolean DEFAULT true NOT NULL,
	"ticket_output_mode" "ticket_output_mode" DEFAULT 'print' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"event_type" "order_event_type" NOT NULL,
	"seat_slot" integer,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_paisa" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"opened_by_staff_id" uuid NOT NULL,
	"closed_by_staff_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"cover_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"amount_paisa" integer NOT NULL,
	"method" text NOT NULL,
	"covered_seat_slots" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printer_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ip_address" text NOT NULL,
	"port" integer DEFAULT 9100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"pin_hash" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"printer_config_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" "table_status" DEFAULT 'open' NOT NULL,
	"capacity" integer,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"restaurant_name" text NOT NULL,
	"brand_color" text DEFAULT '#2288B4' NOT NULL,
	"currency_code" text DEFAULT 'LKR' NOT NULL,
	"tax_rate_percent" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Colombo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comp_records" ADD CONSTRAINT "comp_records_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_records" ADD CONSTRAINT "comp_records_order_event_id_order_events_id_fk" FOREIGN KEY ("order_event_id") REFERENCES "public"."order_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_records" ADD CONSTRAINT "comp_records_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comp_records" ADD CONSTRAINT "comp_records_authorized_by_staff_id_staff_id_fk" FOREIGN KEY ("authorized_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_records" ADD CONSTRAINT "dispute_records_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_records" ADD CONSTRAINT "dispute_records_raised_by_staff_id_staff_id_fk" FOREIGN KEY ("raised_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_records" ADD CONSTRAINT "dispute_records_resolved_by_staff_id_staff_id_fk" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_menu_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_opened_by_staff_id_staff_id_fk" FOREIGN KEY ("opened_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_closed_by_staff_id_staff_id_fk" FOREIGN KEY ("closed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printer_configs" ADD CONSTRAINT "printer_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_configs" ADD CONSTRAINT "station_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_configs" ADD CONSTRAINT "station_configs_printer_config_id_printer_configs_id_fk" FOREIGN KEY ("printer_config_id") REFERENCES "public"."printer_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD CONSTRAINT "tenant_config_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_comp_records_session_id" ON "comp_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_dispute_records_session_id" ON "dispute_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_menu_categories_tenant_id" ON "menu_categories" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_menu_items_tenant_id" ON "menu_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_menu_items_category_id" ON "menu_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_order_events_session_id" ON "order_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_order_events_staff_id" ON "order_events" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "idx_order_events_created_at" ON "order_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_order_sessions_tenant_id" ON "order_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_order_sessions_table_id" ON "order_sessions" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "idx_payment_records_session_id" ON "payment_records" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_printer_configs_tenant_id" ON "printer_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_staff_tenant_id" ON "staff" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_station_configs_tenant_id" ON "station_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_tables_tenant_id" ON "tables" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_tables_zone_id" ON "tables" USING btree ("zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tenant_config_tenant_id" ON "tenant_config" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_zones_tenant_id" ON "zones" USING btree ("tenant_id");