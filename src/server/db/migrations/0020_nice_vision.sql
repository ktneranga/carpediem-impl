-- Story 6.4 - per-seat independent billing.
--
-- A bill may now name a seat. NULL means a consolidated bill, which covers
-- whatever is unbilled on the whole session rather than one seat.
--
-- idx_bills_seat_slot is the ENTIRE concurrency answer for "bill this seat":
-- two tablets tapping at the same instant both reach the bills INSERT, and the
-- database rejects the second. The session row lock serialises them in
-- practice; the index is the guarantee that does not depend on a future caller
-- remembering to take that lock.
--
-- Partial, WHERE seat_slot_id IS NOT NULL. PostgreSQL already treats NULLs as
-- distinct, so consolidated bills would not collide under a plain unique index
-- either - but the partial form states that only seat bills are constrained,
-- which is the thing a reader needs to know. Same shape as
-- idx_one_open_session_per_table.
--
-- No status column, here or anywhere: a bill is open when the payments against
-- it sum to less than its total (Story 6.2, Decision 3), which Story 6.5 can
-- ask once payment_records gains bill_id.

ALTER TABLE "bills" ADD COLUMN "seat_slot_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_seat_slot_id_seat_slots_id_fk" FOREIGN KEY ("seat_slot_id") REFERENCES "public"."seat_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bills_seat_slot" ON "bills" USING btree ("seat_slot_id") WHERE "bills"."seat_slot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_bills_session_seat" ON "bills" USING btree ("session_id","seat_slot_id");