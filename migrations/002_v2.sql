-- v2: currencies, exchange rates, categories.

CREATE TABLE settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), -- single row
  base_currency char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  display_currency char(3) NOT NULL CHECK (display_currency ~ '^[A-Z]{3}$')
);
-- app.base_currency is set by the migration runner (env BASE_CURRENCY, default SAR).
INSERT INTO settings VALUES (true, coalesce(nullif(current_setting('app.base_currency', true), ''), 'SAR'), 'USD');
UPDATE settings SET display_currency = CASE WHEN base_currency = 'USD' THEN 'EUR' ELSE 'USD' END;

-- rate = units of the base currency per 1 unit of `currency` (e.g. USD 3.75 when base is SAR).
-- ponytail: 10 decimal places loses precision for very weak currencies (e.g. IRR); switch to plain numeric if needed.
CREATE TABLE fx_rates (
  currency char(3) PRIMARY KEY CHECK (currency ~ '^[A-Z]{3}$'),
  rate numeric(20,10) NOT NULL CHECK (rate > 0),
  source text NOT NULL CHECK (source IN ('api', 'manual')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id serial PRIMARY KEY,
  parent_id int REFERENCES categories(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 50)
);
CREATE UNIQUE INDEX categories_name_uq ON categories (coalesce(parent_id, 0), lower(name));

-- Amounts become unconstrained numeric so each row keeps its currency's scale (2, 3 or 0 decimals).
ALTER TABLE deposits ALTER amount TYPE numeric,
  ADD currency char(3), ADD rate numeric(20,10), ADD amount_base numeric;
UPDATE deposits SET currency = (SELECT base_currency FROM settings), rate = 1, amount_base = amount;
ALTER TABLE deposits ALTER currency SET NOT NULL, ALTER rate SET NOT NULL, ALTER amount_base SET NOT NULL,
  ADD CONSTRAINT deposits_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT deposits_rate_positive CHECK (rate > 0),
  ADD CONSTRAINT deposits_amount_scale CHECK (scale(amount) <= 3 AND amount < 1e11),
  ADD CONSTRAINT deposits_amount_base_nonnegative CHECK (amount_base >= 0);

ALTER TABLE expenses ALTER amount TYPE numeric,
  ADD currency char(3), ADD rate numeric(20,10), ADD amount_base numeric,
  ADD category_id int REFERENCES categories(id) ON DELETE RESTRICT;
UPDATE expenses SET currency = (SELECT base_currency FROM settings), rate = 1, amount_base = amount;
ALTER TABLE expenses ALTER currency SET NOT NULL, ALTER rate SET NOT NULL, ALTER amount_base SET NOT NULL,
  ADD CONSTRAINT expenses_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT expenses_rate_positive CHECK (rate > 0),
  ADD CONSTRAINT expenses_amount_scale CHECK (scale(amount) <= 3 AND amount < 1e11),
  ADD CONSTRAINT expenses_amount_base_nonnegative CHECK (amount_base >= 0);

CREATE INDEX expenses_spent_on_idx ON expenses (spent_on DESC, id DESC);
CREATE INDEX expenses_category_idx ON expenses (category_id);
CREATE INDEX deposits_deposited_on_idx ON deposits (deposited_on DESC, id DESC);

-- Default categories (the table was just created, so it is empty).
WITH parents AS (
  INSERT INTO categories (name)
  VALUES ('Food'), ('Transport'), ('Lodging'), ('Communication'), ('Other')
  RETURNING id, name
)
INSERT INTO categories (parent_id, name)
SELECT p.id, c.name
FROM parents p
JOIN (VALUES
  ('Food', 'Breakfast'), ('Food', 'Lunch'), ('Food', 'Dinner'), ('Food', 'Snacks'),
  ('Transport', 'Taxi'), ('Transport', 'Flight'), ('Transport', 'Train'), ('Transport', 'Fuel'), ('Transport', 'Parking'),
  ('Lodging', 'Hotel'), ('Lodging', 'Laundry'),
  ('Communication', 'Mobile data'), ('Communication', 'SIM')
) AS c(parent, name) ON c.parent = p.name;
