CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_username` text NOT NULL,
	`action` text NOT NULL,
	`target_user_id` text,
	`target_username` text,
	`details` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_audit_log_created_at_idx` ON `admin_audit_log` (`created_at`);