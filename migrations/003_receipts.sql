-- v4: one optional receipt photo per expense, removed together with the expense.
CREATE TABLE receipts (
  expense_id int PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
