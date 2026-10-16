-- Story 6.4 code review (2026-10-13) - tie `type` to `seat_slot_id`.
--
-- Three places ask "is this the consolidated bill?" and all three answer with
-- `seat_slot_id IS NULL`: findConsolidatedBill, the 409 fallback re-read, and
-- the client's hasConsolidatedBill. Task 4 had specified `type = 'consolidated'`.
--
-- The two are equivalent only because buildBill writes both from one variable.
-- Nothing enforced it, and the verification script itself inserts a
-- counterexample - a row with type 'seat' and a NULL seat_slot_id - which every
-- one of those predicates would read as the session's consolidated bill.
--
-- Rather than change three call sites to the other spelling, make the two
-- spellings provably the same thing.
ALTER TABLE "bills" ADD CONSTRAINT "bills_type_matches_seat"
  CHECK (("type" = 'seat') = ("seat_slot_id" IS NOT NULL));
