CREATE TABLE `deduction_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category_id` text NOT NULL,
	`deduction_type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deduction_mappings_user_category_uq` ON `deduction_mappings` (`user_id`,`category_id`);--> statement-breakpoint
CREATE INDEX `deduction_mappings_category_id_idx` ON `deduction_mappings` (`category_id`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `deduction_excluded` integer DEFAULT false NOT NULL;