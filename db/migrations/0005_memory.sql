CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"content" text,
	"content_hash" text NOT NULL,
	"eve_session_id" text,
	"channel" text,
	"source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_items_user" ON "memory_items" USING btree ("user_id","tier","status");--> statement-breakpoint
CREATE INDEX "memory_items_search" ON "memory_items" USING gin ("search");