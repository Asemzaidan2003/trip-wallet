-- v5: tax per expense. `amount` stays the TOTAL paid (subtotal + tax), so every existing total and the wallet are unchanged;
-- `tax` is the part of that total that is tax (0 for existing expenses). tax_base is the same amount in the wallet currency.
ALTER TABLE expenses
  ADD COLUMN tax numeric NOT NULL DEFAULT 0,
  ADD COLUMN tax_base numeric NOT NULL DEFAULT 0;
-- Give the zeros the same number of decimals as each row's amount (0.00, not 0), so the API shows them consistently.
UPDATE expenses SET tax = round(0::numeric, scale(amount)), tax_base = round(0::numeric, scale(amount_base));
ALTER TABLE expenses
  ADD CONSTRAINT expenses_tax_valid CHECK (tax >= 0 AND tax < amount AND scale(tax) <= 3),
  ADD CONSTRAINT expenses_tax_base_valid CHECK (tax_base >= 0 AND tax_base <= amount_base);
