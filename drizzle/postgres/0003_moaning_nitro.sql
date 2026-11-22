CREATE TABLE "change_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_token_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text,
	"before" json,
	"after" json,
	"reverted_at" timestamp (3) with time zone,
	"reverted_by_entry_id" text,
	"revert_of_entry_id" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "change_log_user_seq_idx" ON "change_log" USING btree ("user_id","seq");--> statement-breakpoint
CREATE INDEX "change_log_user_actor_idx" ON "change_log" USING btree ("user_id","actor_kind","seq");--> statement-breakpoint
CREATE INDEX "change_log_user_token_idx" ON "change_log" USING btree ("user_id","actor_token_id","seq");--> statement-breakpoint
CREATE INDEX "change_log_user_entity_idx" ON "change_log" USING btree ("user_id","entity_type","entity_id","seq");