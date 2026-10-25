-- Story 6.3 (brought forward 2026-10-25): one person's bill from the split.
--
-- bills_type_matches_seat (0021) needs no change: it says type = 'seat' iff
-- seat_slot_id IS NOT NULL, and a split bill has no seat.

ALTER TYPE "public"."bill_type" ADD VALUE 'split';--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "person_label" text;