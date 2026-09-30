CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`institution_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`iban` text,
	`opening_balance` integer DEFAULT 0 NOT NULL,
	`opening_date` text,
	`archived` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_iban_uq` ON `accounts` (`user_id`,`iban`);--> statement-breakpoint
CREATE INDEX `accounts_user_id_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `accounts_institution_id_idx` ON `accounts` (`institution_id`);--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`import_id` text,
	`source` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_snapshots_account_date_source_uq` ON `balance_snapshots` (`account_id`,`date`,`source`);--> statement-breakpoint
CREATE INDEX `balance_snapshots_user_id_idx` ON `balance_snapshots` (`user_id`);--> statement-breakpoint
CREATE INDEX `balance_snapshots_import_id_idx` ON `balance_snapshots` (`import_id`);--> statement-breakpoint
CREATE TABLE `csv_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`profile` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `csv_profiles_account_uq` ON `csv_profiles` (`account_id`);--> statement-breakpoint
CREATE INDEX `csv_profiles_user_id_idx` ON `csv_profiles` (`user_id`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`format` text NOT NULL,
	`file_name` text NOT NULL,
	`file_sha256` text NOT NULL,
	`statement_from` text,
	`statement_to` text,
	`opening_balance` integer,
	`opening_balance_date` text,
	`closing_balance` integer,
	`closing_balance_date` text,
	`new_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `imports_user_id_idx` ON `imports` (`user_id`);--> statement-breakpoint
CREATE INDEX `imports_account_id_idx` ON `imports` (`account_id`);--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`bic` text,
	`color` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_user_name_uq` ON `institutions` (`user_id`,`name`);--> statement-breakpoint
CREATE INDEX `institutions_user_id_idx` ON `institutions` (`user_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`import_id` text,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`booking_date` text NOT NULL,
	`value_date` text,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`original_amount` integer,
	`original_currency` text,
	`counterparty_name` text,
	`counterparty_iban` text,
	`description` text,
	`reference` text,
	`reference_type` text,
	`reversal` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_account_external_uq` ON `transactions` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `transactions_account_booking_idx` ON `transactions` (`account_id`,`booking_date`);--> statement-breakpoint
CREATE INDEX `transactions_user_id_idx` ON `transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `transactions_import_id_idx` ON `transactions` (`import_id`);