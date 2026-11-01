ALTER TABLE "modifier_options" ADD COLUMN "max_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Countable options (Teran, 2026-11-01): a line takes an option at most max_count times.
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_max_count_positive" CHECK ("max_count" >= 1);
