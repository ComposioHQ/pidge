CREATE TABLE "browser_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"browser_task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"mode" text NOT NULL,
	"remote_task_id" text,
	"remote_browser_session_id" text,
	"status" text NOT NULL,
	"instant_charge" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_task_runs_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "browser_task_runs_remote_task_id_unique" UNIQUE("remote_task_id")
);
--> statement-breakpoint
CREATE TABLE "browser_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"eve_session_id" text NOT NULL,
	"composio_session_id" text,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_info" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"email" text,
	"phone" text,
	"home_area" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_task_runs" ADD CONSTRAINT "browser_task_runs_browser_task_id_browser_tasks_id_fk" FOREIGN KEY ("browser_task_id") REFERENCES "public"."browser_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_task_runs" ADD CONSTRAINT "browser_task_runs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tasks" ADD CONSTRAINT "browser_tasks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_info" ADD CONSTRAINT "personal_info_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_task_runs_task" ON "browser_task_runs" USING btree ("browser_task_id");--> statement-breakpoint
CREATE INDEX "browser_tasks_user" ON "browser_tasks" USING btree ("user_id","created_at");