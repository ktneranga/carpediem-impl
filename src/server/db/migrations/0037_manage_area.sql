CREATE TABLE "manage_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "manage_password_hash" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "manage_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "manage_locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "manage_sessions" ADD CONSTRAINT "manage_sessions_staff_session_id_staff_sessions_id_fk" FOREIGN KEY ("staff_session_id") REFERENCES "public"."staff_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_manage_sessions_staff_session_id" ON "manage_sessions" USING btree ("staff_session_id");