CREATE TABLE `pending_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`format` text NOT NULL,
	`file_name` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_imports_user_id_idx` ON `pending_imports` (`user_id`);--> statement-breakpoint
CREATE INDEX `pending_imports_expires_at_idx` ON `pending_imports` (`expires_at`);