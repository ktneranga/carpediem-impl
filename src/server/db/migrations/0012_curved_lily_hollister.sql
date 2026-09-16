-- Story 4.3 — drops the integer seat column replaced by 0011's `seat_slot_id`.
--
-- NOTHING IS MIGRATED INTO `seat_slot_id` BY THIS MIGRATION. The column held no
-- seat values, so the drop is free; do not read this as evidence that data was
-- carried across. Split from 0011 so each migration is unambiguous and so
-- drizzle-kit did not have to ask whether this was a rename.
ALTER TABLE "order_events" DROP COLUMN "seat_slot";