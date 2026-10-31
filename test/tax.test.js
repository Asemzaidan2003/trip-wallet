const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useTestServer } = require('./helpers');

const t = useTestServer();
const put = (id, fields) => t.call('PUT', `/api/expenses/${id}`, {
  description: 'Taxi', date: '2026-10-05', amount: '20.00', paidWith: 'cash', chargedTo: 'me', ...fields,
});

test('an expense without tax has tax 0 and the total is the amount', async () => {
  const { body } = await t.expense({ amount: '50' });
  assert.deepEqual([body.amount, body.tax, body.taxBase], ['50.00', '0.00', '0.00']);
});

test('tax is part of the total: the wallet drops by the total, and tax is reported', async () => {
  await t.deposit('1000');
  // subtotal 100 + tax 15 = total 115
  const { body: e } = await t.expense({ amount: '115', tax: '15' });
  assert.deepEqual([e.amount, e.tax, e.amountBase, e.taxBase], ['115.00', '15.00', '115.00', '15.00']);
  const s = await t.summary();
  assert.deepEqual([s.wallet, s.received, s.spentTotal, s.reimbursedTotal], ['885.00', '1000.00', '115.00', '0.00']);
  const r = (await t.call('GET', '/api/reports')).body;
  assert.deepEqual([r.totals.spent, r.totals.tax], ['115.00', '15.00']);
});

test('tax is converted at the same rate as the total', async () => {
  await t.setRate('USD', '3.75');
  const { body: e } = await t.expense({ amount: '23', tax: '3', currency: 'USD' });
  assert.deepEqual([e.amount, e.tax, e.amountBase, e.taxBase], ['23.00', '3.00', '86.25', '11.25']);
  const r = (await t.call('GET', '/api/reports')).body;
  assert.deepEqual([r.totals.spent, r.totals.tax], ['86.25', '11.25']);
});

test('3-decimal currencies keep their precision', async () => {
  await t.setRate('KWD', '12');
  const { body: e } = await t.expense({ amount: '10.500', tax: '0.500', currency: 'KWD' });
  assert.deepEqual([e.amount, e.tax, e.amountBase, e.taxBase], ['10.500', '0.500', '126.00', '6.00']);
});

test('tax must be a valid amount smaller than the total', async () => {
  for (const [fields, code] of [
    [{ amount: '10', tax: '10' }, 'invalid_tax'], // no subtotal left
    [{ amount: '10', tax: '12' }, 'invalid_tax'],
    [{ amount: '10', tax: '-1' }, 'invalid_tax'],
    [{ amount: '10', tax: 'abc' }, 'invalid_tax'],
    [{ amount: '10', tax: '1.234' }, 'invalid_tax'], // too many decimals for SAR
  ]) {
    const res = await t.expense(fields);
    assert.deepEqual([res.status, res.body.code], [400, code], JSON.stringify(fields));
  }
  for (const empty of [undefined, null, '', 0, '0']) {
    assert.equal((await t.expense({ amount: '10', tax: empty })).body.tax, '0.00');
  }
});

test('editing keeps tax in step with the total, and tax can be added later', async () => {
  const { body: e } = await t.expense({ amount: '50' });
  const added = (await put(e.id, { amount: '57.5', tax: '7.5' })).body;
  assert.deepEqual([added.amount, added.tax, added.amountBase, added.taxBase], ['57.50', '7.50', '57.50', '7.50']);
  const removed = (await put(e.id, { amount: '57.5' })).body; // omitted tax means 0
  assert.deepEqual([removed.tax, removed.taxBase], ['0.00', '0.00']);
  assert.equal((await put(e.id, { amount: '5', tax: '6' })).status, 400);
});

test('the CSV has subtotal, tax and total', async () => {
  await t.expense({ amount: '115', tax: '15', description: 'Hotel' });
  const csv = (await t.call('GET', '/api/expenses.csv')).body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(csv[1], '2026-10-05,Hotel,,,100.00,15.00,115.00,SAR,1.0000000000,115.00,15.00,SAR,cash,me,,no');
});

test('tax survives a backup and restore; old backups without tax restore with tax 0', async () => {
  await t.expense({ amount: '115', tax: '15' });
  const { body: backup } = await t.call('GET', '/api/backup');
  assert.equal(backup.expenses[0].tax, '15.00');
  await t.call('POST', '/api/restore?confirm=replace', backup);
  assert.deepEqual((await t.call('GET', '/api/expenses')).body.items.map((e) => [e.amount, e.tax, e.taxBase]), [['115.00', '15.00', '15.00']]);

  const old = { ...backup, expenses: backup.expenses.map(({ tax, ...rest }) => rest) };
  assert.equal((await t.call('POST', '/api/restore?confirm=replace', old)).status, 200);
  assert.equal((await t.call('GET', '/api/expenses')).body.items[0].tax, '0.00');
  const bad = { ...backup, expenses: backup.expenses.map((e) => ({ ...e, tax: '999' })) };
  assert.equal((await t.call('POST', '/api/restore?confirm=replace', bad)).status, 400);
});

test('existing expenses are upgraded with tax 0 and their totals unchanged', async () => {
  // Simulates a v4 database: expenses written before the tax columns existed.
  await t.pool.query('ALTER TABLE expenses DROP COLUMN tax, DROP COLUMN tax_base');
  await t.pool.query(`INSERT INTO expenses (description, spent_on, amount, currency, rate, amount_base, paid_with, charged_to)
    VALUES ('old', '2026-10-01', '80.50', 'SAR', 1, '80.50', 'cash', 'me')`);
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'migrations', '004_tax.sql'), 'utf8');
  await t.pool.query(sql);
  const { rows } = await t.pool.query('SELECT amount, tax, tax_base FROM expenses');
  assert.deepEqual(rows, [{ amount: '80.50', tax: '0.00', tax_base: '0.00' }]);
});
