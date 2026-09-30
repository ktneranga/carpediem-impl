-- Story 5.0 review decision (Teran, 2026-09-25): a station's tickets print in
-- the order they were sent, even when one of them is failing.
--
-- Two changes, both in service of that:
--
-- 1. created_at now defaults to clock_timestamp() rather than now(). now() is
--    the TRANSACTION timestamp, so two sends racing for the session lock could
--    be queued in the reverse of the order they committed — and the claim
--    orders by this column. Existing rows keep the timestamps they have; this
--    only affects rows inserted from here on.
--
-- 2. A (destination, created_at) index for the claim's new "is anything older
--    still in play for this station?" test.
ALTER TABLE "print_jobs" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
CREATE INDEX "idx_print_jobs_destination_order" ON "print_jobs" USING btree ("destination","created_at");