ALTER TABLE "clarification_questions" ADD COLUMN "reconciliation_run_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_requirements" ADD COLUMN "reconciliation_run_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_requirements" ADD COLUMN "vendor_guess" text;--> statement-breakpoint
ALTER TABLE "invoice_requirements" ADD COLUMN "business_context" text;--> statement-breakpoint
ALTER TABLE "clarification_questions" ADD CONSTRAINT "clarification_questions_reconciliation_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requirements" ADD CONSTRAINT "invoice_requirements_reconciliation_run_id_reconciliation_runs_id_fk" FOREIGN KEY ("reconciliation_run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE set null ON UPDATE no action;