CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`date` text NOT NULL,
	`rate` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fx_rates_user_pair_date_source_uq` ON `fx_rates` (`user_id`,`base`,`quote`,`date`,`source`);--> statement-breakpoint
CREATE INDEX `fx_rates_user_id_idx` ON `fx_rates` (`user_id`);--> statement-breakpoint
CREATE TABLE `market_data_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `market_data_settings_user_id_uq` ON `market_data_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`isin` text,
	`symbol` text,
	`currency` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `securities_user_id_idx` ON `securities` (`user_id`);--> statement-breakpoint
CREATE TABLE `security_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`security_id` text NOT NULL,
	`date` text NOT NULL,
	`price` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_prices_security_date_source_uq` ON `security_prices` (`security_id`,`date`,`source`);--> statement-breakpoint
CREATE INDEX `security_prices_user_id_idx` ON `security_prices` (`user_id`);--> statement-breakpoint
CREATE TABLE `trades` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`security_id` text NOT NULL,
	`date` text NOT NULL,
	`side` text NOT NULL,
	`quantity` integer NOT NULL,
	`price` integer NOT NULL,
	`fees` integer DEFAULT 0 NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `trades_user_id_idx` ON `trades` (`user_id`);--> statement-breakpoint
CREATE INDEX `trades_account_security_date_idx` ON `trades` (`account_id`,`security_id`,`date`);--> statement-breakpoint
CREATE INDEX `trades_security_id_idx` ON `trades` (`security_id`);