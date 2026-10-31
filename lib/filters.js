const { HttpError, parseDate, parseEnum, parseCurrency, parseId } = require('./validate');

// Builds a parameterised WHERE clause for expenses (table alias `e`) from query-string filters.
// Shared by the list, the CSV export and the reports, so they always agree.
function expenseFilter(query, params = []) {
  const where = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };

  const from = query.from ? parseDate(query.from, 'from') : null;
  const to = query.to ? parseDate(query.to, 'to') : null;
  if (from && to && from > to) throw new HttpError(400, 'from must not be after to', 'invalid_range');
  if (from) add('e.spent_on >= ?', from);
  if (to) add('e.spent_on <= ?', to);

  if (query.categoryId === 'none') where.push('e.category_id IS NULL');
  // A category also matches its sub-categories.
  else if (query.categoryId) add('e.category_id IN (SELECT id FROM categories WHERE ? IN (id, parent_id))', parseId(query.categoryId, 'categoryId'));

  if (query.chargedTo) add('e.charged_to = ?', parseEnum(query.chargedTo, 'chargedTo', ['me', 'company']));
  if (query.paidWith) add('e.paid_with = ?', parseEnum(query.paidWith, 'paidWith', ['cash', 'card', 'other']));
  if (query.status) {
    parseEnum(query.status, 'status', ['pending', 'reimbursed']);
    where.push(query.status === 'pending'
      ? "e.charged_to = 'company' AND e.reimbursed_on IS NULL"
      : 'e.reimbursed_on IS NOT NULL');
  }
  if (query.currency) add('e.currency = ?', parseCurrency(query.currency));
  if (query.q !== undefined && query.q !== '') {
    if (typeof query.q !== 'string' || query.q.length > 100) throw new HttpError(400, 'q must be 1-100 characters', 'invalid_q');
    add("e.description ILIKE ? ESCAPE '\\'", `%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
  }

  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

// Full expense row as the API returns it (table alias `e`), used by the list, CSV and reports.
const EXPENSE_SELECT = `
SELECT e.id, e.description, e.spent_on AS date, e.amount, e.tax, e.currency, e.rate, e.amount_base AS "amountBase", e.tax_base AS "taxBase",
  e.paid_with AS "paidWith", e.charged_to AS "chargedTo", e.reimbursed_on AS "reimbursedOn",
  e.category_id AS "categoryId", c.name AS "categoryName", p.name AS "parentCategoryName",
  EXISTS (SELECT 1 FROM receipts r WHERE r.expense_id = e.id) AS "hasReceipt"
FROM expenses e
LEFT JOIN categories c ON c.id = e.category_id
LEFT JOIN categories p ON p.id = c.parent_id`;

module.exports = { expenseFilter, EXPENSE_SELECT };
