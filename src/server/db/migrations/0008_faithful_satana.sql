CREATE TYPE "public"."session_kind" AS ENUM('table', 'counter');--> statement-breakpoint
ALTER TABLE "order_sessions" ALTER COLUMN "table_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_sessions" ADD COLUMN "kind" "session_kind" DEFAULT 'table' NOT NULL;