CREATE TYPE "public"."payment_method" AS ENUM('cash', 'card', 'transfer');--> statement-breakpoint
CREATE TYPE "public"."station_type" AS ENUM('kitchen', 'bar');--> statement-breakpoint
ALTER TABLE "payment_records" ALTER COLUMN "method" SET DATA TYPE "public"."payment_method" USING "method"::"public"."payment_method";--> statement-breakpoint
ALTER TABLE "station_configs" ALTER COLUMN "type" SET DATA TYPE "public"."station_type" USING "type"::"public"."station_type";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_order_sessions_one_open_per_table" ON "order_sessions" USING btree ("table_id") WHERE "order_sessions"."closed_at" IS NULL;