ALTER TABLE "bank_statements" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "bank_statements_content_idx" ON "bank_statements" USING btree ("workspace_id","content_hash");