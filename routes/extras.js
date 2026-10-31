const express = require('express');
const { HttpError, parseId, parseDate, bodyOf } = require('../lib/validate');

// Receipt photos, bulk reimbursement (company claims) and description suggestions.

const MAX_RECEIPT = 2 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Trust the bytes, not the Content-Type header.
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

module.exports = (pool) => {
  const router = express.Router();
  const expenseExists = async (id) => (await pool.query('SELECT 1 FROM expenses WHERE id = $1', [id])).rowCount > 0;

  router.put('/expenses/:id/receipt', express.raw({ type: IMAGE_TYPES, limit: MAX_RECEIPT }), async (req, res) => {
    const id = parseId(req.params.id);
    const mime = Buffer.isBuffer(req.body) ? sniffImage(req.body) : null;
    if (!mime) throw new HttpError(400, 'Receipt must be a JPEG, PNG or WebP image', 'invalid_receipt');
    if (!(await expenseExists(id))) throw new HttpError(404, 'Expense not found', 'not_found');
    await pool.query(
      `INSERT INTO receipts (expense_id, mime, data) VALUES ($1, $2, $3)
       ON CONFLICT (expense_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, created_at = now()`,
      [id, mime, req.body]
    );
    res.sendStatus(204);
  });

  router.get('/expenses/:id/receipt', async (req, res) => {
    const { rows } = await pool.query('SELECT mime, data FROM receipts WHERE expense_id = $1', [parseId(req.params.id)]);
    if (!rows.length) throw new HttpError(404, 'No receipt for this expense', 'not_found');
    res.set({ 'Content-Type': rows[0].mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache' });
    res.send(rows[0].data);
  });

  router.delete('/expenses/:id/receipt', async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM receipts WHERE expense_id = $1', [parseId(req.params.id)]);
    if (!rowCount) throw new HttpError(404, 'No receipt for this expense', 'not_found');
    res.sendStatus(204);
  });

  // Marks several company expenses reimbursed on one date, all or nothing.
  router.post('/reimbursements', async (req, res) => {
    const body = bodyOf(req);
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 500) {
      throw new HttpError(400, 'ids must be a list of 1-500 expense ids', 'invalid_ids');
    }
    const ids = [...new Set(body.ids.map((id) => parseId(id)))];
    const date = parseDate(body.date);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE expenses SET reimbursed_on = $2
         WHERE id = ANY($1::int[]) AND charged_to = 'company' AND reimbursed_on IS NULL`,
        [ids, date]
      );
      if (rowCount !== ids.length) {
        throw new HttpError(409, 'Some expenses are missing or are not unreimbursed company expenses', 'not_claimable');
      }
      await client.query('COMMIT');
      res.json({ updated: rowCount });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.constraint === 'reimbursement_valid') {
        throw new HttpError(400, 'Reimbursement date cannot be before an expense date', 'reimbursement_before_expense');
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // Recent distinct descriptions with the choices last used for them, newest first.
  router.get('/suggestions', async (req, res) => {
    const { rows } = await pool.query(`
      SELECT description, "categoryId", "paidWith", "chargedTo", currency FROM (
        SELECT DISTINCT ON (lower(description)) description, category_id AS "categoryId", paid_with AS "paidWith",
          charged_to AS "chargedTo", currency, spent_on, id
        FROM expenses ORDER BY lower(description), spent_on DESC, id DESC
      ) s ORDER BY spent_on DESC, id DESC LIMIT 50`);
    res.json(rows);
  });

  return router;
};
