-- Enforce the reason invariants at the database layer, not just in one zod schema.
--
-- Before this, the only thing enforcing "a reason is required" was the body
-- schema on POST /api/tables/:id/out-of-service. Any other caller —
-- a seed, Story 10.3's configuration screen, a test helper, a manual fix —
-- could write an immutable audit row that answers "who" but not "why", which is
-- the one question the whole feature exists to answer.
--
-- Two invariants, both already stated in comments in schema.ts and neither
-- previously enforced:
--
--   1. tables.unavailable_reason is set exactly when the table is unavailable.
--      A stale reason on an open table reads as still applying; a missing one on
--      an unavailable table is the gap above.
--
--   2. A table_status_events row moving TO unavailable must carry a reason.
--      Rows moving back to open must not — the reason describes the outage that
--      is ending, and it is already recorded on the row that started it.

-- Backfill before constraining. Tables seeded as `unavailable` predate the
-- reason column entirely, so adding the CHECK without this fails on any
-- database seeded before 2026-09-09 — including every developer's. The seed now
-- supplies real reasons; these rows get an honest placeholder rather than an
-- invented one.
UPDATE tables
  SET unavailable_reason = 'Reason not recorded (predates availability tracking)'
  WHERE status = 'unavailable' AND unavailable_reason IS NULL;
--> statement-breakpoint

-- The mirror case: a reason left on a table that is not out of service would
-- read as still applying. None exist today; clearing is cheap insurance.
UPDATE tables
  SET unavailable_reason = NULL
  WHERE status <> 'unavailable' AND unavailable_reason IS NOT NULL;
--> statement-breakpoint

ALTER TABLE tables
  ADD CONSTRAINT tables_unavailable_reason_matches_status
  CHECK ((status = 'unavailable') = (unavailable_reason IS NOT NULL));
--> statement-breakpoint

ALTER TABLE table_status_events
  ADD CONSTRAINT table_status_events_reason_required_going_out
  CHECK ((to_status = 'unavailable') = (reason IS NOT NULL));
