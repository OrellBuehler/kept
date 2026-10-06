-- Synthetic dataset for a Kept 0.3.0 database (schema of migrations 0000-0016).
-- Everything here is made up: example IBANs, invented names, round numbers. Secrets are
-- encrypted with the fixture key in fixture.ts; the password of every user is in fixture.ts.
-- Rows are inserted in the order that fixes their rowid (the 0.4.0 `seq` backfill reads it);
-- the DELETE statements leave gaps in it on purpose.

-- users ----------------------------------------------------------------------------------
INSERT INTO users (id, username, display_name, password_hash, role) VALUES
 ('usr-alice', 'alice', 'Alice Example', '$argon2id$v=19$m=65536,t=2,p=1$dw5PoYck7/U8n1U7CnSSeWvgrBsic7THbr0XFuog71s$dhD1vRT4NYzLBlgiym1VKoemy3D5EEQsHSY0xgYT5NA', 'admin'),
 ('usr-bob',   'bob',   'Bob Example',   '$argon2id$v=19$m=65536,t=2,p=1$dw5PoYck7/U8n1U7CnSSeWvgrBsic7THbr0XFuog71s$dhD1vRT4NYzLBlgiym1VKoemy3D5EEQsHSY0xgYT5NA', 'member'),
 ('usr-carol', 'carol', NULL,            '$argon2id$v=19$m=65536,t=2,p=1$dw5PoYck7/U8n1U7CnSSeWvgrBsic7THbr0XFuog71s$dhD1vRT4NYzLBlgiym1VKoemy3D5EEQsHSY0xgYT5NA', 'member');

INSERT INTO user_preferences (id, user_id, iban_display, blur_amounts, locale, default_currency, page_size) VALUES
 ('pref-alice', 'usr-alice', 'masked', 1, 'de-CH', 'CHF', 50),
 ('pref-bob',   'usr-bob',   'full',   0, 'en-GB', 'EUR', 25);

-- sessions use the sha256 of the cookie value as id: the cookie of alice is `fixture-session-token-alice`.
INSERT INTO sessions (id, user_id, expires_at, reauth_at) VALUES
 ('f99137f885a6abdb2639569c626b06dcb2e06c11712efa5f7d5e1a7eac589127', 'usr-alice', 4102444800000, 1704110400000),
 ('5049df70882933ddcd756d3706d182c2e5f8a806b3e99cca6df90204e17034aa', 'usr-bob',   4102444800000, NULL),
 ('expired-session-id-0000000000000000000000000000000000000000000000000000', 'usr-bob', 1704110400000, NULL);

-- second factor and security log (carol only, so logins of the other users stay password-only)
INSERT INTO totp_credentials (user_id, secret, confirmed_at, last_step) VALUES
 ('usr-carol', 'v1.InowP_8IZ58p0Dgj.Sjk6iPZNs51wEp7bPGxd9j1o_KB81BTiuRty3Z5YQKE', 1704110400000, 56803680);
INSERT INTO passkeys (id, user_id, name, credential_id, public_key, counter, transports, device_type, backed_up, last_used_at) VALUES
 ('pk-c1', 'usr-carol', 'Fixture key', 'fixture-credential-id-1', 'AQIDBAUGBwg', 5, '["internal","hybrid"]', 'multiDevice', 1, 1710000000000),
 ('pk-c2', 'usr-carol', 'Second key',  'fixture-credential-id-2', 'CQoLDA0ODxA', 0, NULL, 'singleDevice', 0, NULL);
INSERT INTO recovery_codes (id, user_id, code_hash, used_at) VALUES
 ('rc-c1', 'usr-carol', 'fixture-hash-1', NULL),
 ('rc-c2', 'usr-carol', 'fixture-hash-2', 1710000000000);
INSERT INTO auth_events (id, user_id, actor_id, type) VALUES
 ('ae-1', 'usr-carol', 'usr-carol', 'totp_enabled'),
 ('ae-2', 'usr-bob',   'usr-alice', 'two_factor_reset');
INSERT INTO auth_challenges (id, user_id, kind, challenge, attempts, expires_at) VALUES
 ('ac-1', 'usr-carol', 'login', NULL, 1, 4102444800000),
 ('ac-2', NULL, 'passkey_login', 'fixture-challenge', 0, 4102444800000);

-- institutions and accounts -------------------------------------------------------------
INSERT INTO institutions (id, user_id, name, bic, color, logo, logo_mime, logo_version) VALUES
 ('inst-a1', 'usr-alice', 'Example Bank A',     'EXAMCHZZXXX', '#2563eb',
   X'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
   'image/png', 'v1fixture'),
 ('inst-a2', 'usr-alice', 'Example Savings Co', NULL, NULL, NULL, NULL, NULL),
 ('inst-b1', 'usr-bob',   'Example Bank A',     NULL, '#16a34a', NULL, NULL, NULL),
 ('inst-c1', 'usr-carol', 'Carol Credit Union', 'CAROCHZZXXX', NULL, NULL, NULL, NULL);

INSERT INTO accounts (id, user_id, institution_id, name, type, currency, iban, opening_balance, opening_date, archived, sort_order, share_bps, shared_with, created_at, updated_at) VALUES
 ('acc-a-chk',  'usr-alice', 'inst-a1', 'Main current', 'current',     'CHF', 'CH9300762011623852957',  150000, '2023-12-31', 0, 0, 10000, NULL,        1704110400000, 1704110400000),
 ('acc-a-sav',  'usr-alice', 'inst-a2', 'Rainy day',    'savings',     'CHF', NULL,                          0, '2024-01-01', 1, 1, 10000, NULL,        1704110400000, 1717243200000),
 ('acc-a-old',  'usr-alice', NULL,      'Old wallet',   'cash',        'CHF', NULL,                       5000, NULL,         1, 2, 10000, NULL,        1704110400000, 1704110400000),
 ('acc-a-eur',  'usr-alice', 'inst-a1', 'Euro account', 'current',     'EUR', 'DE89370400440532013000',  -2500, '2024-01-01', 0, 3,  5000, 'Household', 1704110400000, 1706788800000),
 ('acc-a-usd',  'usr-alice', NULL,      'Dollar pot',   'other',       'USD', NULL,                          0, NULL,         0, 4, 10000, NULL,        1704110400000, 1704110400000),
 ('acc-a-card', 'usr-alice', 'inst-a1', 'Credit card',  'credit_card', 'CHF', NULL,                     -35000, '2024-01-01', 0, 5, 10000, NULL,        1704110400000, 1704110400000),
 ('acc-b-chk',  'usr-bob',   'inst-b1', 'Bob current',  'current',     'CHF', 'CH9300762011623852957',   20000, '2024-01-01', 0, 0, 10000, NULL,        1704110400000, 1704110400000),
 ('acc-b-sav',  'usr-bob',   NULL,      'Bob savings',  'savings',     'CHF', NULL,                          0, NULL,         1, 1, 10000, NULL,        1704110400000, 1709294400000),
 ('acc-c-chk',  'usr-carol', 'inst-c1', 'Carol current','current',     'CHF', NULL,                       1000, '2024-01-01', 0, 0, 10000, NULL,        1704110400000, 1704110400000);

-- categories, deductions, rules, budgets --------------------------------------------------
INSERT INTO categories (id, user_id, parent_id, name, kind, color, icon) VALUES
 ('cat-a-salary',   'usr-alice', NULL,           'Salary',               'income',  '#22c55e', 'shield'),
 ('cat-a-food',     'usr-alice', NULL,           'Groceries',            'expense', '#f97316', 'shopping-cart'),
 ('cat-a-don',      'usr-alice', NULL,           'Donations',            'expense', NULL, NULL),
 ('cat-a-med-p',    'usr-alice', NULL,           'Health',               'expense', NULL, 'heart-pulse'),
 ('cat-a-med-c',    'usr-alice', 'cat-a-med-p',  'Pharmacy',             'expense', NULL, NULL),
 ('cat-a-3a',       'usr-alice', NULL,           'Retirement savings',   'expense', NULL, NULL),
 ('cat-a-edu-p',    'usr-alice', NULL,           'Education',            'expense', NULL, 'graduation-cap'),
 ('cat-a-edu-c',    'usr-alice', 'cat-a-edu-p',  'Hobby courses',        'expense', NULL, NULL),
 ('cat-a-misc',     'usr-alice', NULL,           'Misc',                 'expense', NULL, NULL),
 ('cat-a-care-p',   'usr-alice', NULL,           'Childcare',            'expense', NULL, NULL),
 ('cat-a-care-m',   'usr-alice', 'cat-a-care-p', 'Childcare activities', 'expense', NULL, NULL),
 ('cat-a-care-l',   'usr-alice', 'cat-a-care-m', 'Holiday camp',         'expense', NULL, NULL),
 ('cat-a-tax',      'usr-alice', NULL,           'Taxes',                'expense', NULL, NULL),
 ('cat-a-other',    'usr-alice', NULL,           'Other deductions',     'expense', NULL, NULL),
 ('cat-b-don',      'usr-bob',   NULL,           'Donations',            'expense', NULL, NULL),
 ('cat-b-misc',     'usr-bob',   NULL,           'Misc',                 'expense', NULL, NULL),
 ('cat-c-food',     'usr-carol', NULL,           'Groceries',            'expense', NULL, NULL);

INSERT INTO deduction_mappings (id, user_id, category_id, deduction_type) VALUES
 ('dm-a-don',    'usr-alice', 'cat-a-don',    'donations'),
 ('dm-a-med',    'usr-alice', 'cat-a-med-p',  'medical'),
 ('dm-a-3a',     'usr-alice', 'cat-a-3a',     'pillar_3a'),
 ('dm-a-edu-p',  'usr-alice', 'cat-a-edu-p',  'education'),
 ('dm-a-edu-c',  'usr-alice', 'cat-a-edu-c',  'other'),
 ('dm-a-care',   'usr-alice', 'cat-a-care-p', 'childcare'),
 ('dm-a-other',  'usr-alice', 'cat-a-other',  'other'),
 ('dm-b-don',    'usr-bob',   'cat-b-don',    'donations');

INSERT INTO budgets (id, user_id, category_id, currency, amount) VALUES
 ('bud-a-chf', 'usr-alice', 'cat-a-food', 'CHF', 60000),
 ('bud-a-eur', 'usr-alice', 'cat-a-food', 'EUR', 20000),
 ('bud-b',     'usr-bob',   'cat-b-misc', 'CHF', 10000);

INSERT INTO category_rules (id, user_id, category_id, priority, counterparty_contains, description_contains, counterparty_iban, amount_sign) VALUES
 ('rule-a-1',   'usr-alice', 'cat-a-food',   10,  'Grocer', NULL, NULL, 'expense'),
 ('rule-a-tmp', 'usr-alice', 'cat-a-misc',   100, 'Temp',   NULL, NULL, NULL),
 ('rule-a-2',   'usr-alice', 'cat-a-salary', 100, NULL, 'Salary', NULL, 'income'),
 ('rule-a-3',   'usr-alice', 'cat-a-don',    100, NULL, NULL, 'DE89370400440532013000', NULL),
 ('rule-b-1',   'usr-bob',   'cat-b-misc',   100, 'Shop', NULL, NULL, NULL);
DELETE FROM category_rules WHERE id = 'rule-a-tmp';

-- imports -------------------------------------------------------------------------------------
INSERT INTO imports (id, user_id, account_id, format, file_name, file_sha256, statement_from, statement_to, opening_balance, opening_balance_date, closing_balance, closing_balance_date, new_count, duplicate_count, warnings) VALUES
 ('imp-a1', 'usr-alice', 'acc-a-chk', 'camt053', 'statement-2024-q1.xml', '1111111111111111111111111111111111111111111111111111111111111111', '2024-01-01', '2024-03-31', 150000, '2023-12-31', 612155, '2024-03-31', 3, 0, '[]'),
 ('imp-a2', 'usr-alice', 'acc-a-eur', 'csv',     'euro-2024.csv',         '2222222222222222222222222222222222222222222222222222222222222222', NULL, NULL, NULL, NULL, NULL, NULL, 2, 1, '["fixture warning: one row skipped"]'),
 ('imp-b1', 'usr-bob',   'acc-b-chk', 'xlsx',    'bob.xlsx',              '3333333333333333333333333333333333333333333333333333333333333333', '2024-01-01', '2024-01-31', 20000, '2024-01-01', NULL, NULL, 1, 0, '[]');

INSERT INTO csv_profiles (id, user_id, account_id, name, profile) VALUES
 ('csv-a-eur', 'usr-alice', 'acc-a-eur', 'Euro export',
  '{"delimiter":";","encoding":"utf-8","headerRow":1,"dateFormat":"DD.MM.YYYY","decimalSeparator":",","thousandsSeparator":".","amountMode":"single","defaultCurrency":"EUR","columns":{"bookingDate":"Date","amount":"Amount","description":["Text","Details"],"counterpartyName":"Payee"}}');

INSERT INTO balance_snapshots (id, user_id, account_id, import_id, source, date, amount, note) VALUES
 ('snap-a-1', 'usr-alice', 'acc-a-chk', 'imp-a1', 'import', '2024-03-31', 612155, NULL),
 ('snap-a-2', 'usr-alice', 'acc-a-chk', NULL,     'manual', '2024-06-30', 650000, 'checked in the app'),
 ('snap-a-3', 'usr-alice', 'acc-a-eur', NULL,     'manual', '2024-06-30', -1250, NULL),
 ('snap-b-1', 'usr-bob',   'acc-b-chk', 'imp-b1', 'import', '2024-01-31', 55000, NULL);

INSERT INTO forecast_account_settings (id, user_id, account_id, threshold, is_default_payment) VALUES
 ('fc-a-1', 'usr-alice', 'acc-a-chk', 50000, 1),
 ('fc-a-2', 'usr-alice', 'acc-a-eur', NULL,  0);

INSERT INTO planned_items (id, user_id, account_id, date, amount, currency, label) VALUES
 ('plan-a-1', 'usr-alice', 'acc-a-chk', '2099-01-15', -120000, 'CHF', 'Insurance premium'),
 ('plan-a-2', 'usr-alice', NULL,        '2099-02-01',   50000, 'CHF', 'Expected refund');

INSERT INTO recurring_series (id, user_id, key, status, edited, name, counterparty_iban, cadence, currency, amount, first_date, last_date, last_amount, previous_amount, occurrences) VALUES
 ('rs-a-1', 'usr-alice', 'grocer|monthly',  'confirmed', 1, 'Grocer subscription', NULL,                     'monthly',   'CHF', -2500,  '2024-01-05', '2024-06-05', -2500,  -2400, 6),
 ('rs-a-2', 'usr-alice', 'insurer|yearly',  'suggested', 0, 'Insurer',             'DE89370400440532013000', 'yearly',    'CHF', -120000, '2023-02-01', '2024-02-01', -120000, NULL,  2),
 ('rs-a-3', 'usr-alice', 'gym|quarterly',   'dismissed', 0, 'Gym',                 NULL,                     'quarterly', 'CHF', -9000,  '2024-01-10', '2024-04-10', -9000,  -9000, 2);

-- transactions: ledger -------------------------------------------------------------------------
-- Columns: id, user_id, account_id, import_id, source, external_id, booking_date, value_date, amount, currency,
--          original_amount, original_currency, counterparty_name, counterparty_iban, description, reference,
--          reference_type, reversal, note, category_id, tax_year, deduction_excluded
INSERT INTO transactions (id, user_id, account_id, import_id, source, external_id, booking_date, value_date, amount, currency, original_amount, original_currency, counterparty_name, counterparty_iban, description, reference, reference_type, reversal, note, category_id, tax_year, deduction_excluded) VALUES
 ('tx-a-01', 'usr-alice', 'acc-a-chk', 'imp-a1', 'import', 'ext-0001', '2024-01-25', '2024-01-25',  500000, 'CHF', NULL, NULL, 'Example Employer AG', 'DE89370400440532013000', 'Salary January', NULL, NULL, 0, NULL, 'cat-a-salary', NULL, 0),
 ('tx-a-02', 'usr-alice', 'acc-a-chk', 'imp-a1', 'import', 'ext-0002', '2024-01-27', NULL,         -12345, 'CHF', NULL, NULL, 'Grocer Müller', NULL, 'Café Zürich – naïve ñ 日本 ''quoted'' "double"', NULL, NULL, 0, 'line one
line two', 'cat-a-food', NULL, 0),
 ('tx-a-03', 'usr-alice', 'acc-a-chk', 'imp-a1', 'import', 'ext-0003', '2024-02-28', '2024-02-29', -25000, 'CHF', NULL, NULL, 'Example Utility AG', 'DE89370400440532013000', 'Invoice 2024-001', '210000000003139471430009017', 'QRR', 0, NULL, NULL, NULL, 0),
 ('tx-a-04', 'usr-alice', 'acc-a-chk', NULL,     'manual', 'man-0004', '2024-03-02', NULL,          -4500, 'CHF', NULL, NULL, 'Shop', NULL, 'Purchase later reversed', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-05', 'usr-alice', 'acc-a-chk', NULL,     'manual', 'man-0005', '2024-03-03', NULL,           4500, 'CHF', NULL, NULL, 'Shop', NULL, 'Reversal of purchase', NULL, NULL, 1, 'reverses tx-a-04', NULL, NULL, 0),
 ('tx-a-06', 'usr-alice', 'acc-a-chk', NULL,     'manual', 'man-0006', '2024-03-01', NULL,        -100000, 'CHF', NULL, NULL, NULL, NULL, 'Transfer to savings', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-tmp','usr-alice', 'acc-a-chk', NULL,     'manual', 'man-tmp',  '2024-03-01', NULL,              1, 'CHF', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-08', 'usr-alice', 'acc-a-sav', NULL,     'manual', 'man-0008', '2024-03-01', NULL,         100000, 'CHF', NULL, NULL, NULL, NULL, 'Transfer from current', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-09', 'usr-alice', 'acc-a-sav', NULL,     'manual', 'man-0009', '2024-12-31', NULL,           1234, 'CHF', NULL, NULL, 'Example Savings Co', NULL, 'Interest', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-b-01', 'usr-bob',   'acc-b-chk', 'imp-b1', 'import', 'ext-0001', '2024-01-15', NULL,         35000, 'CHF', NULL, NULL, 'Bob Employer', NULL, 'Salary', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-10', 'usr-alice', 'acc-a-eur', 'imp-a2', 'import', 'ext-0010', '2024-04-10', '2024-04-11', -45000, 'EUR', -49000, 'USD', 'Overseas Shop', NULL, 'Foreign currency purchase', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-11', 'usr-alice', 'acc-a-eur', 'imp-a2', 'import', 'ext-0011', '2024-04-20', NULL,          -9999, 'EUR', NULL, NULL, 'Example Telco', NULL, 'Bill payment', 'RF18539007547034', 'SCOR', 0, NULL, NULL, NULL, 0),
 ('tx-a-12', 'usr-alice', 'acc-a-eur', NULL,     'manual', 'man-0012', '2024-05-01', NULL,         300000, 'EUR', NULL, NULL, NULL, NULL, 'Deposit', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-13', 'usr-alice', 'acc-a-usd', NULL,     'manual', 'man-0013', '2024-05-01', NULL, 9007199254740991, 'USD', NULL, NULL, NULL, NULL, 'Largest safe integer', NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-a-14', 'usr-alice', 'acc-a-card','imp-a1', 'import', 'ext-0014', '2024-02-10', NULL,          -8990, 'CHF', NULL, NULL, 'Online Store', NULL, '', NULL, NULL, 0, '', NULL, NULL, 0),
 ('tx-a-15', 'usr-alice', 'acc-a-card',NULL,     'manual', 'man-0015', '2024-02-11', NULL,           -100, 'CHF', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0),
 ('tx-c-01', 'usr-carol', 'acc-c-chk', NULL,     'manual', 'man-0001', '2024-02-01', NULL,           -750, 'CHF', NULL, NULL, 'Bakery', NULL, 'Bread', NULL, NULL, 0, NULL, 'cat-c-food', NULL, 0);
DELETE FROM transactions WHERE id = 'tx-a-tmp';

-- transactions: tax payments and deductions (migration 0021) -----------------------------------
INSERT INTO transactions (id, user_id, account_id, source, external_id, booking_date, amount, currency, description, reversal, category_id, tax_year, deduction_excluded) VALUES
 ('tx-a-x01', 'usr-alice', 'acc-a-chk', 'manual', 'x01', '2023-12-01',  -20000, 'CHF', 'MOVED own mapping; the same amount is on the 2022 statement only', 0, 'cat-a-don',    2023, 0),
 ('tx-a-x02', 'usr-alice', 'acc-a-chk', 'manual', 'x02', '2023-12-02',  -35050, 'CHF', 'MOVED mapping inherited from the parent', 0, 'cat-a-med-c',  2023, 0),
 ('tx-a-x03', 'usr-alice', 'acc-a-chk', 'manual', 'x03', '2024-12-03', -700000, 'CHF', 'STAYS tax-office line of 2024 has this amount', 0, 'cat-a-3a',    2024, 0),
 ('tx-a-x04', 'usr-alice', 'acc-a-chk', 'manual', 'x04', '2024-12-04', -123456, 'CHF', 'MOVED other amount than the 2024 lines', 0, 'cat-a-3a',    2024, 0),
 ('tx-a-x05', 'usr-alice', 'acc-a-chk', 'manual', 'x05', '2023-12-05',  -10000, 'CHF', 'STAYS no deduction mapping', 0, 'cat-a-misc',   2023, 0),
 ('tx-a-x06', 'usr-alice', 'acc-a-chk', 'manual', 'x06', '2023-12-06',   -9900, 'CHF', 'STAYS own mapping other overrides the parent', 0, 'cat-a-edu-c', 2023, 0),
 ('tx-a-x07', 'usr-alice', 'acc-a-chk', 'manual', 'x07', '2023-12-07',   -8800, 'CHF', 'STAYS mapping only two levels up', 0, 'cat-a-care-l', 2023, 0),
 ('tx-a-x08', 'usr-alice', 'acc-a-chk', 'manual', 'x08', '2023-12-08',   -5000, 'CHF', 'STAYS no tax year', 0, 'cat-a-don',    NULL, 0),
 ('tx-a-x09', 'usr-alice', 'acc-a-chk', 'manual', 'x09', '2023-12-09',   -6000, 'CHF', 'STAYS no category', 0, NULL,           2023, 0),
 ('tx-a-x10', 'usr-alice', 'acc-a-chk', 'manual', 'x10', '2023-12-10',   15000, 'CHF', 'STAYS refund is not an outflow', 0, 'cat-a-don',  2023, 0),
 ('tx-a-x11', 'usr-alice', 'acc-a-chk', 'manual', 'x11', '2023-12-11',       0, 'CHF', 'STAYS zero amount', 0, 'cat-a-don',       2023, 0),
 ('tx-a-x12', 'usr-alice', 'acc-a-chk', 'manual', 'x12', '2023-12-12',  -50000, 'CHF', 'STAYS 2023 statement has this amount', 0, 'cat-a-don', 2023, 0),
 ('tx-a-x13', 'usr-alice', 'acc-a-chk', 'manual', 'x13', '2023-12-13',  -50000, 'CHF', 'STAYS second payment of the same amount', 0, 'cat-a-med-p', 2023, 0),
 ('tx-a-x14', 'usr-alice', 'acc-a-eur', 'manual', 'x14', '2023-12-14',  -50000, 'EUR', 'STAYS foreign currency; the comparison ignores currencies', 0, 'cat-a-don', 2023, 0),
 ('tx-a-x15', 'usr-alice', 'acc-a-chk', 'manual', 'x15', '2023-12-15',   -3000, 'CHF', 'MOVED excluded from deductions stays excluded', 0, 'cat-a-don', 2023, 1),
 ('tx-a-x16', 'usr-alice', 'acc-a-chk', 'manual', 'x16', '2024-12-16',   -4000, 'CHF', 'MOVED reversal flag stays', 1, 'cat-a-don',    2024, 0),
 ('tx-a-x17', 'usr-alice', 'acc-a-chk', 'manual', 'x17', '2024-12-17',    -100, 'CHF', 'MOVED far future year', 0, 'cat-a-don',    2100, 0),
 ('tx-a-x18', 'usr-alice', 'acc-a-chk', 'manual', 'x18', '2020-12-18',   -1000, 'CHF', 'MOVED year without tax year record', 0, 'cat-a-3a', 2020, 0),
 ('tx-a-x19', 'usr-alice', 'acc-a-chk', 'manual', 'x19', '2023-12-19', -300000, 'CHF', 'STAYS a real tax payment', 0, 'cat-a-tax',    2023, 0),
 ('tx-a-x20', 'usr-alice', 'acc-a-chk', 'manual', 'x20', '2023-12-20',   -7000, 'CHF', 'STAYS explicit mapping other', 0, 'cat-a-other', 2023, 0),
 ('tx-a-x21', 'usr-alice', 'acc-a-chk', 'manual', 'x21', '2023-12-21',      -1, 'CHF', 'MOVED smallest outflow', 0, 'cat-a-don',    2023, 0),
 ('tx-a-x22', 'usr-alice', 'acc-a-chk', 'manual', 'x22', '2023-12-22',   -777, 'CHF', 'MOVED boundary year 1970', 0, 'cat-a-don',    1970, 0),
 ('tx-a-x23', 'usr-alice', 'acc-a-chk', 'manual', 'x23', '2024-12-23',   -5000, 'CHF', 'STAYS 2024 statement has this amount', 0, 'cat-a-care-p', 2024, 0),
 ('tx-a-x24', 'usr-alice', 'acc-a-chk', 'manual', 'x24', '2022-12-24',  -20000, 'CHF', 'STAYS inherited mapping and the 2022 statement has this amount', 0, 'cat-a-care-m', 2022, 0),
 ('tx-a-x25', 'usr-alice', 'acc-a-chk', 'manual', 'x25', '2023-12-25',  -88800, 'CHF', 'STAYS 2023 statement has this amount', 0, 'cat-a-don', 2023, 0),
 ('tx-a-x27', 'usr-alice', 'acc-a-chk', 'manual', 'x27', '2024-01-10',  -50000, 'CHF', 'STAYS 2023 statement has this amount; booked a year later than it is tagged', 0, 'cat-a-don', 2023, 0),
 ('tx-a-x26', 'usr-alice', 'acc-a-chk', 'manual', 'x26', '2023-12-26',  -77000, 'CHF', 'MOVED only another user has a line of this amount', 0, 'cat-a-don', 2023, 0),
 ('tx-b-y01', 'usr-bob',   'acc-b-chk', 'manual', 'y01', '2023-12-01',  -50000, 'CHF', 'MOVED another user has a line of this amount', 0, 'cat-b-don', 2023, 0),
 ('tx-b-y02', 'usr-bob',   'acc-b-chk', 'manual', 'y02', '2023-12-02',   -1000, 'CHF', 'STAYS no mapping', 0, 'cat-b-misc',   2023, 0),
 ('tx-b-y03', 'usr-bob',   'acc-b-chk', 'manual', 'y03', '2023-12-03',  -77000, 'CHF', 'STAYS own 2023 statement has this amount', 0, 'cat-b-don', 2023, 0);

INSERT INTO tax_years (id, user_id, year, authority, currency, assessed_total, notes) VALUES
 ('ty-a-2022', 'usr-alice', 2022, 'Example Tax Office', 'CHF',  800000, NULL),
 ('ty-a-2023', 'usr-alice', 2023, 'Example Tax Office', 'CHF', 1234500, 'assessment received'),
 ('ty-a-2024', 'usr-alice', 2024, NULL,                 'CHF', NULL, NULL),
 ('ty-b-2023', 'usr-bob',   2023, NULL,                 'CHF', NULL, NULL);

INSERT INTO tax_credits (id, user_id, tax_year_id, booking_date, amount, reference, description) VALUES
 ('tc-a-1', 'usr-alice', 'ty-a-2023', '2023-03-31',  50000, 'REF-1', 'Advance payment'),
 ('tc-a-tmp','usr-alice','ty-a-2023', '2023-04-01',      1, NULL, NULL),
 ('tc-a-2', 'usr-alice', 'ty-a-2022', '2022-03-31',  20000, NULL, 'Advance payment 2022'),
 ('tc-b-1', 'usr-bob',   'ty-b-2023', '2023-03-31',  77000, NULL, NULL),
 ('tc-a-3', 'usr-alice', 'ty-a-2023', '2023-09-30',  88800, NULL, 'Final invoice'),
 ('tc-a-4', 'usr-alice', 'ty-a-2024', '2024-03-31', 700000, NULL, 'Pillar 3a'),
 ('tc-a-5', 'usr-alice', 'ty-a-2024', '2024-06-30',   5000, NULL, NULL);
DELETE FROM tax_credits WHERE id = 'tc-a-tmp';

-- documents and bills ------------------------------------------------------------------------------
-- The files behind the documents are written by fixture.ts (`files`).
INSERT INTO documents (id, user_id, file_name, mime_type, size, sha256, storage_key, source) VALUES
 ('doc-a1', 'usr-alice', 'invoice-2024-001.pdf', 'application/pdf', 52, '4ad4cd599e9b7b22fd674e5ae6f65c3b4eb17384315d62edd9fcfd50825cb1b5', 'usr-alice/doc-a1', 'upload'),
 ('doc-a2', 'usr-alice', 'scan-1001.pdf',        'application/pdf', 36, 'b34affa400170f4a4b8a3fa8e5f62d5d669be9820505a49c98a237afa701bdf9', 'usr-alice/doc-a2', 'integration'),
 ('doc-b1', 'usr-bob',   'invoice-2024-001.pdf', 'application/pdf', 52, '4ad4cd599e9b7b22fd674e5ae6f65c3b4eb17384315d62edd9fcfd50825cb1b5', 'usr-bob/doc-b1',   'upload');

INSERT INTO bills (id, user_id, kind, creditor_name, creditor_iban, amount, currency, issue_date, due_date, reference, reference_type, message, invoice_number, cancelled, document_id, expected_account_id, notes, tax_year, external_source, external_ref, external_url, extraction) VALUES
 ('bill-a1', 'usr-alice', 'invoice',     'Example Utility AG', 'DE89370400440532013000', 25000, 'CHF', '2024-02-01', '2024-03-01', '210000000003139471430009017', 'QRR', 'Invoice 2024-001', 'INV-2024-001', 0, 'doc-a1', 'acc-a-chk', 'paid by standing order', 2023, NULL, NULL, NULL, '{"source":"qr","warnings":[]}'),
 ('bill-a2', 'usr-alice', 'invoice',     NULL, NULL, NULL, 'CHF', NULL, NULL, NULL, 'NON', NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 ('bill-a3', 'usr-alice', 'invoice',     'Cancelled Co', NULL, 4200, 'CHF', '2024-01-01', '2024-01-31', NULL, NULL, NULL, NULL, 1, 'doc-a2', NULL, NULL, NULL, 'paperless', '1001', 'https://paperless.example.invalid/documents/1001/', '{"source":"text","warnings":["amount guessed"]}'),
 ('bill-a4', 'usr-alice', 'invoice',     'Example Telco', 'DE89370400440532013000', 9999, 'EUR', '2024-04-01', '2024-04-30', 'RF18539007547034', 'SCOR', NULL, 'T-77', 0, NULL, 'acc-a-eur', NULL, NULL, NULL, NULL, NULL, NULL),
 ('bill-a5', 'usr-alice', 'credit_note', 'Example Utility AG', NULL, 5000, 'CHF', '2024-05-01', NULL, NULL, NULL, 'Credit note', 'CN-1', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 ('bill-b1', 'usr-bob',   'invoice',     'Bob Supplier', NULL, 12000, 'CHF', '2024-01-10', '2024-02-10', NULL, NULL, NULL, NULL, 0, 'doc-b1', 'acc-b-chk', NULL, NULL, NULL, NULL, NULL, NULL);

INSERT INTO bill_allocations (id, user_id, bill_id, transaction_id, amount, origin) VALUES
 ('alloc-a-1', 'usr-alice', 'bill-a1', 'tx-a-03', 25000, 'auto'),
 ('alloc-a-2', 'usr-alice', 'bill-a4', 'tx-a-11',  5000, 'user');
INSERT INTO match_dismissals (id, user_id, bill_id, transaction_id) VALUES
 ('md-a-1', 'usr-alice', 'bill-a2', 'tx-a-02');

INSERT INTO inbox_files (id, user_id, file_name, sha256, status, reason, account_id, import_id, new_count, duplicate_count, review_file) VALUES
 ('inb-a-1', 'usr-alice', 'statement-2024-q1.xml', '1111111111111111111111111111111111111111111111111111111111111111', 'imported',  NULL, 'acc-a-chk', 'imp-a1', 3, 0, NULL),
 ('inb-a-2', 'usr-alice', 'unknown.csv',           '4444444444444444444444444444444444444444444444444444444444444444', 'review',    'needs a column mapping', NULL, NULL, NULL, NULL, 'review/unknown.csv'),
 ('inb-a-3', 'usr-alice', 'broken.xml',            '5555555555555555555555555555555555555555555555555555555555555555', 'failed',    'not a statement', NULL, NULL, NULL, NULL, NULL),
 ('inb-a-4', 'usr-alice', 'again.xml',             '6666666666666666666666666666666666666666666666666666666666666666', 'duplicate', NULL, 'acc-a-chk', 'imp-a1', 0, 3, NULL);

-- paperless ------------------------------------------------------------------------------------------
INSERT INTO paperless_connections (id, user_id, base_url, token_encrypted, api_version, server_version, bill_source, field_mapping, webhook_secret_hash, webhook_token, allow_insecure_tls, last_sync_at, last_sync_modified, last_error, enabled) VALUES
 ('pc-a-1', 'usr-alice', 'https://paperless.example.invalid', 'v1.jFN62s6TYMgO8F-6.arMhKa437xG00oyRAyvldrLH7mZPoQ0q8-TLmn9Fsbn6YjRh1slR', 9, '2.14.0', '{"kind":"tag","id":7,"label":"bills"}', '{"amount":1,"dueDate":2,"statusValues":{"paid":"Paid"}}', '7777777777777777777777777777777777777777777777777777777777777777', 'fixture-webhook-token-0001', 1, 1710000000000, 1709990000000, 'fixture: unreachable', 0);
INSERT INTO paperless_documents (id, user_id, connection_id, paperless_id, bill_id, document_id, modified, status, error, content_sha256, last_pushed_hash) VALUES
 ('pd-a-1', 'usr-alice', 'pc-a-1', 1001, 'bill-a3', 'doc-a2', 1709990000000, 'imported', NULL, 'b34affa400170f4a4b8a3fa8e5f62d5d669be9820505a49c98a237afa701bdf9', 'pushed-hash-1'),
 ('pd-a-2', 'usr-alice', 'pc-a-1', 1002, NULL, NULL, 1709990000001, 'failed', 'fixture error', NULL, NULL),
 ('pd-a-3', 'usr-alice', 'pc-a-1', 1003, NULL, NULL, 1709990000002, 'skipped', NULL, NULL, NULL);
INSERT INTO paperless_report_uploads (id, user_id, connection_id, report_kind, sha256, paperless_document_id, task_id, status, error) VALUES
 ('pu-a-1', 'usr-alice', 'pc-a-1', 'tax-summary-2023', '8888888888888888888888888888888888888888888888888888888888888888', 77, 'task-1', 'success', NULL),
 ('pu-a-2', 'usr-alice', 'pc-a-1', 'tax-summary-2024', '9999999999999999999999999999999999999999999999999999999999999999', NULL, NULL, 'pending', NULL);
INSERT INTO paperless_dismissed (id, user_id, external_ref) VALUES
 ('pdis-a-1', 'usr-alice', '2001');

-- notifications ----------------------------------------------------------------------------------------
-- bob is a member with an email channel: 0.4.0 limits email to administrators.
INSERT INTO notification_channels (id, user_id, kind, config_encrypted, enabled, last_success_at, last_error, last_error_at) VALUES
 ('nc-a-ntfy',    'usr-alice', 'ntfy',    'v1.vh1eDvYzktHCbuo7.9TJ9UvgPJqcJAcod0SuHo9CobyfwdnVwtHCfNxUN00ekBr0QbgMGpUs8aTMXDslKdDbmAyDkheA3_Ja9Nf-H_4rh3wJTuP9hvy4Ax8mWDSkhS9yf9Rm9k9M',    0, 1710000000000, NULL, NULL),
 ('nc-a-email',   'usr-alice', 'email',   'v1.9BtNxE8OkHV6S1eI.P6dYEWK402tcWd_38FlfCY7hiaz57ZyZisoiq_KqXlqSGLAIpA30GIHiqlfAwQ', 0, NULL, NULL, NULL),
 ('nc-b-email',   'usr-bob',   'email',   'v1.nbstlXs8ue2JmqVp.Sx8QLgGkxwnyqRwgy4h8FpJubG1Fmp-WrLGXt5SK_MzsLSFSPjGQ8tJrCuM', 0, 1710000000000, NULL, NULL),
 ('nc-b-webhook', 'usr-bob',   'webhook', 'v1.MN5umAW0-5gzydzI.aDxvukU4Ep6vnTAcQRtFLF-nt_DuTcmkoY5M0IDd_iMxeT80DEpTwwe_ISkOg9u1HVxyCEYGgubJt2n_EdliI-7cotsSPE4wchDIHHQ2j2b8DuwlksusjY7zXxLioA', 0, NULL, 'fixture failure', 1710000100000);
INSERT INTO notification_settings (id, user_id, bill_due_enabled, bill_due_days, bill_overdue_enabled, budget_enabled, budget_percent, stale_import_enabled, stale_import_days) VALUES
 ('ns-a', 'usr-alice', 1, 5, 1, 1, 80, 0, 14),
 ('ns-b', 'usr-bob',   0, 3, 0, 0, 100, 1, 30);
INSERT INTO notifications_sent (id, user_id, event_key) VALUES
 ('nsent-a-1', 'usr-alice', 'bill-due:bill-a1:2024-03-01'),
 ('nsent-b-1', 'usr-bob',   'stale-import:acc-b-chk:2024-02-15');
