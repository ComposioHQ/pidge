CREATE TABLE "approval_guards" (
	"call_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"eve_session_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_guards" ADD CONSTRAINT "approval_guards_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;