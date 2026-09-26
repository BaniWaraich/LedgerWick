CREATE TABLE "candidate_email_documents" (
	"workspace_id" uuid NOT NULL,
	"candidate_email_id" uuid NOT NULL,
	"document_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supporting_documents" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "candidate_email_documents" ADD CONSTRAINT "candidate_email_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_email_documents" ADD CONSTRAINT "candidate_email_documents_candidate_email_id_candidate_emails_id_fk" FOREIGN KEY ("candidate_email_id") REFERENCES "public"."candidate_emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_email_documents" ADD CONSTRAINT "candidate_email_documents_document_id_supporting_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."supporting_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_email_documents_pk" ON "candidate_email_documents" USING btree ("candidate_email_id","document_id");--> statement-breakpoint
CREATE INDEX "candidate_email_documents_document_idx" ON "candidate_email_documents" USING btree ("workspace_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supporting_documents_gmail_content_idx" ON "supporting_documents" USING btree ("workspace_id","content_hash") WHERE source = 'GMAIL' and content_hash is not null;