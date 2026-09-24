CREATE TABLE "invoice_match_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"model_verdict" text,
	"model_reason" text,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "suspected_duplicate_of_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "duplicate_reason" text;--> statement-breakpoint
ALTER TABLE "invoice_match_candidates" ADD CONSTRAINT "invoice_match_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_match_candidates" ADD CONSTRAINT "invoice_match_candidates_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_match_candidates" ADD CONSTRAINT "invoice_match_candidates_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_match_candidates_identity_idx" ON "invoice_match_candidates" USING btree ("invoice_id","canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "invoice_match_candidates_invoice_idx" ON "invoice_match_candidates" USING btree ("workspace_id","invoice_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_suspected_duplicate_of_invoice_id_invoices_id_fk" FOREIGN KEY ("suspected_duplicate_of_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_duplicate_idx" ON "invoices" USING btree ("workspace_id","suspected_duplicate_of_invoice_id") WHERE suspected_duplicate_of_invoice_id is not null;