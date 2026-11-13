ALTER TABLE "staff" ADD COLUMN "job_title" text DEFAULT 'waiter' NOT NULL;--> statement-breakpoint
-- Existing staff get the job their role suggests (src/lib/staff-jobs.ts DEFAULT_JOB).
UPDATE "staff" SET "job_title" = CASE "role" WHEN 'owner' THEN 'owner' WHEN 'kitchen' THEN 'chef' ELSE 'waiter' END;
