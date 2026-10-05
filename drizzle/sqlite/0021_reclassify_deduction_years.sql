-- Data migration. `tax_year` used to mean both "payment to the tax office for year X" and
-- "deduct in year X"; deduction_year now carries the second meaning.
--
-- Conservative split: an outflow tagged with a `tax_year` moves to `deduction_year` only when
-- its category resolves (own mapping, else the parent's, exactly as the app does) to a real
-- deduction type other than `other`, and no tax-office line of that year has the same amount.
-- Everything else is ambiguous and stays a tax payment. Every moved row is recorded in
-- `deduction_year_migration` so the user can undo the move.
CREATE TEMP TABLE `__deduction_year_candidates` AS
SELECT t.`id` AS `transaction_id`, t.`user_id` AS `user_id`, t.`tax_year` AS `old_tax_year`
FROM `transactions` t
WHERE t.`tax_year` IS NOT NULL
  AND t.`category_id` IS NOT NULL
  AND t.`amount` < 0
  AND COALESCE(
    (
      SELECT m.`deduction_type` FROM `deduction_mappings` m
      WHERE m.`user_id` = t.`user_id` AND m.`category_id` = t.`category_id`
    ),
    (
      SELECT m.`deduction_type` FROM `categories` c
      JOIN `deduction_mappings` m
        ON m.`category_id` = c.`parent_id` AND m.`user_id` = c.`user_id`
      WHERE c.`id` = t.`category_id` AND c.`user_id` = t.`user_id`
    ),
    'other'
  ) <> 'other'
  AND NOT EXISTS (
    SELECT 1 FROM `tax_credits` tc
    JOIN `tax_years` ty ON ty.`id` = tc.`tax_year_id`
    WHERE ty.`user_id` = t.`user_id`
      AND ty.`year` = t.`tax_year`
      AND tc.`amount` = -t.`amount`
  );--> statement-breakpoint
INSERT INTO `deduction_year_migration` (`id`, `user_id`, `transaction_id`, `old_tax_year`)
SELECT lower(hex(randomblob(16))), `user_id`, `transaction_id`, `old_tax_year`
FROM `__deduction_year_candidates`;--> statement-breakpoint
UPDATE `transactions`
SET `deduction_year` = `tax_year`, `tax_year` = NULL
WHERE `id` IN (SELECT `transaction_id` FROM `__deduction_year_candidates`);--> statement-breakpoint
DROP TABLE `__deduction_year_candidates`;
