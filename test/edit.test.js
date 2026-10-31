const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useTestServer } = require('./helpers');

const t = useTestServer();
const put = (id, fields) => t.call('PUT', `/api/expenses/${id}`, {
  description: 'Taxi', date: '2026-10-05', amount: '20.00', paidWith: 'cash', chargedTo: 'me', ...fields,
});

test('editing an expense changes every field and the wallet follows', async () => {
  await t.deposit('100');
  const food = (await t.category('Food')).body;
  const { body: e } = await t.expense({ amount: '20' });
  const res = await put(e.id, {
    description: 'Dinner', date: '2026-10-07', amount: '35.50', paidWith: 'card', chargedTo: 'company', categoryId: food.id,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    [res.body.description, res.body.date, res.body.amount, res.body.paidWith, res.body.chargedTo, res.body.categoryName],
    ['Dinner', '2026-10-07', '35.50', 'card', 'company', 'Food']
  );
  const s = await t.summary();
  assert.equal(s.wallet, '64.50');
  assert.equal(s.owedByCompany, '35.50');
  assert.equal(s.spentByMe, '0.00');
});

test('editing a reimbursed expense keeps the wallet credit in step', async () => {
  await t.deposit('100');
  const { body: e } = await t.expense({ amount: '40', chargedTo: 'company' });
  await t.reimburse(e.id);
  const res = await put(e.id, { amount: '60', chargedTo: 'company' });
  assert.equal(res.body.reimbursedOn, '2026-10-20');
  assert.equal((await t.summary()).wallet, '100.00');
});

test('a reimbursed expense cannot move to me or past its reimbursement date', async () => {
  const { body: e } = await t.expense({ chargedTo: 'company' });
  await t.reimburse(e.id, '2026-10-20');
  assert.equal((await put(e.id, { chargedTo: 'me' })).status, 409);
  assert.equal((await put(e.id, { chargedTo: 'company', date: '2026-10-21' })).status, 400);
  assert.equal((await put(e.id, { chargedTo: 'company', date: '2026-10-20' })).status, 200);
});

test('an edit keeps the historical rate unless the currency changes', async () => {
  await t.setRate('USD', '3.75');
  await t.setRate('EUR', '4.10');
  const { body: e } = await t.expense({ amount: '10', currency: 'USD' });
  await t.setRate('USD', '4');
  const same = (await put(e.id, { amount: '20', currency: 'USD' })).body;
  assert.equal(same.rate, '3.7500000000');
  assert.equal(same.amountBase, '75.00');
  const changed = (await put(e.id, { amount: '20', currency: 'EUR' })).body;
  assert.equal(changed.rate, '4.1000000000');
  assert.equal(changed.amountBase, '82.00');
  const explicit = (await put(e.id, { amount: '20', currency: 'EUR', rate: '4' })).body;
  assert.equal(explicit.amountBase, '80.00');
  const toBase = (await put(e.id, { amount: '20', currency: 'SAR' })).body;
  assert.equal(toBase.rate, '1.0000000000');
  assert.equal((await put(e.id, { amount: '20', currency: 'SAR', rate: '4' })).status, 400);
});

test('deposits can be edited', async () => {
  await t.setRate('USD', '3.75');
  const { body: d } = await t.deposit('1500');
  const res = await t.call('PUT', `/api/deposits/${d.id}`, { date: '2026-11-01', amount: '400', currency: 'USD' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: d.id, date: '2026-11-01', amount: '400.00', currency: 'USD', rate: '3.7500000000', amountBase: '1500.00' });
  assert.equal((await t.summary()).wallet, '1500.00');
});

test('edits validate ids and bodies', async () => {
  const { body: e } = await t.expense();
  const { body: d } = await t.deposit('10');
  assert.equal((await put(999, {})).status, 404);
  assert.equal((await put('abc', {})).status, 400);
  assert.equal((await put(e.id, { amount: '-1' })).status, 400);
  assert.equal((await put(e.id, { description: '' })).status, 400);
  assert.equal((await t.call('PUT', '/api/deposits/999', { date: '2026-10-01', amount: '1' })).status, 404);
  assert.equal((await t.call('PUT', `/api/deposits/${d.id}`, { date: '2026-10-01' })).status, 400);
  assert.equal((await t.call('PUT', `/api/deposits/${d.id}`, { date: '2026-10-01', amount: '1', currency: 'AED' })).status, 409);
});
