ALTER TYPE "public"."statement_state" ADD VALUE 'NEEDS_ACCOUNT' BEFORE 'PARSING';--> statement-breakpoint
ALTER TABLE "bank_statements" ADD COLUMN "upload_batch_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD COLUMN "identified_bank_name" text;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD COLUMN "identified_account_identifier" text;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD COLUMN "identified_account_type" text;--> statement-breakpoint
CREATE INDEX "bank_statements_batch_idx" ON "bank_statements" USING btree ("workspace_id","upload_batch_id");