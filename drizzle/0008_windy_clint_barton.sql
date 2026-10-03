CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`kind` text NOT NULL,
	`challenge` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_challenges_user_id_idx` ON `auth_challenges` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_events_user_id_idx` ON `auth_events` (`user_id`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_id_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_codes_user_id_idx` ON `recovery_codes` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_codes_hash_uq` ON `recovery_codes` (`user_id`,`code_hash`);--> statement-breakpoint
CREATE TABLE `totp_credentials` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`confirmed_at` integer,
	`last_step` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
