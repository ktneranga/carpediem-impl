ALTER TYPE "public"."order_event_type" ADD VALUE 'TABLE_MERGED';--> statement-breakpoint
ALTER TYPE "public"."order_event_type" ADD VALUE 'TABLE_UNMERGED';--> statement-breakpoint
CREATE TABLE "order_session_tables" (
	"session_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "order_session_tables_session_id_table_id_pk" PRIMARY KEY("session_id","table_id")
);
--> statement-breakpoint
DROP INDEX "idx_order_sessions_one_open_per_table";--> statement-breakpoint
ALTER TABLE "order_session_tables" ADD CONSTRAINT "order_session_tables_session_id_order_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_session_tables" ADD CONSTRAINT "order_session_tables_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--> HAND-EDITED: backfill before constraining.
--
-- drizzle-kit generated everything else in this file, but it cannot know that
-- order_session_tables must inherit the existing one-table-per-session rows.
-- Without this, the table is created empty, the unique index below is built over
-- nothing, and every session that is currently open loses the table it is
-- attached to — the grid would show an empty floor with live sessions behind it.
--
-- `released_at` mirrors `closed_at`, so a session that is already closed arrives
-- already released and does not consume the one-open-session-per-table slot.
INSERT INTO "order_session_tables" ("session_id", "table_id", "attached_at", "released_at")
  SELECT "id", "table_id", "opened_at", "closed_at" FROM "order_sessions";
--> statement-breakpoint

CREATE UNIQUE INDEX "idx_one_open_session_per_table" ON "order_session_tables" USING btree ("table_id") WHERE "order_session_tables"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_order_session_tables_session_id" ON "order_session_tables" USING btree ("session_id");