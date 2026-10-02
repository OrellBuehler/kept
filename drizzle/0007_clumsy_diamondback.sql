CREATE TABLE `paperless_dismissed` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`external_ref` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paperless_dismissed_user_ref_uq` ON `paperless_dismissed` (`user_id`,`external_ref`);