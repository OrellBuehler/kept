CREATE TABLE `inbox_files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`file_name` text NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	`account_id` text,
	`import_id` text,
	`new_count` integer,
	`duplicate_count` integer,
	`review_file` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_files_user_sha_uq` ON `inbox_files` (`user_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `inbox_files_user_created_idx` ON `inbox_files` (`user_id`,`created_at`);