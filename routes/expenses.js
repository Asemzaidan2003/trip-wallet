const express = require('express');
const {
  HttpError, parseId, parseDate, parseCurrency, parseMoney, parseText, parseEnum, parsePaging, bodyOf,
} = require('../lib/validate');
const { getSettings, resolveRate, AMOUNT_BASE_SQL } = require('../lib/money');
const { expenseFilter, EXPENSE_SELECT: SELECT } = require('../lib/filters');

const ORDER = 'ORDER BY e.spent_on DESC, e.id DESC';

const CSV_COLUMNS = ['date', 'description', 'category', 'subcategory', 'subtotal', 'tax', 'total', 'currency', 'rate', 'total_base',
  'tax_base', 'base_currency', 'paid_with', 'charged_to', 'reimbursed_on', 'receipt'];

// Exact a - b for decimal strings (the subtotal is the total minus the tax).
function minus(a, b) {
  const scale = Math.max((a.split('.')[1] || '').length, (b.split('.')[1] || '').length);
  const units = (s) => BigInt(s.replace('.', '') + '0'.repeat(scale - (s.split('.')[1] || '').length));
  const n = (units(a) - units(b)).toString().padStart(scale + 1, '0');
  return scale ? `${n.slice(0, -scale)}.${n.slice(-scale)}` : n;
}

// RFC 4180 quoting. Text cells starting with = + - @ tab or CR get a ' so spreadsheets don't run them as formulas.
function csvCell(value, isText) {
  let s = value == null ? '' : String(value);
  if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

module.exports = (pool) => {
  const router = express.Router();
  const getExpense = async (id) => (await pool.query(`${SELECT} WHERE e.id = $1`, [id])).rows[0];

  async function parseExpense(req, existing) {
    const body = bodyOf(req);
    const settings = await getSettings(pool);
    const description = parseText(body.description, 'description', 200);
    const date = parseDate(body.date);
    const currency = parseCurrency(body.currency ?? settings.baseCurrency);
    const amount = parseMoney(body.amount, currency); // the total paid: subtotal + tax
    const hasTax = body.tax !== undefined && body.tax !== null && body.tax !== '';
    const tax = parseMoney(hasTax ? body.tax : 0, currency, { zero: true, field: 'tax' });
    if (Number(tax) >= Number(amount)) throw new HttpError(400, 'Tax must be less than the total', 'invalid_tax');
    const paidWith = parseEnum(body.paidWith, 'paidWith', ['cash', 'card', 'other']);
    const chargedTo = parseEnum(body.chargedTo, 'chargedTo', ['me', 'company']);
    let categoryId = null;
    if (body.categoryId !== undefined && body.categoryId !== null && body.categoryId !== '') {
      categoryId = parseId(body.categoryId, 'categoryId');
      const { rowCount } = await pool.query('SELECT 1 FROM categories WHERE id = $1', [categoryId]);
      if (!rowCount) throw new HttpError(400, 'categoryId does not exist', 'invalid_categoryId');
    }
    const rate = await resolveRate(pool, settings, currency, body.rate, existing);
    return [description, date, amount, currency, rate, settings.baseMinor, paidWith, chargedTo, categoryId, tax];
  }

  router.get('/expenses', async (req, res) => {
    const { page, pageSize } = parsePaging(req.query);
    const { where, params } = expenseFilter(req.query);
    const [items, count] = await Promise.all([
      pool.query(`${SELECT} ${where} ${ORDER} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
      pool.query(`SELECT count(*)::int AS total FROM expenses e ${where}`, params),
    ]);
    res.json({ items: items.rows, total: count.rows[0].total, page, pageSize });
  });

  // ponytail: unbounded export; fine for one trip's expenses.
  router.get('/expenses.csv', async (req, res) => {
    const { where, params } = expenseFilter(req.query);
    const [{ rows }, settings] = await Promise.all([pool.query(`${SELECT} ${where} ${ORDER}`, params), getSettings(pool)]);
    const lines = rows.map((e) => [
      csvCell(e.date), csvCell(e.description, true),
      csvCell(e.parentCategoryName ?? e.categoryName, true), csvCell(e.parentCategoryName ? e.categoryName : '', true),
      csvCell(minus(e.amount, e.tax)), csvCell(e.tax), csvCell(e.amount), csvCell(e.currency), csvCell(e.rate), csvCell(e.amountBase),
      csvCell(e.taxBase), csvCell(settings.baseCurrency),
      csvCell(e.paidWith), csvCell(e.chargedTo), csvCell(e.reimbursedOn), e.hasReceipt ? 'yes' : 'no',
    ].join(','));
    const today = new Date().toISOString().slice(0, 10);
    res.type('text/csv; charset=utf-8');
    res.attachment(`expenses-${today}.csv`);
    // The BOM makes Excel read UTF-8 (e.g. Arabic descriptions) correctly.
    res.send(`﻿${[CSV_COLUMNS.join(','), ...lines].join('\r\n')}\r\n`);
  });

  router.post('/expenses', async (req, res) => {
    const { rows } = await pool.query(
      `INSERT INTO expenses (description, spent_on, amount, currency, rate, amount_base, paid_with, charged_to, category_id, tax, tax_base)
       VALUES ($1, $2, $3, $4, $5, ${AMOUNT_BASE_SQL('$3', '$5', '$6')}, $7, $8, $9, $10, ${AMOUNT_BASE_SQL('$10', '$5', '$6')}) RETURNING id`,
      await parseExpense(req)
    );
    res.status(201).json(await getExpense(rows[0].id));
  });

  router.put('/expenses/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { rows: found } = await pool.query('SELECT currency, rate, reimbursed_on FROM expenses WHERE id = $1', [id]);
    if (!found.length) throw new HttpError(404, 'Expense not found', 'not_found');
    const values = await parseExpense(req, found[0]);
    if (found[0].reimbursed_on && values[7] === 'me') {
      throw new HttpError(409, 'A reimbursed expense must stay on the company; undo the reimbursement first', 'reimbursed_must_be_company');
    }
    try {
      await pool.query(
        `UPDATE expenses SET description = $1, spent_on = $2, amount = $3, currency = $4, rate = $5,
           amount_base = ${AMOUNT_BASE_SQL('$3', '$5', '$6')}, paid_with = $7, charged_to = $8, category_id = $9,
           tax = $10, tax_base = ${AMOUNT_BASE_SQL('$10', '$5', '$6')}
         WHERE id = $11`,
        [...values, id]
      );
    } catch (err) {
      if (err.constraint === 'reimbursement_valid') throw new HttpError(400, 'Expense date cannot be after its reimbursement date', 'date_after_reimbursement');
      throw err;
    }
    res.json(await getExpense(id));
  });

  router.delete('/expenses/:id', async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM expenses WHERE id = $1', [parseId(req.params.id)]);
    if (!rowCount) throw new HttpError(404, 'Expense not found', 'not_found');
    res.sendStatus(204);
  });

  // Tells apart "no such expense" (404) from "not allowed in its current state" (409).
  async function conflictOr404(id, message, code) {
    const { rowCount } = await pool.query('SELECT 1 FROM expenses WHERE id = $1', [id]);
    throw rowCount ? new HttpError(409, message, code) : new HttpError(404, 'Expense not found', 'not_found');
  }

  router.post('/expenses/:id/reimbursement', async (req, res) => {
    const id = parseId(req.params.id);
    const date = parseDate(bodyOf(req).date);
    let rowCount;
    try {
      ({ rowCount } = await pool.query(
        `UPDATE expenses SET reimbursed_on = $2 WHERE id = $1 AND charged_to = 'company' AND reimbursed_on IS NULL`,
        [id, date]
      ));
    } catch (err) {
      if (err.constraint === 'reimbursement_valid') throw new HttpError(400, 'Reimbursement date cannot be before the expense date', 'reimbursement_before_expense');
      throw err;
    }
    if (!rowCount) await conflictOr404(id, 'Only unreimbursed company expenses can be reimbursed', 'not_claimable');
    res.json(await getExpense(id));
  });

  router.delete('/expenses/:id/reimbursement', async (req, res) => {
    const id = parseId(req.params.id);
    const { rowCount } = await pool.query(
      'UPDATE expenses SET reimbursed_on = NULL WHERE id = $1 AND reimbursed_on IS NOT NULL', [id]
    );
    if (!rowCount) await conflictOr404(id, 'Expense is not reimbursed', 'not_reimbursed');
    res.json(await getExpense(id));
  });

  return router;
};
