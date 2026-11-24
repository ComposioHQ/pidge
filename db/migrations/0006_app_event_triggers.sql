CREATE TABLE "app_event_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"turn_id" text,
	"event_id" text NOT NULL,
	"payload" jsonb,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_event_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"eve_session_id" text NOT NULL,
	"conversation" text NOT NULL,
	"handle" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"toolkit" text NOT NULL,
	"trigger_slug" text NOT NULL,
	"trigger_id" text,
	"config" jsonb NOT NULL,
	"instruction" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_event_subscriptions_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "app_event_subscriptions_trigger_id_unique" UNIQUE("trigger_id")
);
--> statement-breakpoint
ALTER TABLE "app_event_runs" ADD CONSTRAINT "app_event_runs_subscription_id_app_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."app_event_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_event_subscriptions" ADD CONSTRAINT "app_event_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_event_runs_event" ON "app_event_runs" USING btree ("subscription_id","event_id");--> statement-breakpoint
CREATE INDEX "app_event_runs_due" ON "app_event_runs" USING btree ("status","retry_at");--> statement-breakpoint
CREATE INDEX "app_event_subscriptions_user" ON "app_event_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_event_subscriptions_account_type" ON "app_event_subscriptions" USING btree ("connected_account_id","trigger_slug") WHERE "app_event_subscriptions"."status" <> 'removed';