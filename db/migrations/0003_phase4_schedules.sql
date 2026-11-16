CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"eve_session_id" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"delivery_handle" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"kind" text NOT NULL,
	"cron" text,
	"every_minutes" integer,
	"timezone" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_job_id_scheduled_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scheduled_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_jobs_user" ON "scheduled_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_due" ON "scheduled_jobs" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_runs_occurrence" ON "scheduled_runs" USING btree ("job_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "scheduled_runs_status" ON "scheduled_runs" USING btree ("status","lease_expires_at");