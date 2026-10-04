-- Accounts archived before archived_at existed get their last update as the
-- archive time, so past net worth keeps them until then.
UPDATE `accounts` SET `archived_at` = `updated_at` WHERE `archived` = 1 AND `archived_at` IS NULL;
