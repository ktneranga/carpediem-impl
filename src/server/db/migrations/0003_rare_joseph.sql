CREATE TYPE "public"."auth_mode" AS ENUM('session_short', 'session_persistent', 'per_transaction', 'per_action');--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "auth_mode" "auth_mode" DEFAULT 'session_short' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "session_timeout_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "financial_action_reauth" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_staff_sessions_staff_id" ON "staff_sessions" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "idx_staff_sessions_expires_at" ON "staff_sessions" USING btree ("expires_at");