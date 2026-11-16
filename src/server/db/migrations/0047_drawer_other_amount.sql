ALTER TABLE "cash_drawer_openings" DROP CONSTRAINT "cash_drawer_openings_amount";--> statement-breakpoint
ALTER TABLE "cash_drawer_openings" ADD CONSTRAINT "cash_drawer_openings_amount" CHECK (CASE coalesce("cash_drawer_openings"."reason"::text, '')
          WHEN 'float'     THEN "cash_drawer_openings"."amount_paisa" IS NULL OR "cash_drawer_openings"."amount_paisa" > 0
          WHEN 'pay_in'    THEN "cash_drawer_openings"."amount_paisa" > 0
          WHEN 'paid_out'  THEN "cash_drawer_openings"."amount_paisa" < 0 AND char_length(btrim(coalesce("cash_drawer_openings"."note", ''))) > 0
          WHEN 'cash_drop' THEN "cash_drawer_openings"."amount_paisa" < 0 AND char_length(btrim(coalesce("cash_drawer_openings"."note", ''))) > 0
          WHEN 'other'     THEN "cash_drawer_openings"."amount_paisa" IS NULL OR "cash_drawer_openings"."amount_paisa" <> 0
          ELSE "cash_drawer_openings"."amount_paisa" IS NULL
        END);