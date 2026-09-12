-- Append-only enforcement for table_status_events.
--
-- Availability changes are audit records: who took a table out of service, why,
-- and when it came back. A log that can be edited is not a log, so this gets the
-- same database-layer guarantee as order_events, payment_records and
-- comp_records — independent of application code, so a bug or an injection
-- cannot bypass it.
--
-- The function is NOT redefined here. 0001_append_only_rules.sql already defines
-- prevent_immutable_table_mutation(); this migration only attaches it.
--
-- UPDATE *and* DELETE are both blocked. Unlike dispute_records — which permits
-- UPDATE so a dispute can record its own resolution — an availability event has
-- no later state to record. A correction is a new event in the other direction.

CREATE OR REPLACE TRIGGER immutable_table_status_events
  BEFORE UPDATE OR DELETE ON table_status_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
