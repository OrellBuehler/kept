CREATE TABLE `bill_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bill_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`amount` integer NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_allocations_pair_uq` ON `bill_allocations` (`bill_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `bill_allocations_user_id_idx` ON `bill_allocations` (`user_id`);--> statement-breakpoint
CREATE INDEX `bill_allocations_transaction_id_idx` ON `bill_allocations` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'invoice' NOT NULL,
	`creditor_name` text,
	`creditor_iban` text,
	`amount` integer,
	`currency` text NOT NULL,
	`issue_date` text,
	`due_date` text,
	`reference` text,
	`reference_type` text,
	`message` text,
	`invoice_number` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`document_id` text,
	`expected_account_id` text,
	`notes` text,
	`tax_year` integer,
	`external_source` text,
	`external_ref` text,
	`external_url` text,
	`extraction` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`expected_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `bills_user_id_idx` ON `bills` (`user_id`);--> statement-breakpoint
CREATE INDEX `bills_user_due_idx` ON `bills` (`user_id`,`due_date`);--> statement-breakpoint
CREATE INDEX `bills_document_id_idx` ON `bills` (`document_id`);--> statement-breakpoint
CREATE INDEX `bills_expected_account_id_idx` ON `bills` (`expected_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `bills_user_external_uq` ON `bills` (`user_id`,`external_source`,`external_ref`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_user_sha256_uq` ON `documents` (`user_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `documents_user_id_idx` ON `documents` (`user_id`);--> statement-breakpoint
CREATE TABLE `match_dismissals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bill_id` text NOT NULL,
	`transaction_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_dismissals_pair_uq` ON `match_dismissals` (`bill_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `match_dismissals_user_id_idx` ON `match_dismissals` (`user_id`);--> statement-breakpoint
CREATE INDEX `match_dismissals_transaction_id_idx` ON `match_dismissals` (`transaction_id`);