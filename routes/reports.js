const express = require('express');
const { HttpError, parseDate } = require('../lib/validate');
const { getSettings, withDisplay } = require('../lib/money');
const { expenseFilter, EXPENSE_SELECT } = require('../lib/filters');

// All amounts are in the base currency; *Display fields are converted at the current display rate.
module.exports = (pool) => {
  const router = express.Router();

  router.get('/summary', async (req, res) => {
    const s = await getSettings(pool);
    // Wallet = deposits + reimbursements received - everything spent.
    const { rows } = await pool.query(
      `WITH d AS (SELECT coalesce(sum(amount_base), 0) AS total FROM deposits),
            e AS (SELECT
              coalesce(sum(amount_base), 0) AS spent,
              coalesce(sum(amount_base) FILTER (WHERE reimbursed_on IS NOT NULL), 0) AS reimbursed,
              coalesce(sum(amount_base) FILTER (WHERE charged_to = 'company' AND reimbursed_on IS NULL), 0) AS owed,
              coalesce(sum(amount_base) FILTER (WHERE charged_to = 'me'), 0) AS mine
            FROM expenses)
       SELECT ${withDisplay({
         wallet: 'd.total + e.reimbursed - e.spent', owedByCompany: 'e.owed', spentByMe: 'e.mine',
         // The three parts of the wallet, so the UI can show "received - spent + reimbursed = wallet".
         received: 'd.total', spentTotal: 'e.spent', reimbursedTotal: 'e.reimbursed',
       }, { b: '$1', r: '$2', d: '$3' })}
       FROM d, e`,
      [s.baseMinor, s.displayRate, s.displayMinor]
    );
    res.json({ baseCurrency: s.baseCurrency, displayCurrency: s.displayCurrency, displayRate: s.displayRate, ...rows[0] });
  });

  router.get('/reports', async (req, res) => {
    const s = await getSettings(pool);
    const money = [s.baseMinor, s.displayRate, s.displayMinor]; // $1..$3
    // Postgres rejects unused parameters, so totals get $1..$3 and the breakdowns only $1.
    const { where, params } = expenseFilter(req.query, [...money]);
    const { where: where1, params: params1 } = expenseFilter(req.query, [s.baseMinor]);
    const byCategoryId = req.query.categoryId && req.query.categoryId !== 'none';
    const top = req.query.top ?? '10';
    if (!/^\d{1,2}$/.test(top) || Number(top) < 1 || Number(top) > 50) throw new HttpError(400, 'top must be an integer from 1 to 50', 'invalid_top');
    const { where: whereT, params: paramsT } = expenseFilter(req.query);
    // The server's local date, not Postgres current_date (the DB container runs in UTC). The UI always sends `to`.
    const from = req.query.from ? parseDate(req.query.from, 'from') : null;
    const to = req.query.to ? parseDate(req.query.to, 'to') : new Date().toLocaleDateString('en-CA');
    const { where: whereD, params: paramsD } = expenseFilter(req.query, [s.baseMinor, from, to]);

    // Deposits only follow the date range.
    const depWhere = [];
    const depParams = [...money];
    if (req.query.from) depWhere.push(`deposited_on >= $${depParams.push(parseDate(req.query.from, 'from'))}`);
    if (req.query.to) depWhere.push(`deposited_on <= $${depParams.push(parseDate(req.query.to, 'to'))}`);

    const sum = (cond) => `coalesce(sum(e.amount_base)${cond ? ` FILTER (WHERE ${cond})` : ''}, 0)`;
    const [totals, deposits, byCategory, byMonth, byCurrency, byDay, byWeekday, byPaidWith, topExpenses, span] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS count, ${withDisplay({
          spent: sum(), mine: sum("e.charged_to = 'me'"), company: sum("e.charged_to = 'company'"),
          pending: sum("e.charged_to = 'company' AND e.reimbursed_on IS NULL"), reimbursed: sum('e.reimbursed_on IS NOT NULL'),
          tax: 'coalesce(sum(e.tax_base), 0)',
        }, { b: '$1', r: '$2', d: '$3' })}
         FROM expenses e ${where}`, params),
      pool.query(
        `SELECT ${withDisplay({ deposits: 'coalesce(sum(amount_base), 0)' }, { b: '$1', r: '$2', d: '$3' })}
         FROM deposits ${depWhere.length ? `WHERE ${depWhere.join(' AND ')}` : ''}`, depParams),
      // Without a category filter: roll up to top-level categories. With one: drill into its sub-categories.
      pool.query(
        byCategoryId
          ? `SELECT c.id, CASE WHEN c.parent_id IS NULL THEN c.name || ' (general)' ELSE c.name END AS name,
               false AS "hasChildren", round(sum(e.amount_base), $1::int) AS total, count(*)::int AS count
             FROM expenses e JOIN categories c ON c.id = e.category_id ${where1}
             GROUP BY c.id, c.name, c.parent_id ORDER BY sum(e.amount_base) DESC`
          : `SELECT t.id, coalesce(t.name, 'Uncategorized') AS name,
               coalesce(t.id IN (SELECT parent_id FROM categories WHERE parent_id IS NOT NULL), false) AS "hasChildren",
               round(sum(e.amount_base), $1::int) AS total, count(*)::int AS count
             FROM expenses e
             LEFT JOIN categories c ON c.id = e.category_id
             LEFT JOIN categories t ON t.id = coalesce(c.parent_id, c.id)
             ${where1} GROUP BY t.id, t.name ORDER BY sum(e.amount_base) DESC`,
        params1),
      pool.query(
        `SELECT to_char(e.spent_on, 'YYYY-MM') AS month, round(sum(e.amount_base), $1::int) AS total, count(*)::int AS count
         FROM expenses e ${where1} GROUP BY 1 ORDER BY 1`, params1),
      // Original-currency totals (what to claim from the company). 0 * min(amount) keeps the currency's scale.
      pool.query(
        `SELECT e.currency, sum(e.amount) AS amount, round(sum(e.amount_base), $1::int) AS "amountBase",
           coalesce(sum(e.amount) FILTER (WHERE e.charged_to = 'company' AND e.reimbursed_on IS NULL), 0 * min(e.amount)) AS pending
         FROM expenses e ${where1} GROUP BY e.currency ORDER BY sum(e.amount_base) DESC`, params1),
      // Days with spending only; the client fills empty days so long ranges stay small.
      pool.query(
        `SELECT e.spent_on AS date, round(sum(e.amount_base), $1::int) AS total, count(*)::int AS count
         FROM expenses e ${where1} GROUP BY e.spent_on ORDER BY e.spent_on`, params1),
      // Always 7 rows, 0 = Sunday.
      pool.query(
        `SELECT w.d AS weekday, round(coalesce(sum(x.amount_base), 0), $1::int) AS total, count(x.id)::int AS count
         FROM generate_series(0, 6) AS w(d)
         LEFT JOIN (SELECT e.id, e.spent_on, e.amount_base FROM expenses e ${where1}) x ON extract(dow FROM x.spent_on) = w.d
         GROUP BY w.d ORDER BY w.d`, params1),
      pool.query(
        `SELECT e.paid_with AS "paidWith", round(sum(e.amount_base), $1::int) AS total, count(*)::int AS count
         FROM expenses e ${where1} GROUP BY e.paid_with ORDER BY sum(e.amount_base) DESC, e.paid_with`, params1),
      pool.query(`${EXPENSE_SELECT} ${whereT} ORDER BY e.amount_base DESC, e.spent_on DESC, e.id DESC LIMIT ${top}`, paramsT),
      // Days = inclusive span from..to (defaults: first matching expense .. today); exact average in SQL.
      pool.query(
        `WITH s AS (SELECT coalesce($2::date, min(e.spent_on)) AS d0,
                           greatest($3::date, max(e.spent_on), $2::date) AS d1,
                           coalesce(sum(e.amount_base), 0) AS spent
                    FROM expenses e ${whereD})
         SELECT (d1 - d0 + 1)::int AS days, round(spent / (d1 - d0 + 1), $1::int) AS "dailyAverage" FROM s`, paramsD),
    ]);

    // Ties go to the earliest day (byDay is in date order).
    const busiestDay = byDay.rows.reduce((best, d) => (!best || Number(d.total) > Number(best.total) ? d : best), null);

    res.json({
      baseCurrency: s.baseCurrency,
      displayCurrency: s.displayCurrency,
      totals: { ...totals.rows[0], ...deposits.rows[0] },
      byCategory: byCategory.rows,
      byMonth: byMonth.rows,
      byCurrency: byCurrency.rows,
      byDay: byDay.rows,
      byWeekday: byWeekday.rows,
      byPaidWith: byPaidWith.rows,
      topExpenses: topExpenses.rows,
      days: span.rows[0].days,
      dailyAverage: span.rows[0].dailyAverage,
      busiestDay,
    });
  });

  return router;
};
