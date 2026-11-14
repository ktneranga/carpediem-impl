DROP INDEX "idx_bills_seat_slot";--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "cancelled_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "cancel_approved_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "voids_event_id" uuid;--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "approved_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_cancelled_by_staff_id_staff_id_fk" FOREIGN KEY ("cancelled_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_cancel_approved_by_staff_id_staff_id_fk" FOREIGN KEY ("cancel_approved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_voids_event_id_order_events_id_fk" FOREIGN KEY ("voids_event_id") REFERENCES "public"."order_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_approved_by_staff_id_staff_id_fk" FOREIGN KEY ("approved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_order_events_voids_event" ON "order_events" USING btree ("voids_event_id") WHERE "order_events"."voids_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_order_events_session_request" ON "order_events" USING btree ("session_id","request_id") WHERE "order_events"."request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_bills_seat_slot" ON "bills" USING btree ("seat_slot_id") WHERE "bills"."seat_slot_id" IS NOT NULL AND "bills"."cancelled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_cancel_all_or_none" CHECK (("bills"."cancelled_at" IS NULL AND "bills"."cancelled_by_staff_id" IS NULL AND "bills"."cancel_approved_by_staff_id" IS NULL AND "bills"."cancel_reason" IS NULL)
     OR ("bills"."cancelled_at" IS NOT NULL AND "bills"."cancelled_by_staff_id" IS NOT NULL AND "bills"."cancel_approved_by_staff_id" IS NOT NULL AND length(trim("bills"."cancel_reason")) > 0));--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_void_shape" CHECK ("order_events"."event_type" <> 'ITEM_VOIDED' OR ("order_events"."voids_event_id" IS NOT NULL AND "order_events"."approved_by_staff_id" IS NOT NULL AND "order_events"."quantity" > 0));--> statement-breakpoint
-- ── Story 7.5: a bill may be cancelled ONCE, and nothing else may change ─────
-- Bills stay immutable except for one transition: the four cancel columns go
-- from NULL to set together (the CHECK above makes them all-or-none), with
-- every other column unchanged. A second cancel, any other UPDATE, and every
-- DELETE still raise, with the same message prevent_immutable_table_mutation()
-- gives. A table of cancellations was not used: idx_bills_seat_slot must skip
-- a cancelled bill so the seat can be billed again, and a partial index can
-- only see its own table's columns.
CREATE OR REPLACE FUNCTION bills_allow_cancel_once() RETURNS trigger AS $$
DECLARE
  cancel_columns text[] := ARRAY['cancelled_at', 'cancelled_by_staff_id', 'cancel_approved_by_staff_id', 'cancel_reason'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.cancelled_at IS NULL
     AND NEW.cancelled_at IS NOT NULL
     AND (to_jsonb(NEW) - cancel_columns) = (to_jsonb(OLD) - cancel_columns) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    '[immutable-table] % on % is not permitted. Insert a compensating record instead.',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS immutable_bills ON bills;--> statement-breakpoint
CREATE TRIGGER immutable_bills
  BEFORE UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION bills_allow_cancel_once();--> statement-breakpoint
-- ── Billed units count LIVE bills only, and voided units are never billable ──
-- Replaces 0027's version: billed = lines on bills not cancelled; a line may be
-- billed up to quantity − voided. Still locks the event row first.
CREATE OR REPLACE FUNCTION bill_lines_within_event_quantity() RETURNS trigger AS $$
DECLARE
  ordered integer;
  billed integer;
  voided integer;
BEGIN
  SELECT quantity INTO ordered FROM order_events WHERE id = NEW.order_event_id FOR UPDATE;
  SELECT coalesce(sum(l.quantity), 0) INTO billed
    FROM bill_lines l JOIN bills b ON b.id = l.bill_id
   WHERE l.order_event_id = NEW.order_event_id AND b.cancelled_at IS NULL;
  SELECT coalesce(sum(quantity), 0) INTO voided
    FROM order_events WHERE voids_event_id = NEW.order_event_id AND event_type = 'ITEM_VOIDED';
  IF billed + voided + NEW.quantity > ordered THEN
    RAISE EXCEPTION 'order event % would be billed % of % (% voided)', NEW.order_event_id, billed + NEW.quantity, ordered, voided
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_lines_within_event_quantity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- ── A void can never take more than is left (Story 7.5) ──────────────────────
-- Same lock as the bill-line trigger, so a void and a bill of the same line
-- serialise: whichever commits second sees the first.
CREATE OR REPLACE FUNCTION order_event_void_within_quantity() RETURNS trigger AS $$
DECLARE
  target record;
  billed integer;
  voided integer;
BEGIN
  IF NEW.event_type <> 'ITEM_VOIDED' THEN
    RETURN NEW;
  END IF;
  SELECT id, session_id, event_type, quantity INTO target
    FROM order_events WHERE id = NEW.voids_event_id FOR UPDATE;
  IF target.id IS NULL OR target.event_type <> 'ITEM_ADDED' OR target.session_id <> NEW.session_id THEN
    RAISE EXCEPTION 'order event % is not an item on session %', NEW.voids_event_id, NEW.session_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_event_void_target';
  END IF;
  SELECT coalesce(sum(l.quantity), 0) INTO billed
    FROM bill_lines l JOIN bills b ON b.id = l.bill_id
   WHERE l.order_event_id = target.id AND b.cancelled_at IS NULL;
  SELECT coalesce(sum(quantity), 0) INTO voided
    FROM order_events WHERE voids_event_id = target.id AND event_type = 'ITEM_VOIDED';
  IF billed + voided + NEW.quantity > target.quantity THEN
    RAISE EXCEPTION 'order event % would be voided % of % (% billed)', target.id, voided + NEW.quantity, target.quantity, billed
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_event_void_within_quantity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER order_event_void_within_quantity
  BEFORE INSERT ON order_events
  FOR EACH ROW EXECUTE FUNCTION order_event_void_within_quantity();
