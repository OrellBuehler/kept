CREATE TABLE `change_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_token_id` text,
	`actor_label` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`summary` text,
	`before` text,
	`after` text,
	`reverted_at` integer,
	`reverted_by_entry_id` text,
	`revert_of_entry_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `change_log_user_seq_idx` ON `change_log` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `change_log_user_actor_idx` ON `change_log` (`user_id`,`actor_kind`,`seq`);--> statement-breakpoint
CREATE INDEX `change_log_user_token_idx` ON `change_log` (`user_id`,`actor_token_id`,`seq`);--> statement-breakpoint
CREATE INDEX `change_log_user_entity_idx` ON `change_log` (`user_id`,`entity_type`,`entity_id`,`seq`);