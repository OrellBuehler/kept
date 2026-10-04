CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`out_transaction_id` text,
	`in_transaction_id` text,
	`status` text NOT NULL,
	`method` text NOT NULL,
	`from_account_id` text NOT NULL,
	`to_account_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`out_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`in_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_out_transaction_uq` ON `transfers` (`out_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transfers_in_transaction_uq` ON `transfers` (`in_transaction_id`);--> statement-breakpoint
CREATE INDEX `transfers_user_status_idx` ON `transfers` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `transfers_from_account_idx` ON `transfers` (`from_account_id`);--> statement-breakpoint
CREATE INDEX `transfers_to_account_idx` ON `transfers` (`to_account_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `fill_from_transfers` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `trades_move_cash` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `mirror_of_id` text REFERENCES transactions(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `transactions_mirror_of_id_idx` ON `transactions` (`mirror_of_id`);