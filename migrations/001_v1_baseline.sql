-- Idempotent: safe to run on every start.
CREATE TABLE IF NOT EXISTS deposits (
  id serial PRIMARY KEY,
  deposited_on date NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0)
);

CREATE TABLE IF NOT EXISTS expenses (
  id serial PRIMARY KEY,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  spent_on date NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  paid_with text NOT NULL CHECK (paid_with IN ('cash', 'card', 'other')),
  charged_to text NOT NULL CHECK (charged_to IN ('me', 'company')),
  reimbursed_on date,
  CONSTRAINT reimbursement_valid
    CHECK (reimbursed_on IS NULL OR (charged_to = 'company' AND reimbursed_on >= spent_on))
);
