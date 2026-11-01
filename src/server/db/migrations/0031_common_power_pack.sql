ALTER TABLE "order_events" ADD COLUMN "custom_name" text;--> statement-breakpoint
-- Every item line names exactly one source: a menu item, or a custom charge (Story 4.9).
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_item_names_one_source" CHECK ("event_type" <> 'ITEM_ADDED' OR (("menu_item_id" IS NULL) <> ("custom_name" IS NULL)));
