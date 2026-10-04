ALTER TABLE `accounts` ADD `share_bps` integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `shared_with` text;