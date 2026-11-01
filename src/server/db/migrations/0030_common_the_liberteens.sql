ALTER TABLE "modifier_options" ADD COLUMN "excludes_group_id" uuid;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_excludes_group_id_modifier_groups_id_fk" FOREIGN KEY ("excludes_group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Countable options are capped at 10 (code review 2026-11-01): a valid count must
-- always fit under MAX_OPTIONS_PER_LINE, and a stray 1000 must not reach pricing.
ALTER TABLE "modifier_options" DROP CONSTRAINT "modifier_options_max_count_positive";--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_max_count_range" CHECK ("max_count" BETWEEN 1 AND 10);
