CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"institution_id" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"currency" text NOT NULL,
	"iban" text,
	"opening_balance" bigint DEFAULT 0 NOT NULL,
	"opening_date" text,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp (3) with time zone,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"share_bps" bigint DEFAULT 10000 NOT NULL,
	"shared_with" text,
	"contract_number" text,
	"deposit_iban" text,
	"notice_months" bigint,
	"free_withdrawal" bigint,
	"free_withdrawal_period" text,
	"fill_from_transfers" boolean DEFAULT false NOT NULL,
	"trades_move_cash" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_username" text NOT NULL,
	"action" text NOT NULL,
	"target_user_id" text,
	"target_username" text,
	"details" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"kind" text NOT NULL,
	"challenge" text,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"import_id" text,
	"source" text NOT NULL,
	"date" text NOT NULL,
	"amount" bigint NOT NULL,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bill_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'invoice' NOT NULL,
	"creditor_name" text,
	"creditor_iban" text,
	"amount" bigint,
	"currency" text NOT NULL,
	"issue_date" text,
	"due_date" text,
	"reference" text,
	"reference_type" text,
	"message" text,
	"invoice_number" text,
	"cancelled" boolean DEFAULT false NOT NULL,
	"document_id" text,
	"expected_account_id" text,
	"notes" text,
	"tax_year" bigint,
	"external_source" text,
	"external_ref" text,
	"external_url" text,
	"extraction" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"kind" text DEFAULT 'expense' NOT NULL,
	"color" text,
	"icon" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category_id" text NOT NULL,
	"priority" bigint DEFAULT 100 NOT NULL,
	"counterparty_contains" text,
	"description_contains" text,
	"counterparty_iban" text,
	"amount_sign" text,
	"seq" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csv_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"profile" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deduction_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category_id" text NOT NULL,
	"deduction_type" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deduction_year_migration" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"old_tax_year" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_account_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"threshold" bigint,
	"is_default_payment" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"date" text NOT NULL,
	"rate" bigint NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"format" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"statement_from" text,
	"statement_to" text,
	"opening_balance" bigint,
	"opening_balance_date" text,
	"closing_balance" bigint,
	"closing_balance_date" text,
	"new_count" bigint DEFAULT 0 NOT NULL,
	"duplicate_count" bigint DEFAULT 0 NOT NULL,
	"warnings" text DEFAULT '[]' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_files" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"file_name" text NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"account_id" text,
	"import_id" text,
	"new_count" bigint,
	"duplicate_count" bigint,
	"review_file" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"bic" text,
	"color" text,
	"logo" "bytea",
	"logo_mime" text,
	"logo_version" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_data_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp (3) with time zone,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bill_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"config_encrypted" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp (3) with time zone,
	"last_error" text,
	"last_error_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bill_due_enabled" boolean DEFAULT false NOT NULL,
	"bill_due_days" bigint DEFAULT 3 NOT NULL,
	"bill_overdue_enabled" boolean DEFAULT false NOT NULL,
	"budget_enabled" boolean DEFAULT false NOT NULL,
	"budget_percent" bigint DEFAULT 100 NOT NULL,
	"stale_import_enabled" boolean DEFAULT false NOT NULL,
	"stale_import_days" bigint DEFAULT 14 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "notification_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "notifications_sent" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"event_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paperless_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"base_url" text NOT NULL,
	"instance_key" text,
	"token_encrypted" text NOT NULL,
	"api_version" bigint,
	"server_version" text,
	"bill_source" json,
	"field_mapping" json,
	"webhook_secret_hash" text NOT NULL,
	"webhook_token" text NOT NULL,
	"allow_insecure_tls" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp (3) with time zone,
	"last_sync_modified" bigint,
	"last_error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paperless_dismissed" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"external_ref" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paperless_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"paperless_id" bigint NOT NULL,
	"bill_id" text,
	"document_id" text,
	"modified" bigint NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"content_sha256" text,
	"last_pushed_hash" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paperless_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"base_url" text NOT NULL,
	"instance_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paperless_pending" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"paperless_id" bigint NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"first_failed_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paperless_report_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"report_kind" text NOT NULL,
	"sha256" text NOT NULL,
	"paperless_document_id" bigint,
	"task_id" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "pending_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"format" text NOT NULL,
	"file_name" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pillar_3a_buy_in_years" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"contribution_id" text NOT NULL,
	"year" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pillar_3a_contributions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_id" text NOT NULL,
	"transaction_id" text,
	"date" text NOT NULL,
	"amount" bigint NOT NULL,
	"kind" text DEFAULT 'ordinary' NOT NULL,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pillar_3a_years" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"year" bigint NOT NULL,
	"deduction" text DEFAULT 'small' NOT NULL,
	"earned_income" bigint,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planned_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text,
	"date" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_values" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"portfolio_id" text NOT NULL,
	"date" text NOT NULL,
	"amount" bigint NOT NULL,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"number" text,
	"strategy" text,
	"deposit_reference" text,
	"opened_on" text,
	"closed_on" text,
	"close_reason" text,
	"sort_order" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_series" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"counterparty_iban" text,
	"cadence" text NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"first_date" text NOT NULL,
	"last_date" text NOT NULL,
	"last_amount" bigint NOT NULL,
	"previous_amount" bigint,
	"occurrences" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "securities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"isin" text,
	"symbol" text,
	"currency" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"security_id" text NOT NULL,
	"date" text NOT NULL,
	"price" bigint NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"reauth_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"tax_year_id" text NOT NULL,
	"booking_date" text NOT NULL,
	"amount" bigint NOT NULL,
	"reference" text,
	"description" text,
	"seq" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_years" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"year" bigint NOT NULL,
	"authority" text,
	"currency" text NOT NULL,
	"assessed_total" bigint,
	"notes" text,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "totp_credentials" (
	"user_id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"confirmed_at" timestamp (3) with time zone,
	"last_step" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"security_id" text NOT NULL,
	"date" text NOT NULL,
	"side" text NOT NULL,
	"quantity" bigint NOT NULL,
	"price" bigint NOT NULL,
	"fees" bigint DEFAULT 0 NOT NULL,
	"amount" bigint NOT NULL,
	"split_new" bigint,
	"split_old" bigint,
	"note" text,
	"seq" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"import_id" text,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"mirror_of_id" text,
	"booking_date" text NOT NULL,
	"value_date" text,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"original_amount" bigint,
	"original_currency" text,
	"counterparty_name" text,
	"counterparty_iban" text,
	"description" text,
	"reference" text,
	"reference_type" text,
	"reversal" boolean DEFAULT false NOT NULL,
	"note" text,
	"category_id" text,
	"tax_year" bigint,
	"deduction_year" bigint,
	"deduction_excluded" boolean DEFAULT false NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"out_transaction_id" text,
	"in_transaction_id" text,
	"status" text NOT NULL,
	"method" text NOT NULL,
	"from_account_id" text NOT NULL,
	"to_account_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"iban_display" text NOT NULL,
	"blur_amounts" boolean NOT NULL,
	"locale" text NOT NULL,
	"default_currency" text NOT NULL,
	"page_size" bigint NOT NULL,
	"investment_cash_liquid" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_allocations" ADD CONSTRAINT "bill_allocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_allocations" ADD CONSTRAINT "bill_allocations_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_allocations" ADD CONSTRAINT "bill_allocations_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_expected_account_id_accounts_id_fk" FOREIGN KEY ("expected_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_rules" ADD CONSTRAINT "category_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_profiles" ADD CONSTRAINT "csv_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_profiles" ADD CONSTRAINT "csv_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deduction_mappings" ADD CONSTRAINT "deduction_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deduction_mappings" ADD CONSTRAINT "deduction_mappings_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deduction_year_migration" ADD CONSTRAINT "deduction_year_migration_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deduction_year_migration" ADD CONSTRAINT "deduction_year_migration_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_account_settings" ADD CONSTRAINT "forecast_account_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_account_settings" ADD CONSTRAINT "forecast_account_settings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_files" ADD CONSTRAINT "inbox_files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_files" ADD CONSTRAINT "inbox_files_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_files" ADD CONSTRAINT "inbox_files_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_data_settings" ADD CONSTRAINT "market_data_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_dismissals" ADD CONSTRAINT "match_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_dismissals" ADD CONSTRAINT "match_dismissals_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_dismissals" ADD CONSTRAINT "match_dismissals_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications_sent" ADD CONSTRAINT "notifications_sent_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_connections" ADD CONSTRAINT "paperless_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_dismissed" ADD CONSTRAINT "paperless_dismissed_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_documents" ADD CONSTRAINT "paperless_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_documents" ADD CONSTRAINT "paperless_documents_connection_id_paperless_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."paperless_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_documents" ADD CONSTRAINT "paperless_documents_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_documents" ADD CONSTRAINT "paperless_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_instances" ADD CONSTRAINT "paperless_instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_pending" ADD CONSTRAINT "paperless_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_pending" ADD CONSTRAINT "paperless_pending_connection_id_paperless_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."paperless_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_report_uploads" ADD CONSTRAINT "paperless_report_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_report_uploads" ADD CONSTRAINT "paperless_report_uploads_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."paperless_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_imports" ADD CONSTRAINT "pending_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_imports" ADD CONSTRAINT "pending_imports_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pillar_3a_buy_in_years" ADD CONSTRAINT "pillar_3a_buy_in_years_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pillar_3a_buy_in_years" ADD CONSTRAINT "pillar_3a_buy_in_years_contribution_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."pillar_3a_contributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pillar_3a_contributions" ADD CONSTRAINT "pillar_3a_contributions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pillar_3a_contributions" ADD CONSTRAINT "pillar_3a_contributions_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pillar_3a_contributions" ADD CONSTRAINT "pillar_3a_contributions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pillar_3a_years" ADD CONSTRAINT "pillar_3a_years_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_items" ADD CONSTRAINT "planned_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_items" ADD CONSTRAINT "planned_items_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_values" ADD CONSTRAINT "portfolio_values_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_values" ADD CONSTRAINT "portfolio_values_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "securities" ADD CONSTRAINT "securities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_prices" ADD CONSTRAINT "security_prices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_prices" ADD CONSTRAINT "security_prices_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_credits" ADD CONSTRAINT "tax_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_credits" ADD CONSTRAINT "tax_credits_tax_year_id_tax_years_id_fk" FOREIGN KEY ("tax_year_id") REFERENCES "public"."tax_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_years" ADD CONSTRAINT "tax_years_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_credentials" ADD CONSTRAINT "totp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_mirror_of_id_transactions_id_fk" FOREIGN KEY ("mirror_of_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_out_transaction_id_transactions_id_fk" FOREIGN KEY ("out_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_in_transaction_id_transactions_id_fk" FOREIGN KEY ("in_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_iban_uq" ON "accounts" USING btree ("user_id","iban");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_institution_id_idx" ON "accounts" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_at_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_challenges_user_id_idx" ON "auth_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_events_user_id_idx" ON "auth_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "balance_snapshots_account_date_source_uq" ON "balance_snapshots" USING btree ("account_id","date","source");--> statement-breakpoint
CREATE INDEX "balance_snapshots_user_id_idx" ON "balance_snapshots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "balance_snapshots_import_id_idx" ON "balance_snapshots" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_allocations_pair_uq" ON "bill_allocations" USING btree ("bill_id","transaction_id");--> statement-breakpoint
CREATE INDEX "bill_allocations_user_id_idx" ON "bill_allocations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bill_allocations_transaction_id_idx" ON "bill_allocations" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "bills_user_id_idx" ON "bills" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bills_user_tax_year_idx" ON "bills" USING btree ("user_id","tax_year");--> statement-breakpoint
CREATE INDEX "bills_user_due_idx" ON "bills" USING btree ("user_id","due_date");--> statement-breakpoint
CREATE INDEX "bills_document_id_idx" ON "bills" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "bills_expected_account_id_idx" ON "bills" USING btree ("expected_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_user_external_uq" ON "bills" USING btree ("user_id","external_source","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_user_category_currency_uq" ON "budgets" USING btree ("user_id","category_id","currency");--> statement-breakpoint
CREATE INDEX "budgets_user_id_idx" ON "budgets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budgets_category_id_idx" ON "budgets" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_user_name_uq" ON "categories" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "categories_user_id_idx" ON "categories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "category_rules_user_id_idx" ON "category_rules" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "category_rules_category_id_idx" ON "category_rules" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "csv_profiles_account_uq" ON "csv_profiles" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "csv_profiles_user_id_idx" ON "csv_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deduction_mappings_user_category_uq" ON "deduction_mappings" USING btree ("user_id","category_id");--> statement-breakpoint
CREATE INDEX "deduction_mappings_category_id_idx" ON "deduction_mappings" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deduction_year_migration_tx_uq" ON "deduction_year_migration" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "deduction_year_migration_user_year_idx" ON "deduction_year_migration" USING btree ("user_id","old_tax_year");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_user_sha256_uq" ON "documents" USING btree ("user_id","sha256");--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_account_settings_account_uq" ON "forecast_account_settings" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "forecast_account_settings_user_id_idx" ON "forecast_account_settings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_user_pair_date_source_uq" ON "fx_rates" USING btree ("user_id","base","quote","date","source");--> statement-breakpoint
CREATE INDEX "fx_rates_user_id_idx" ON "fx_rates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "imports_user_id_idx" ON "imports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "imports_account_id_idx" ON "imports" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_files_user_sha_uq" ON "inbox_files" USING btree ("user_id","sha256");--> statement-breakpoint
CREATE INDEX "inbox_files_user_created_idx" ON "inbox_files" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_user_name_uq" ON "institutions" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "institutions_user_id_idx" ON "institutions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "market_data_settings_user_id_uq" ON "market_data_settings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_dismissals_pair_uq" ON "match_dismissals" USING btree ("bill_id","transaction_id");--> statement-breakpoint
CREATE INDEX "match_dismissals_user_id_idx" ON "match_dismissals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "match_dismissals_transaction_id_idx" ON "match_dismissals" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_user_kind_uq" ON "notification_channels" USING btree ("user_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_sent_user_key_uq" ON "notifications_sent" USING btree ("user_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "paperless_connections_user_uq" ON "paperless_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paperless_connections_token_uq" ON "paperless_connections" USING btree ("webhook_token");--> statement-breakpoint
CREATE UNIQUE INDEX "paperless_dismissed_user_ref_uq" ON "paperless_dismissed" USING btree ("user_id","external_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "paperless_documents_conn_doc_uq" ON "paperless_documents" USING btree ("connection_id","paperless_id");--> statement-breakpoint
CREATE INDEX "paperless_documents_user_id_idx" ON "paperless_documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "paperless_documents_bill_id_idx" ON "paperless_documents" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paperless_instances_user_url_uq" ON "paperless_instances" USING btree ("user_id","base_url");--> statement-breakpoint
CREATE UNIQUE INDEX "paperless_pending_conn_doc_uq" ON "paperless_pending" USING btree ("connection_id","paperless_id");--> statement-breakpoint
CREATE INDEX "paperless_pending_user_id_idx" ON "paperless_pending" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "paperless_report_uploads_conn_sha_uq" ON "paperless_report_uploads" USING btree ("connection_id","sha256");--> statement-breakpoint
CREATE INDEX "paperless_report_uploads_user_id_idx" ON "paperless_report_uploads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_id_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pending_imports_user_id_idx" ON "pending_imports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pending_imports_expires_at_idx" ON "pending_imports" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pillar_3a_buy_in_years_user_year_uq" ON "pillar_3a_buy_in_years" USING btree ("user_id","year");--> statement-breakpoint
CREATE INDEX "pillar_3a_buy_in_years_user_id_idx" ON "pillar_3a_buy_in_years" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pillar_3a_buy_in_years_contribution_id_idx" ON "pillar_3a_buy_in_years" USING btree ("contribution_id");--> statement-breakpoint
CREATE INDEX "pillar_3a_contributions_user_id_idx" ON "pillar_3a_contributions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pillar_3a_contributions_portfolio_id_idx" ON "pillar_3a_contributions" USING btree ("portfolio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pillar_3a_contributions_transaction_uq" ON "pillar_3a_contributions" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pillar_3a_years_user_year_uq" ON "pillar_3a_years" USING btree ("user_id","year");--> statement-breakpoint
CREATE INDEX "pillar_3a_years_user_id_idx" ON "pillar_3a_years" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "planned_items_user_date_idx" ON "planned_items" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "planned_items_account_id_idx" ON "planned_items" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_values_portfolio_date_uq" ON "portfolio_values" USING btree ("portfolio_id","date");--> statement-breakpoint
CREATE INDEX "portfolio_values_user_id_idx" ON "portfolio_values" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "portfolios_user_id_idx" ON "portfolios" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "portfolios_account_id_idx" ON "portfolios" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolios_user_reference_uq" ON "portfolios" USING btree ("user_id","deposit_reference");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_id_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_codes_hash_uq" ON "recovery_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_series_user_key_uq" ON "recurring_series" USING btree ("user_id","key");--> statement-breakpoint
CREATE INDEX "recurring_series_user_id_idx" ON "recurring_series" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "securities_user_id_idx" ON "securities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "security_prices_security_date_source_uq" ON "security_prices" USING btree ("security_id","date","source");--> statement-breakpoint
CREATE INDEX "security_prices_user_id_idx" ON "security_prices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tax_credits_user_id_idx" ON "tax_credits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tax_credits_tax_year_id_idx" ON "tax_credits" USING btree ("tax_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_years_user_year_uq" ON "tax_years" USING btree ("user_id","year");--> statement-breakpoint
CREATE INDEX "trades_user_id_idx" ON "trades" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trades_account_security_date_idx" ON "trades" USING btree ("account_id","security_id","date");--> statement-breakpoint
CREATE INDEX "trades_security_id_idx" ON "trades" USING btree ("security_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_account_external_uq" ON "transactions" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "transactions_user_tax_year_idx" ON "transactions" USING btree ("user_id","tax_year");--> statement-breakpoint
CREATE INDEX "transactions_account_booking_idx" ON "transactions" USING btree ("account_id","booking_date");--> statement-breakpoint
CREATE INDEX "transactions_user_id_idx" ON "transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_import_id_idx" ON "transactions" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "transactions_category_id_idx" ON "transactions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "transactions_mirror_of_id_idx" ON "transactions" USING btree ("mirror_of_id");--> statement-breakpoint
CREATE INDEX "transactions_user_booking_seq_idx" ON "transactions" USING btree ("user_id","booking_date","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_out_transaction_uq" ON "transfers" USING btree ("out_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfers_in_transaction_uq" ON "transfers" USING btree ("in_transaction_id");--> statement-breakpoint
CREATE INDEX "transfers_user_status_idx" ON "transfers" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "transfers_from_account_idx" ON "transfers" USING btree ("from_account_id");--> statement-breakpoint
CREATE INDEX "transfers_to_account_idx" ON "transfers" USING btree ("to_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_user_id_uq" ON "user_preferences" USING btree ("user_id");