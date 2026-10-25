-- Story 6.5: a payment pays a BILL.
--
-- NOT NULL with no default is safe because payment_records had no rows when
-- this was written: nothing wrote to it before 6.5. A database that somehow
-- has rows will fail here loudly, which is the right outcome - a payment that
-- cannot be tied to the bill it settled has to be reconciled by a person, not
-- defaulted by a migration.

ALTER TABLE "payment_records" ADD COLUMN "bill_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_payment_records_bill_id" ON "payment_records" USING btree ("bill_id");