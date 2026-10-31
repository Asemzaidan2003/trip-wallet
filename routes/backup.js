const express = require('express');
const {
  HttpError, parseId, parseDate, parseCurrency, parseMoney, parseRate, parseText, parseEnum, bodyOf,
} = require('../lib/validate');
const { getSettings, AMOUNT_BASE_SQL } = require('../lib/money');

// Full JSON backup and restore. Receipt photos are not in the file; on restore they are kept for expenses that still exist.
const FORMAT = { app: 'trip-wallet', version: 1 };
const list = (v, field) => {
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be a list`, 'invalid_backup');
  return v;
};
const opt = (v, parse) => (v === null || v === undefined ? null : parse(v));

// Re-validates every value with the same rules as the API, so a hand-edited file can't smuggle bad data in.
function parseBackup(b) {
  if (b.app !== FORMAT.app || b.version !== FORMAT.version) throw new HttpError(400, 'Not a Trip Wallet backup', 'invalid_backup');
  const settings = { base: parseCurrency(b.settings?.baseCurrency), display: parseCurrency(b.settings?.displayCurrency) };
  const rates = list(b.rates, 'rates').map((r) => [parseCurrency(r.currency), parseRate(r.rate), parseEnum(r.source, 'source', ['api', 'manual'])]);
  const cats = list(b.categories, 'categories').map((c) => [parseId(c.id), opt(c.parentId, parseId), parseText(c.name, 'name', 50)]);
  const catIds = new Set(cats.map(([id]) => id));
  for (const [, parent] of cats) if (parent !== null && !catIds.has(parent)) throw new HttpError(400, 'Unknown parent category', 'invalid_backup');
  const deposits = list(b.deposits, 'deposits').map((d) => {
    const currency = parseCurrency(d.currency);
    return [parseId(d.id), parseDate(d.date), parseMoney(d.amount, currency), currency, parseRate(d.rate)];
  });
  const expenses = list(b.expenses, 'expenses').map((e) => {
    const currency = parseCurrency(e.currency);
    const categoryId = opt(e.categoryId, parseId);
    if (categoryId !== null && !catIds.has(categoryId)) throw new HttpError(400, 'Unknown category', 'invalid_backup');
    return [parseId(e.id), parseText(e.description, 'description', 200), parseDate(e.date), parseMoney(e.amount, currency), currency,
      parseRate(e.rate), parseEnum(e.paidWith, 'paidWith', ['cash', 'card', 'other']),
      parseEnum(e.chargedTo, 'chargedTo', ['me', 'company']), opt(e.reimbursedOn, parseDate), categoryId,
      // Backups made before tax existed have no tax field; that means 0.
      parseMoney(e.tax ?? 0, currency, { zero: true, field: 'tax' })];
  });
  return { settings, rates, cats, deposits, expenses };
}

module.exports = (pool) => {
  const router = express.Router();

  router.get('/backup', async (req, res) => {
    const s = await getSettings(pool);
    const [rates, categories, deposits, expenses] = await Promise.all([
      pool.query('SELECT currency, rate, source FROM fx_rates ORDER BY currency'),
      pool.query('SELECT id, parent_id AS "parentId", name FROM categories ORDER BY parent_id NULLS FIRST, id'),
      pool.query('SELECT id, deposited_on AS date, amount, currency, rate FROM deposits ORDER BY id'),
      pool.query(`SELECT id, description, spent_on AS date, amount, tax, currency, rate, paid_with AS "paidWith",
        charged_to AS "chargedTo", reimbursed_on AS "reimbursedOn", category_id AS "categoryId" FROM expenses ORDER BY id`),
    ]);
    res.attachment(`trip-wallet-backup-${new Date().toISOString().slice(0, 10)}.json`);
    res.json({
      ...FORMAT, exportedAt: new Date().toISOString(),
      settings: { baseCurrency: s.baseCurrency, displayCurrency: s.displayCurrency },
      rates: rates.rows, categories: categories.rows, deposits: deposits.rows, expenses: expenses.rows,
    });
  });

  // Replaces ALL data with the file's contents in one transaction. Needs ?confirm=replace.
  router.post('/restore', async (req, res) => {
    if (req.query.confirm !== 'replace') throw new HttpError(400, 'Add ?confirm=replace to replace all data', 'confirm_required');
    const b = parseBackup(bodyOf(req));
    const minor = new Intl.NumberFormat('en', { style: 'currency', currency: b.settings.base }).resolvedOptions().maximumFractionDigits;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TEMP TABLE kept_receipts ON COMMIT DROP AS SELECT * FROM receipts');
      await client.query('TRUNCATE receipts, expenses, deposits, categories, fx_rates RESTART IDENTITY CASCADE');
      await client.query('UPDATE settings SET base_currency = $1, display_currency = $2', [b.settings.base, b.settings.display]);
      for (const r of b.rates) await client.query('INSERT INTO fx_rates (currency, rate, source) VALUES ($1, $2, $3)', r);
      // Parents first so the foreign key holds.
      for (const c of [...b.cats].sort((x, y) => (x[1] === null ? 0 : 1) - (y[1] === null ? 0 : 1))) {
        await client.query('INSERT INTO categories (id, parent_id, name) VALUES ($1, $2, $3)', c);
      }
      for (const d of b.deposits) {
        await client.query(`INSERT INTO deposits (id, deposited_on, amount, currency, rate, amount_base)
          VALUES ($1, $2, $3, $4, $5, ${AMOUNT_BASE_SQL('$3', '$5', '$6')})`, [...d, minor]);
      }
      for (const e of b.expenses) {
        await client.query(`INSERT INTO expenses (id, description, spent_on, amount, currency, rate, amount_base, paid_with,
            charged_to, reimbursed_on, category_id, tax, tax_base)
          VALUES ($1, $2, $3, $4, $5, $6, ${AMOUNT_BASE_SQL('$4', '$6', '$12')}, $7, $8, $9, $10, $11, ${AMOUNT_BASE_SQL('$11', '$6', '$12')})`,
        [...e, minor]);
      }
      await client.query('INSERT INTO receipts SELECT k.* FROM kept_receipts k JOIN expenses e ON e.id = k.expense_id');
      for (const t of ['categories', 'deposits', 'expenses']) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), coalesce(max(id), 0) + 1, false) FROM ${t}`);
      }
      await client.query('COMMIT');
      res.json({ deposits: b.deposits.length, expenses: b.expenses.length, categories: b.cats.length });
    } catch (err) {
      await client.query('ROLLBACK');
      // Constraint violations (e.g. duplicate ids, reimbursed before spent) mean the file is inconsistent.
      if (err.code?.startsWith?.('23')) throw new HttpError(400, 'The backup file is inconsistent', 'invalid_backup');
      throw err;
    } finally {
      client.release();
    }
  });

  return router;
};
