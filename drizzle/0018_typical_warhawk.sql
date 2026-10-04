CREATE TABLE `pillar_3a_buy_in_years` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`contribution_id` text NOT NULL,
	`year` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contribution_id`) REFERENCES `pillar_3a_contributions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pillar_3a_buy_in_years_user_year_uq` ON `pillar_3a_buy_in_years` (`user_id`,`year`);--> statement-breakpoint
CREATE INDEX `pillar_3a_buy_in_years_user_id_idx` ON `pillar_3a_buy_in_years` (`user_id`);--> statement-breakpoint
CREATE INDEX `pillar_3a_buy_in_years_contribution_id_idx` ON `pillar_3a_buy_in_years` (`contribution_id`);--> statement-breakpoint
CREATE TABLE `pillar_3a_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`transaction_id` text,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`kind` text DEFAULT 'ordinary' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pillar_3a_contributions_user_id_idx` ON `pillar_3a_contributions` (`user_id`);--> statement-breakpoint
CREATE INDEX `pillar_3a_contributions_portfolio_id_idx` ON `pillar_3a_contributions` (`portfolio_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pillar_3a_contributions_transaction_uq` ON `pillar_3a_contributions` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `pillar_3a_years` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`year` integer NOT NULL,
	`deduction` text DEFAULT 'small' NOT NULL,
	`earned_income` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pillar_3a_years_user_year_uq` ON `pillar_3a_years` (`user_id`,`year`);--> statement-breakpoint
CREATE INDEX `pillar_3a_years_user_id_idx` ON `pillar_3a_years` (`user_id`);--> statement-breakpoint
CREATE TABLE `portfolio_values` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `portfolio_values_portfolio_date_uq` ON `portfolio_values` (`portfolio_id`,`date`);--> statement-breakpoint
CREATE INDEX `portfolio_values_user_id_idx` ON `portfolio_values` (`user_id`);--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`number` text,
	`strategy` text,
	`deposit_reference` text,
	`opened_on` text,
	`closed_on` text,
	`close_reason` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `portfolios_user_id_idx` ON `portfolios` (`user_id`);--> statement-breakpoint
CREATE INDEX `portfolios_account_id_idx` ON `portfolios` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_user_reference_uq` ON `portfolios` (`user_id`,`deposit_reference`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `contract_number` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `deposit_iban` text;