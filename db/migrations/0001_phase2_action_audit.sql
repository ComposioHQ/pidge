CREATE TABLE "action_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"eve_session_id" text NOT NULL,
	"tool_slug" text NOT NULL,
	"risk" text NOT NULL,
	"approval" text NOT NULL,
	"outcome" text NOT NULL,
	"composio_log_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_audit" ADD CONSTRAINT "action_audit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_audit_user" ON "action_audit" USING btree ("user_id","created_at");