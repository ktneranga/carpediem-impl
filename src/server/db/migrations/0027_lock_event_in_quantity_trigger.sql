-- Code review P3 (2026-10-31): the quantity guard locks the event it guards.
--
-- 0025's trigger summed the units already billed for an event without locking
-- anything. Under READ COMMITTED two inserts for the same event, from writers
-- that skipped `lockOpenSession`, could both read the old sum and both pass -
-- billing the event past its quantity. `UNIQUE(order_event_id)`, which this
-- trigger replaced, held no matter what the caller did; this restores that.
--
-- `SELECT ... FOR UPDATE` on the order_events row makes the second writer wait
-- for the first to commit, then read the new sum. It is a row LOCK, not an
-- UPDATE, so the append-only trigger on order_events is not involved.

CREATE OR REPLACE FUNCTION bill_lines_within_event_quantity() RETURNS trigger AS $$
DECLARE
  ordered integer;
  billed integer;
BEGIN
  SELECT quantity INTO ordered FROM order_events WHERE id = NEW.order_event_id FOR UPDATE;
  SELECT coalesce(sum(quantity), 0) INTO billed FROM bill_lines WHERE order_event_id = NEW.order_event_id;
  IF billed + NEW.quantity > ordered THEN
    RAISE EXCEPTION 'order event % would be billed % of %', NEW.order_event_id, billed + NEW.quantity, ordered
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_within_event_quantity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
