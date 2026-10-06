CREATE TABLE "external_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_entity_source_url_uq" ON "external_links" USING btree ("user_id","entity_type","entity_id","source","url");--> statement-breakpoint
CREATE INDEX "external_links_entity_idx" ON "external_links" USING btree ("entity_type","entity_id");