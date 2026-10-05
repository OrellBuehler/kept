CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`config_encrypted` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_channels_user_kind_uq` ON `notification_channels` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `notification_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bill_due_enabled` integer DEFAULT false NOT NULL,
	`bill_due_days` integer DEFAULT 3 NOT NULL,
	`bill_overdue_enabled` integer DEFAULT false NOT NULL,
	`budget_enabled` integer DEFAULT false NOT NULL,
	`budget_percent` integer DEFAULT 100 NOT NULL,
	`stale_import_enabled` integer DEFAULT false NOT NULL,
	`stale_import_days` integer DEFAULT 14 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_settings_user_id_unique` ON `notification_settings` (`user_id`);--> statement-breakpoint
CREATE TABLE `notifications_sent` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`event_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_sent_user_key_uq` ON `notifications_sent` (`user_id`,`event_key`);