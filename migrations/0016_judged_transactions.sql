ALTER TABLE "canonical_transactions" ADD COLUMN "judged_at" timestamp with time zone;--> statement-breakpoint
-- Backfill what the old definition of "judged" can still prove: a requirement, or a question
-- still waiting for the user. Payments judged as needing no document left no trace, so they
-- are judged once more by the next run and marked then.
UPDATE "canonical_transactions" SET "judged_at" = now()
WHERE "id" IN (SELECT "canonical_transaction_id" FROM "invoice_requirements")
   OR "id" IN (
     SELECT "canonical_transaction_id" FROM "clarification_questions"
     WHERE "answered_at" IS NULL AND "canonical_transaction_id" IS NOT NULL
   );
