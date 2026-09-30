-- Story 5.0 — print_jobs: the durable print queue.
--
-- Rows are inserted in the SAME transaction as the round, so an order can never
-- exist without its tickets queued (sprint-change-proposal-2026-08-21, Issue C).
--
-- ── NO append-only trigger on this table, deliberately ───────────────────────
-- Every table that records a FACT carries prevent_immutable_table_mutation()
-- from migration 0001: order_events, order_rounds, payment_records,
-- comp_records, dispute_records, table_status_events. This one is working
-- state — `status`, `attempts`, `last_error` and `claimed_at` are UPDATEd on
-- every retry, and the trigger would make the queue unable to run at all.
--
-- Nothing auditable is lost by that: what was ordered lives in order_events,
-- which is append-only. A print job is the delivery attempt, not the order.
CREATE TYPE "public"."print_job_status" AS ENUM('pending', 'printing', 'printed', 'dead');--> statement-breakpoint
CREATE TABLE "print_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"round_id" uuid NOT NULL,
	"destination" "production_destination" NOT NULL,
	"ticket" jsonb NOT NULL,
	"status" "print_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"printed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_round_id_order_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."order_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_print_jobs_claim" ON "print_jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_print_jobs_session_id" ON "print_jobs" USING btree ("session_id");