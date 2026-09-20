-- Story 4.5 — order_rounds: one row per SENT round.
--
-- The primary key is the client-generated submission id, which makes sending
-- idempotent: a retry or double tap collides here instead of writing a second
-- round. (sprint-change-proposal-2026-08-21 Change E4 proposed the key on
-- order_sessions; a session has many rounds, so it lives on the round.)
--
-- (session_id, round_number) is unique — the backstop if two sends ever derive
-- the same number despite the session row lock.
--
-- NOTHING IS BACKFILLED. Rounds sent before this migration exist only as
-- order_events rows; the service seeds the next round number from those too.
CREATE TABLE "order_rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"round_number" integer NOT NULL,
	"staff_id" uuid NOT NULL,
	"item_count" integer NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_rounds" ADD CONSTRAINT "order_rounds_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_rounds" ADD CONSTRAINT "order_rounds_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_order_rounds_session_round" ON "order_rounds" USING btree ("session_id","round_number");--> statement-breakpoint

-- Append-only, exactly like order_events (migration 0001). A sent round is a
-- fact; corrections are new events.
CREATE OR REPLACE TRIGGER immutable_order_rounds
  BEFORE UPDATE OR DELETE ON order_rounds
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
