CREATE TABLE `paperless_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`base_url` text NOT NULL,
	`token_encrypted` text NOT NULL,
	`api_version` integer,
	`server_version` text,
	`bill_source` text,
	`field_mapping` text,
	`webhook_secret_hash` text NOT NULL,
	`webhook_token` text NOT NULL,
	`allow_insecure_tls` integer DEFAULT false NOT NULL,
	`last_sync_at` integer,
	`last_sync_modified` integer,
	`last_error` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paperless_connections_user_uq` ON `paperless_connections` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `paperless_connections_token_uq` ON `paperless_connections` (`webhook_token`);--> statement-breakpoint
CREATE TABLE `paperless_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`paperless_id` integer NOT NULL,
	`bill_id` text,
	`document_id` text,
	`modified` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`content_sha256` text,
	`last_pushed_hash` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `paperless_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bill_id`) REFERENCES `bills`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paperless_documents_conn_doc_uq` ON `paperless_documents` (`connection_id`,`paperless_id`);--> statement-breakpoint
CREATE INDEX `paperless_documents_user_id_idx` ON `paperless_documents` (`user_id`);--> statement-breakpoint
CREATE INDEX `paperless_documents_bill_id_idx` ON `paperless_documents` (`bill_id`);--> statement-breakpoint
CREATE TABLE `paperless_report_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`report_kind` text NOT NULL,
	`sha256` text NOT NULL,
	`paperless_document_id` integer,
	`task_id` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `paperless_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paperless_report_uploads_conn_sha_uq` ON `paperless_report_uploads` (`connection_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `paperless_report_uploads_user_id_idx` ON `paperless_report_uploads` (`user_id`);