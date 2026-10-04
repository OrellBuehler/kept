CREATE TABLE `recurring_series` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`status` text DEFAULT 'suggested' NOT NULL,
	`edited` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`counterparty_iban` text,
	`cadence` text NOT NULL,
	`currency` text NOT NULL,
	`amount` integer NOT NULL,
	`first_date` text NOT NULL,
	`last_date` text NOT NULL,
	`last_amount` integer NOT NULL,
	`previous_amount` integer,
	`occurrences` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_series_user_key_uq` ON `recurring_series` (`user_id`,`key`);--> statement-breakpoint
CREATE INDEX `recurring_series_user_id_idx` ON `recurring_series` (`user_id`);