ALTER TABLE "staff" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "staff" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;