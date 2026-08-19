-- Append-only enforcement: BEFORE triggers on audit/financial tables.
-- PostgreSQL rejects UPDATE and DELETE with a descriptive error.
-- This is a database-layer guarantee independent of application code —
-- a bug or injection cannot bypass it.
--
-- dispute_records is DELETE-protected only: disputes can be updated to record
-- resolution (resolved_by_staff_id, resolved_at, resolution), but can never
-- be erased from the audit trail.

CREATE OR REPLACE FUNCTION prevent_immutable_table_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '[immutable-table] % on % is not permitted. Insert a compensating record instead.',
    TG_OP, TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE TRIGGER immutable_order_events
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
--> statement-breakpoint

CREATE OR REPLACE TRIGGER immutable_payment_records
  BEFORE UPDATE OR DELETE ON payment_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
--> statement-breakpoint

CREATE OR REPLACE TRIGGER immutable_comp_records
  BEFORE UPDATE OR DELETE ON comp_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
--> statement-breakpoint

CREATE OR REPLACE TRIGGER immutable_dispute_records
  BEFORE DELETE ON dispute_records
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();
