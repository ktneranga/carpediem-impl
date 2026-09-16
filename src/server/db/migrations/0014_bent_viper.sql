-- Story 4.4 — rounds and modifier text on order_events.
--
-- Both columns are NULLABLE and neither is defaulted. `order_events` already
-- holds session-level audit rows (SESSION_OPENED, TABLE_MERGED, SESSION_CLOSED)
-- and a DEFAULT 1 on round_number would retroactively place every one of them
-- in "Round 1". Epic 7 renders these rows to a customer during a bill dispute,
-- and the table is append-only — migration 0001's trigger refuses UPDATE — so a
-- wrong value written here could never be corrected.
--
-- NOTHING IS BACKFILLED, and nothing should be: the 14 pre-existing rows belong
-- to no round and carry no modifier. Story 4.5 is the first writer of either
-- column. (0011 taught this lesson the other way round — it created seat_slots
-- and backfilled nothing, which left every already-open session with no seats
-- until 0013 repaired it. Rounds are different: there is no live screen that
-- breaks without a value here.)
--
-- round_number derivation lives in the schema comment, not here: max + 1 per
-- session, inside the submit transaction, under lockOpenSession's row lock.
ALTER TABLE "order_events" ADD COLUMN "modifier_text" text;--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "round_number" integer;--> statement-breakpoint
CREATE INDEX "idx_order_events_session_round" ON "order_events" USING btree ("session_id","round_number");