CREATE TABLE "memory_dream_leases" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"token" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_dream_leases" ADD CONSTRAINT "memory_dream_leases_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Keep older rows as provenance, but resolve any active duplicates created before this constraint.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY user_id, tier, content_hash ORDER BY origin, created_at, id) AS n
  FROM memory_items WHERE status = 'active'
)
UPDATE memory_items SET status = CASE WHEN tier = 'fact' THEN 'superseded' ELSE 'consolidated' END
WHERE id IN (SELECT id FROM ranked WHERE n > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_items_active_text" ON "memory_items" USING btree ("user_id","tier","content_hash") WHERE "memory_items"."status" = 'active';