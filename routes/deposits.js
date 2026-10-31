const express = require('express');
const { HttpError, parseId, parseDate, parseCurrency, parseMoney, parsePaging, bodyOf } = require('../lib/validate');
const { getSettings, resolveRate, AMOUNT_BASE_SQL } = require('../lib/money');

const COLS = `id, deposited_on AS date, amount, currency, rate, amount_base AS "amountBase"`;

module.exports = (pool) => {
  const router = express.Router();

  async function parseDeposit(req, existing) {
    const body = bodyOf(req);
    const settings = await getSettings(pool);
    const date = parseDate(body.date);
    const currency = parseCurrency(body.currency ?? settings.baseCurrency);
    const amount = parseMoney(body.amount, currency);
    const rate = await resolveRate(pool, settings, currency, body.rate, existing);
    return [date, amount, currency, rate, settings.baseMinor];
  }

  router.get('/', async (req, res) => {
    const { page, pageSize } = parsePaging(req.query);
    const params = [];
    const where = [];
    if (req.query.from) where.push(`deposited_on >= $${params.push(parseDate(req.query.from, 'from'))}`);
    if (req.query.to) where.push(`deposited_on <= $${params.push(parseDate(req.query.to, 'to'))}`);
    if (req.query.currency) where.push(`currency = $${params.push(parseCurrency(req.query.currency))}`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [items, count] = await Promise.all([
      pool.query(`SELECT ${COLS} FROM deposits ${w} ORDER BY deposited_on DESC, id DESC
                  LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
      pool.query(`SELECT count(*)::int AS total FROM deposits ${w}`, params),
    ]);
    res.json({ items: items.rows, total: count.rows[0].total, page, pageSize });
  });

  router.post('/', async (req, res) => {
    const { rows } = await pool.query(
      `INSERT INTO deposits (deposited_on, amount, currency, rate, amount_base)
       VALUES ($1, $2, $3, $4, ${AMOUNT_BASE_SQL('$2', '$4', '$5')}) RETURNING ${COLS}`,
      await parseDeposit(req)
    );
    res.status(201).json(rows[0]);
  });

  router.put('/:id', async (req, res) => {
    const id = parseId(req.params.id);
    const { rows: found } = await pool.query('SELECT currency, rate FROM deposits WHERE id = $1', [id]);
    if (!found.length) throw new HttpError(404, 'Deposit not found', 'not_found');
    const { rows } = await pool.query(
      `UPDATE deposits SET deposited_on = $1, amount = $2, currency = $3, rate = $4,
         amount_base = ${AMOUNT_BASE_SQL('$2', '$4', '$5')}
       WHERE id = $6 RETURNING ${COLS}`,
      [...(await parseDeposit(req, found[0])), id]
    );
    res.json(rows[0]);
  });

  router.delete('/:id', async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM deposits WHERE id = $1', [parseId(req.params.id)]);
    if (!rowCount) throw new HttpError(404, 'Deposit not found', 'not_found');
    res.sendStatus(204);
  });

  return router;
};
