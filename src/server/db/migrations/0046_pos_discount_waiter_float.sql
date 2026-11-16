ALTER TYPE "public"."cash_drawer_reason" ADD VALUE 'pay_in';--> statement-breakpoint
ALTER TYPE "public"."cash_drawer_reason" ADD VALUE 'paid_out';--> statement-breakpoint
ALTER TYPE "public"."cash_drawer_reason" ADD VALUE 'cash_drop';--> statement-breakpoint
ALTER TABLE "staff" DROP CONSTRAINT "staff_permissions_known";--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "discount_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "discount_paisa" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "service_charge_waived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "service_waived_paisa" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_drawer_openings" ADD COLUMN "amount_paisa" integer;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "served_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "discount_bp" integer;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "service_charge_waived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "pricing_changed_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "default_discount_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "kitchen_ticket_copies" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "bar_ticket_copies" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_served_by_staff_id_staff_id_fk" FOREIGN KEY ("served_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_pricing_changed_by_staff_id_staff_id_fk" FOREIGN KEY ("pricing_changed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_openings" ADD CONSTRAINT "cash_drawer_openings_amount" CHECK (CASE coalesce("cash_drawer_openings"."reason"::text, '')
          WHEN 'float'     THEN "cash_drawer_openings"."amount_paisa" IS NULL OR "cash_drawer_openings"."amount_paisa" > 0
          WHEN 'pay_in'    THEN "cash_drawer_openings"."amount_paisa" > 0
          WHEN 'paid_out'  THEN "cash_drawer_openings"."amount_paisa" < 0 AND char_length(btrim(coalesce("cash_drawer_openings"."note", ''))) > 0
          WHEN 'cash_drop' THEN "cash_drawer_openings"."amount_paisa" < 0 AND char_length(btrim(coalesce("cash_drawer_openings"."note", ''))) > 0
          ELSE "cash_drawer_openings"."amount_paisa" IS NULL
        END);--> statement-breakpoint
ALTER TABLE "order_sessions" ADD CONSTRAINT "order_sessions_discount_range" CHECK ("order_sessions"."discount_bp" IS NULL OR ("order_sessions"."discount_bp" >= 0 AND "order_sessions"."discount_bp" <= 10000));--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_permissions_known" CHECK ("staff"."permissions" <@ ARRAY['custom_charge','approve_voids','open_cash_drawer','give_discount','manage_dashboard','manage_menu','manage_floor','manage_settings']::text[]);--> statement-breakpoint
ALTER TABLE "tenant_config" ADD CONSTRAINT "tenant_config_default_discount" CHECK ("tenant_config"."default_discount_bp" >= 0 AND "tenant_config"."default_discount_bp" <= 10000);--> statement-breakpoint
ALTER TABLE "tenant_config" ADD CONSTRAINT "tenant_config_ticket_copies" CHECK ("tenant_config"."kitchen_ticket_copies" BETWEEN 1 AND 3 AND "tenant_config"."bar_ticket_copies" BETWEEN 1 AND 3);