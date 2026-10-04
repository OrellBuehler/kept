-- seq replaces rowid as the insertion-order tie-break. Existing rows take their
-- rowid, which keeps today's order; new rows get larger values from the app.
ALTER TABLE `category_rules` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tax_credits` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trades` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `category_rules` SET `seq` = `rowid`;--> statement-breakpoint
UPDATE `tax_credits` SET `seq` = `rowid`;--> statement-breakpoint
UPDATE `trades` SET `seq` = `rowid`;--> statement-breakpoint
UPDATE `transactions` SET `seq` = `rowid`;
