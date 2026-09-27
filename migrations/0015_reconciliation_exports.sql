CREATE TYPE "public"."export_state" AS ENUM('GENERATING', 'READY', 'FAILED');--> statement-breakpoint
CREATE TABLE "reconciliation_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"state" "export_state" DEFAULT 'GENERATING' NOT NULL,
	"storage_ref" text,
	"filename" text NOT NULL,
	"transaction_count" integer,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "reconciliation_exports_file_check" CHECK (("reconciliation_exports"."state" = 'READY') = ("reconciliation_exports"."storage_ref" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "reconciliation_exports" ADD CONSTRAINT "reconciliation_exports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_exports_workspace_idx" ON "reconciliation_exports" USING btree ("workspace_id","requested_at");