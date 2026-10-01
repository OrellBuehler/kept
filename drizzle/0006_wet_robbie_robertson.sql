CREATE TABLE `tax_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tax_year_id` text NOT NULL,
	`booking_date` text NOT NULL,
	`amount` integer NOT NULL,
	`reference` text,
	`description` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tax_year_id`) REFERENCES `tax_years`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tax_credits_user_id_idx` ON `tax_credits` (`user_id`);--> statement-breakpoint
CREATE INDEX `tax_credits_tax_year_id_idx` ON `tax_credits` (`tax_year_id`);--> statement-breakpoint
CREATE TABLE `tax_years` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`year` integer NOT NULL,
	`authority` text,
	`currency` text NOT NULL,
	`assessed_total` integer,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_years_user_year_uq` ON `tax_years` (`user_id`,`year`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `tax_year` integer;--> statement-breakpoint
CREATE INDEX `transactions_user_tax_year_idx` ON `transactions` (`user_id`,`tax_year`);--> statement-breakpoint
CREATE INDEX `bills_user_tax_year_idx` ON `bills` (`user_id`,`tax_year`);