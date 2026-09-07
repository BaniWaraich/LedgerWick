CREATE TYPE "public"."classification" AS ENUM('IS_INVOICE', 'UNCERTAIN', 'IS_NOT_INVOICE');--> statement-breakpoint
CREATE TYPE "public"."direction" AS ENUM('DEBIT', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."document_source" AS ENUM('GMAIL', 'MANUAL_UPLOAD');--> statement-breakpoint
CREATE TYPE "public"."document_state" AS ENUM('STORED', 'EXTRACTING', 'CLASSIFYING', 'EXTRACTED', 'UNREADABLE', 'NOT_AN_INVOICE');--> statement-breakpoint
CREATE TYPE "public"."requirement_state" AS ENUM('IDENTIFIED', 'SEARCHING', 'EVALUATING', 'NEEDS_REVIEW', 'NOT_FOUND', 'RESOLVED', 'BLOCKED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."resolution_method" AS ENUM('AUTO_RETRIEVED', 'AUTO_MATCHED', 'USER_CONFIRMED', 'USER_LINKED', 'NOT_REQUIRED');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('RUNNING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."statement_state" AS ENUM('UPLOADING', 'IDENTIFYING', 'PARSING', 'VALIDATING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."validation_outcome" AS ENUM('VALID', 'DISCREPANCY');--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"account_identifier" text NOT NULL,
	"account_type" text,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bank_account_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"storage_ref" text NOT NULL,
	"state" "statement_state" DEFAULT 'UPLOADING' NOT NULL,
	"validation_outcome" "validation_outcome",
	"failure_reason" text,
	"period_start" date,
	"period_end" date,
	"opening_balance" bigint,
	"closing_balance" bigint,
	"total_credits" bigint,
	"total_debits" bigint,
	"line_count" integer,
	"column_mapping" jsonb,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_knowledge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"value_date" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"direction" "direction" NOT NULL,
	"currency" text NOT NULL,
	"description" text NOT NULL,
	"description_normalized" text NOT NULL,
	"occurrence_index" integer DEFAULT 0 NOT NULL,
	"external_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarification_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_transaction_id" uuid,
	"question" text NOT NULL,
	"options" jsonb,
	"answer" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_documents" (
	"invoice_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"state" "requirement_state" DEFAULT 'IDENTIFIED' NOT NULL,
	"reason" text,
	"resolution_method" "resolution_method",
	"resolved_document_id" uuid,
	"rejected_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"vendor_id" uuid,
	"invoice_number" text,
	"invoice_date" date,
	"total_minor" bigint,
	"currency" text,
	"tax_minor" bigint,
	"subtotal_minor" bigint,
	"canonical_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"state" "run_state" DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"coverage_start" date,
	"coverage_end" date,
	"transactions_processed" integer,
	"documents_required" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"row_index" integer NOT NULL,
	"value_date" date NOT NULL,
	"description" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"direction" "direction" NOT NULL,
	"balance_minor" bigint,
	"canonical_transaction_id" uuid
);
--> statement-breakpoint
CREATE TABLE "supporting_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_ref" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"source" "document_source" NOT NULL,
	"state" "document_state" DEFAULT 'STORED' NOT NULL,
	"classification" "classification",
	"source_metadata" jsonb,
	"canonical_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"alias_normalized" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_knowledge" ADD CONSTRAINT "business_knowledge_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_transactions" ADD CONSTRAINT "canonical_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_transactions" ADD CONSTRAINT "canonical_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_questions" ADD CONSTRAINT "clarification_questions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarification_questions" ADD CONSTRAINT "clarification_questions_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_document_id_supporting_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."supporting_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requirements" ADD CONSTRAINT "invoice_requirements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requirements" ADD CONSTRAINT "invoice_requirements_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_requirements" ADD CONSTRAINT "invoice_requirements_resolved_document_id_supporting_documents_id_fk" FOREIGN KEY ("resolved_document_id") REFERENCES "public"."supporting_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supporting_documents" ADD CONSTRAINT "supporting_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supporting_documents" ADD CONSTRAINT "supporting_documents_canonical_transaction_id_canonical_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."canonical_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_aliases" ADD CONSTRAINT "vendor_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_aliases" ADD CONSTRAINT "vendor_aliases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_identity_idx" ON "bank_accounts" USING btree ("workspace_id","bank_name","account_identifier");--> statement-breakpoint
CREATE INDEX "bank_statements_workspace_idx" ON "bank_statements" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "bank_statements_coverage_idx" ON "bank_statements" USING btree ("bank_account_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "business_knowledge_identity_idx" ON "business_knowledge" USING btree ("workspace_id","kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_transactions_identity_idx" ON "canonical_transactions" USING btree ("bank_account_id","value_date","amount_minor","direction","description_normalized","occurrence_index");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_transactions_reference_idx" ON "canonical_transactions" USING btree ("bank_account_id","external_reference") WHERE external_reference is not null;--> statement-breakpoint
CREATE INDEX "canonical_transactions_workspace_date_idx" ON "canonical_transactions" USING btree ("workspace_id","value_date");--> statement-breakpoint
CREATE INDEX "clarification_questions_open_idx" ON "clarification_questions" USING btree ("workspace_id","answered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_pk" ON "invoice_documents" USING btree ("invoice_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_requirements_transaction_idx" ON "invoice_requirements" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "invoice_requirements_queue_idx" ON "invoice_requirements" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_transaction_idx" ON "invoices" USING btree ("canonical_transaction_id") WHERE canonical_transaction_id is not null;--> statement-breakpoint
CREATE INDEX "invoices_workspace_idx" ON "invoices" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_workspace_idx" ON "reconciliation_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_lines_row_idx" ON "statement_lines" USING btree ("statement_id","row_index");--> statement-breakpoint
CREATE INDEX "statement_lines_canonical_idx" ON "statement_lines" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE INDEX "supporting_documents_workspace_idx" ON "supporting_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "supporting_documents_transaction_idx" ON "supporting_documents" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_aliases_identity_idx" ON "vendor_aliases" USING btree ("workspace_id","alias_normalized");--> statement-breakpoint
CREATE INDEX "vendors_workspace_idx" ON "vendors" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspaces_owner_idx" ON "workspaces" USING btree ("owner_id");