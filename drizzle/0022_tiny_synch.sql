ALTER TABLE `accounts` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `notice_months` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `free_withdrawal` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `free_withdrawal_period` text;--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `investment_cash_liquid` integer DEFAULT false NOT NULL;