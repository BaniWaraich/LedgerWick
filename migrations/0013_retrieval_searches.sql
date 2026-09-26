CREATE TYPE "public"."fetch_outcome" AS ENUM('FETCHED', 'NO_ATTACHMENT', 'MESSAGE_GONE');--> statement-breakpoint
CREATE TYPE "public"."mailbox_search_outcome" AS ENUM('COMPLETED', 'NEEDS_REAUTH', 'FAILED');--> statement-breakpoint
CREATE TABLE "candidate_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"gmail_connection_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"rfc822_message_id" text,
	"from_header" text NOT NULL,
	"subject" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"found_by" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"fetch_outcome" "fetch_outcome",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"gmail_connection_id" uuid NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"outcome" "mailbox_search_outcome" NOT NULL,
	"messages_found" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"searched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidate_emails" ADD CONSTRAINT "candidate_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_emails" ADD CONSTRAINT "candidate_emails_requirement_id_invoice_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."invoice_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_emails" ADD CONSTRAINT "candidate_emails_gmail_connection_id_gmail_connections_id_fk" FOREIGN KEY ("gmail_connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_searches" ADD CONSTRAINT "mailbox_searches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_searches" ADD CONSTRAINT "mailbox_searches_requirement_id_invoice_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."invoice_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_searches" ADD CONSTRAINT "mailbox_searches_gmail_connection_id_gmail_connections_id_fk" FOREIGN KEY ("gmail_connection_id") REFERENCES "public"."gmail_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_emails_identity_idx" ON "candidate_emails" USING btree ("requirement_id","gmail_connection_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "candidate_emails_requirement_idx" ON "candidate_emails" USING btree ("workspace_id","requirement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_searches_identity_idx" ON "mailbox_searches" USING btree ("requirement_id","gmail_connection_id");--> statement-breakpoint
CREATE INDEX "mailbox_searches_outcome_idx" ON "mailbox_searches" USING btree ("workspace_id","outcome");