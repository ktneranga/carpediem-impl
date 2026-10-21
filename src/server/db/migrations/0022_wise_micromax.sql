-- One bill / Separate bills (Teran, 2026-10-16).
--
-- Replaces zoneUsesSeats() as the rule for whether an order tracks people.
-- 'one' is a NON-SEAT order: the waiter sees no seat anywhere, including on
-- the kitchen ticket. 'separate' shows the seat picker.
--
-- Existing sessions default to 'one', which matches what a Bean Bags order
-- already was. A Tables session in flight will lose its seat picker until the
-- waiter switches it -- acceptable, because every one of them is a test
-- session, and the switch is one tap.
--
-- NOTE what is NOT here: nothing touches order_events. seat_slot_id was never
-- null and still is not, because openSession has always created "Seat 1" for
-- every session regardless of zone. This column changes what is DRAWN, not
-- what is stored, which is why Story 6.4's per-seat billing is untouched.

CREATE TYPE "public"."bill_mode" AS ENUM('one', 'separate');--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "bill_mode" "bill_mode" DEFAULT 'one' NOT NULL;