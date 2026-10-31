-- Story 4.8: priced options (FR65).
--
-- modifier_groups / modifier_options are mutable menu config, like menu_items:
-- no append-only trigger. What was ORDERED is frozen on the event instead:
-- order_events.options (jsonb snapshot) and bill_lines.option_text. Both are
-- nullable ADD COLUMNs on append-only tables - DDL, not blocked by their row
-- triggers - and nothing is backfilled: NULL means "no options".

CREATE TYPE "public"."modifier_selection" AS ENUM('single', 'multi');--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"selection" "modifier_selection" DEFAULT 'single' NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_delta_paisa" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "option_text" text;--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_group_id_modifier_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_modifier_groups_tenant_id" ON "modifier_groups" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_modifier_groups_menu_item_id" ON "modifier_groups" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "idx_modifier_options_tenant_id" ON "modifier_options" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_modifier_options_group_id" ON "modifier_options" USING btree ("group_id");