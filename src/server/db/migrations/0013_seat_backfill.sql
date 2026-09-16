-- Story 4.3 review — backfill Seat 1 for sessions that predate `seat_slots`.
--
-- 0011 created the table and backfilled nothing, so every session that was
-- ALREADY OPEN when it ran has zero seats. `OrderScreenProps.seats` asserted in
-- a comment that this could not happen; on this database it had: one counter
-- session opened at 05:20, still open, with no seats — an empty chip row, no
-- active seat, no way to open the note panel, and no way to assign an item once
-- Story 4.4 lands.
--
-- Deploying 0011 mid-service would have put every seated table in that state.
--
-- Only OPEN sessions are backfilled. A closed session's seat list is history:
-- inventing a "Seat 1" that nobody ever sat in would put a fact into the audit
-- trail that was never true. Closed sessions have no order screen to break.
--
-- ON CONFLICT DO NOTHING against `idx_seat_slots_session_label`, so this is
-- idempotent and cannot collide with a session that already has a Seat 1.
INSERT INTO "seat_slots" ("session_id", "seat_label")
SELECT "id", 'Seat 1'
FROM "order_sessions"
WHERE "closed_at" IS NULL
ON CONFLICT ("session_id", "seat_label") DO NOTHING;
