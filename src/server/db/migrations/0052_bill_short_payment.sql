ALTER TABLE "bills" ADD COLUMN "short_paisa" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "short_note" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "short_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "short_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_short_by_staff_id_staff_id_fk" FOREIGN KEY ("short_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_short_all_or_none" CHECK (("bills"."short_paisa" = 0 AND "bills"."short_note" IS NULL AND "bills"."short_by_staff_id" IS NULL AND "bills"."short_at" IS NULL)
     OR ("bills"."short_paisa" > 0 AND "bills"."short_by_staff_id" IS NOT NULL AND "bills"."short_at" IS NOT NULL
         AND length(trim("bills"."short_note")) BETWEEN 1 AND 120));--> statement-breakpoint
-- ── A bill may also be marked SHORT once (Teran, 2026-11-21) ─────────────────
-- Replaces 0043's function. Still: one cancel, nothing else. Now also: the four
-- short columns go from unset to set together (the CHECK above makes them
-- all-or-none), on a bill not cancelled, with every other column unchanged.
CREATE OR REPLACE FUNCTION bills_allow_cancel_once() RETURNS trigger AS $$
DECLARE
  cancel_columns text[] := ARRAY['cancelled_at', 'cancelled_by_staff_id', 'cancel_approved_by_staff_id', 'cancel_reason'];
  short_columns text[] := ARRAY['short_paisa', 'short_note', 'short_by_staff_id', 'short_at'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.cancelled_at IS NULL
     AND NEW.cancelled_at IS NOT NULL
     AND (to_jsonb(NEW) - cancel_columns) = (to_jsonb(OLD) - cancel_columns) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.cancelled_at IS NULL
     AND OLD.short_at IS NULL
     AND NEW.short_at IS NOT NULL
     AND (to_jsonb(NEW) - short_columns) = (to_jsonb(OLD) - short_columns) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    '[immutable-table] % on % is not permitted. Insert a compensating record instead.',
    TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
