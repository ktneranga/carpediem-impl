-- Split an item by quantity (Teran, 2026-10-25).
--
-- "2x Devilled Cashew" is ONE order event with quantity 2, and until now a
-- bill line claimed a whole event, so two guests could not each pay for one.
-- A bill line now records how many of the event's units it bills, and an
-- event can be spread across several bills.
--
-- The no-double-billing invariant was UNIQUE (order_event_id). It would forbid
-- exactly this, so it moves into a trigger: no insert may take an event's
-- billed units past its ordered quantity. Every bill writer also holds the
-- session lock, so two tablets cannot race past the trigger's sum.

-- 1. The column, backfilled from the event. Every existing line billed its
--    whole event, so its quantity is the event's.
--
--    bill_lines is append-only, so the backfill needs the trigger off for
--    exactly this statement - the precedent migration 0019 set. It is back on
--    before anything else runs.
ALTER TABLE "bill_lines" ADD COLUMN "quantity" integer;--> statement-breakpoint
ALTER TABLE "bill_lines" DISABLE TRIGGER "immutable_bill_lines";--> statement-breakpoint
UPDATE "bill_lines" bl SET "quantity" = oe."quantity"
  FROM "order_events" oe WHERE oe."id" = bl."order_event_id";--> statement-breakpoint
ALTER TABLE "bill_lines" ENABLE TRIGGER "immutable_bill_lines";--> statement-breakpoint
ALTER TABLE "bill_lines" ALTER COLUMN "quantity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_quantity_positive" CHECK ("quantity" > 0);--> statement-breakpoint

-- 2. The indexes. One line per event per bill stays unique.
DROP INDEX "idx_bill_lines_order_event";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bill_lines_bill_event" ON "bill_lines" USING btree ("bill_id","order_event_id");--> statement-breakpoint
CREATE INDEX "idx_bill_lines_order_event" ON "bill_lines" USING btree ("order_event_id");--> statement-breakpoint

-- 3. The invariant, in the database. Raised as check_violation with a named
--    constraint so the service can recognise it by name, as it did the index.
CREATE OR REPLACE FUNCTION bill_lines_within_event_quantity() RETURNS trigger AS $$
DECLARE
  ordered integer;
  billed integer;
BEGIN
  SELECT quantity INTO ordered FROM order_events WHERE id = NEW.order_event_id;
  SELECT coalesce(sum(quantity), 0) INTO billed FROM bill_lines WHERE order_event_id = NEW.order_event_id;
  IF billed + NEW.quantity > ordered THEN
    RAISE EXCEPTION 'order event % would be billed % of %', NEW.order_event_id, billed + NEW.quantity, ordered
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_within_event_quantity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "bill_lines_within_event_quantity"
  BEFORE INSERT ON "bill_lines"
  FOR EACH ROW EXECUTE FUNCTION bill_lines_within_event_quantity();
