CREATE TABLE `user_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`iban_display` text NOT NULL,
	`blur_amounts` integer NOT NULL,
	`locale` text NOT NULL,
	`default_currency` text NOT NULL,
	`page_size` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_preferences_user_id_uq` ON `user_preferences` (`user_id`);