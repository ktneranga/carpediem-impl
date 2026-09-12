CREATE TABLE "seat_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seat_label" text NOT NULL,
	"seat_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_events" ADD COLUMN "seat_slot_id" uuid;--> statement-breakpoint
ALTER TABLE "seat_slots" ADD CONSTRAINT "seat_slots_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_seat_slots_session_id" ON "seat_slots" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_seat_slots_session_label" ON "seat_slots" USING btree ("session_id","seat_label");--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_seat_slot_id_seat_slots_id_fk" FOREIGN KEY ("seat_slot_id") REFERENCES "public"."seat_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_order_events_seat_slot_id" ON "order_events" USING btree ("seat_slot_id");