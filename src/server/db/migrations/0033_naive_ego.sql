CREATE TYPE "public"."print_destination" AS ENUM('kitchen', 'pizza_kitchen', 'bar', 'cashier');--> statement-breakpoint
ALTER TABLE "print_jobs" ALTER COLUMN "round_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ALTER COLUMN "destination" SET DATA TYPE "public"."print_destination" USING "destination"::text::"public"."print_destination";--> statement-breakpoint
ALTER TABLE "payment_records" ADD COLUMN "cash_received_paisa" integer;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "bill_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "receipt_header" text;--> statement-breakpoint
ALTER TABLE "tenant_config" ADD COLUMN "receipt_footer" text;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_print_jobs_bill_id" ON "print_jobs" USING btree ("bill_id");--> statement-breakpoint
-- Story 6.6 — hand-written rules.
--
-- Cash received is a note beside a CASH tender, never less than what that
-- tender applied (the change is the difference). Card tenders carry none.
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_cash_received_valid" CHECK (
  "cash_received_paisa" IS NULL
  OR ("method" = 'cash' AND "cash_received_paisa" >= "amount_paisa")
);--> statement-breakpoint
-- A kitchen ticket belongs to a round; a bill (destination `cashier`) never
-- does, and only a bill names a recorded bill.
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_round_matches_destination" CHECK (
  ("destination" = 'cashier') = ("round_id" IS NULL)
  AND ("bill_id" IS NULL OR "destination" = 'cashier')
);
