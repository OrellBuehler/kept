CREATE TABLE `external_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_links_entity_source_url_uq` ON `external_links` (`user_id`,`entity_type`,`entity_id`,`source`,`url`);--> statement-breakpoint
CREATE INDEX `external_links_entity_idx` ON `external_links` (`entity_type`,`entity_id`);