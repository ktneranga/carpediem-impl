-- Order numbers (Teran, 2026-11-02): `#042` per business day, `20261102-042`
-- unique for ever. The business day turns over at `business_day_start_hour`
-- (4 AM) in the tenant's zone, so a late bar does not restart at midnight.
CREATE TABLE "order_number_counters" (
	"tenant_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "order_number_counters_tenant_id_business_date_pk" PRIMARY KEY("tenant_id","business_date")
);
--> statement-breakpoint
ALTER TABLE "order_number_counters" ADD CONSTRAINT "order_number_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "business_day_start_hour" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_day_start_hour_range" CHECK ("business_day_start_hour" BETWEEN 0 AND 23);--> statement-breakpoint
-- Nullable first: existing orders are numbered below, in the order they were
-- opened, before NOT NULL goes on.
ALTER TABLE "order_sessions" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "daily_number" integer;--> statement-breakpoint
UPDATE "order_sessions" AS s
   SET "business_date" = n.business_date,
       "daily_number" = n.daily_number
  FROM (
    SELECT d.id,
           d.business_date,
           row_number() OVER (PARTITION BY d.tenant_id, d.business_date ORDER BY d.opened_at, d.id)::integer AS daily_number
      FROM (
        SELECT os.id, os.tenant_id, os.opened_at,
               ((os.opened_at AT TIME ZONE t.timezone) - make_interval(hours => t.business_day_start_hour))::date AS business_date
          FROM "order_sessions" os
          JOIN "tenants" t ON t.id = os.tenant_id
      ) AS d
  ) AS n
 WHERE s.id = n.id;--> statement-breakpoint
INSERT INTO "order_number_counters" ("tenant_id", "business_date", "last_number")
SELECT "tenant_id", "business_date", max("daily_number")
  FROM "order_sessions"
 GROUP BY "tenant_id", "business_date";--> statement-breakpoint
ALTER TABLE "order_sessions" ALTER COLUMN "business_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "order_sessions" ALTER COLUMN "daily_number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_order_sessions_order_number" ON "order_sessions" USING btree ("tenant_id","business_date","daily_number");--> statement-breakpoint
-- The ONLY way a number is assigned. Whatever the insert sent is overwritten.
-- The counter row's lock (held to commit) serialises two orders opened at the
-- same moment; a rolled-back open rolls its number back too, so no gaps.
CREATE OR REPLACE FUNCTION assign_order_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tz text;
  start_hour integer;
BEGIN
  SELECT timezone, business_day_start_hour INTO tz, start_hour
    FROM tenants WHERE id = NEW.tenant_id;
  NEW.business_date := ((COALESCE(NEW.opened_at, now()) AT TIME ZONE tz) - make_interval(hours => start_hour))::date;
  INSERT INTO order_number_counters AS c (tenant_id, business_date, last_number)
       VALUES (NEW.tenant_id, NEW.business_date, 1)
  ON CONFLICT (tenant_id, business_date) DO UPDATE SET last_number = c.last_number + 1
  RETURNING c.last_number INTO NEW.daily_number;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_sessions_assign_order_number
  BEFORE INSERT ON "order_sessions"
  FOR EACH ROW EXECUTE FUNCTION assign_order_number();--> statement-breakpoint
-- A number printed on a ticket and quoted in a dispute never changes.
CREATE OR REPLACE FUNCTION refuse_order_number_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.daily_number IS DISTINCT FROM OLD.daily_number THEN
    RAISE EXCEPTION 'order number is immutable (session %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER order_sessions_order_number_immutable
  BEFORE UPDATE OF "business_date", "daily_number" ON "order_sessions"
  FOR EACH ROW EXECUTE FUNCTION refuse_order_number_change();
