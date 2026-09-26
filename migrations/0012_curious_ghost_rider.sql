CREATE TYPE "public"."gmail_connection_state" AS ENUM('CONNECTED', 'NEEDS_REAUTH', 'DISCONNECTED');--> statement-breakpoint
CREATE TABLE "gmail_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"google_subject" text NOT NULL,
	"email" text NOT NULL,
	"state" "gmail_connection_state" NOT NULL,
	"granted_scopes" text NOT NULL,
	"encrypted_refresh_token" text,
	"connected_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_connections_credentials_check" CHECK (("gmail_connections"."state" = 'DISCONNECTED') = ("gmail_connections"."encrypted_refresh_token" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "gmail_connections" ADD CONSTRAINT "gmail_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_connections_identity_idx" ON "gmail_connections" USING btree ("workspace_id","google_subject");--> statement-breakpoint
CREATE INDEX "gmail_connections_workspace_state_idx" ON "gmail_connections" USING btree ("workspace_id","state");