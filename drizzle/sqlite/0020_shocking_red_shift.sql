CREATE TABLE `deduction_year_migration` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`old_tax_year` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deduction_year_migration_tx_uq` ON `deduction_year_migration` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `deduction_year_migration_user_year_idx` ON `deduction_year_migration` (`user_id`,`old_tax_year`);--> statement-breakpoint
CREATE TABLE `paperless_pending` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`paperless_id` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`first_failed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `paperless_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paperless_pending_conn_doc_uq` ON `paperless_pending` (`connection_id`,`paperless_id`);--> statement-breakpoint
CREATE INDEX `paperless_pending_user_id_idx` ON `paperless_pending` (`user_id`);--> statement-breakpoint
ALTER TABLE `trades` ADD `split_new` integer;--> statement-breakpoint
ALTER TABLE `trades` ADD `split_old` integer;