ALTER TABLE `transactions` ADD `deduction_year` integer;--> statement-breakpoint
-- Data migration (hand-written). `tax_year` used to mean both "payment to the tax
-- office for year X" and "deduct in year X". Heuristic for splitting existing rows:
-- a transaction with a `tax_year` whose category (own mapping, else the parent's)
-- maps to a deduction type, and which is NOT a tax-office payment, carries a
-- deduction-year tag. A tax-office payment is recognised by a reconciled line: the
-- user's `tax_credits` for that same year contain the exact outflow amount.
-- Those rows move `tax_year` -> `deduction_year`; everything else is untouched.
UPDATE `transactions`
SET `deduction_year` = `tax_year`, `tax_year` = NULL
WHERE `tax_year` IS NOT NULL
  AND `category_id` IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM `deduction_mappings` m
      WHERE m.`user_id` = `transactions`.`user_id`
        AND m.`category_id` = `transactions`.`category_id`
    )
    OR EXISTS (
      SELECT 1 FROM `categories` c
      JOIN `deduction_mappings` m
        ON m.`category_id` = c.`parent_id` AND m.`user_id` = c.`user_id`
      WHERE c.`id` = `transactions`.`category_id`
        AND c.`user_id` = `transactions`.`user_id`
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM `tax_credits` tc
    JOIN `tax_years` ty ON ty.`id` = tc.`tax_year_id`
    WHERE ty.`user_id` = `transactions`.`user_id`
      AND ty.`year` = `transactions`.`tax_year`
      AND tc.`amount` = -`transactions`.`amount`
  );
