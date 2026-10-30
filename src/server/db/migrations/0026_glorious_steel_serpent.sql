-- A bar tab's nickname ("white shirt"), Teran 2026-10-30. Staff-only; never
-- printed on a guest's bill. Nullable: table orders and unnamed tabs have none.

ALTER TABLE "order_sessions" ADD COLUMN "tab_label" text;