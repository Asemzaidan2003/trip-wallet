const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { useTestServer, listen, close } = require('./helpers');

const t = useTestServer();
const list = async (what) => (await t.call('GET', `/api/${what}`)).body.items;

test('empty summary has zero totals in both currencies', async () => {
  assert.deepEqual(await t.summary(), {
    baseCurrency: 'SAR', displayCurrency: 'USD', displayRate: null,
    wallet: '0.00', walletDisplay: null, owedByCompany: '0.00', owedByCompanyDisplay: null,
    spentByMe: '0.00', spentByMeDisplay: null,
    received: '0.00', receivedDisplay: null, spentTotal: '0.00', spentTotalDisplay: null, reimbursedTotal: '0.00', reimbursedTotalDisplay: null,
  });
  assert.deepEqual(await list('deposits'), []);
  assert.deepEqual(await list('expenses'), []);
});

test('creating a deposit returns the row with an unshifted date and raises the wallet', async () => {
  const res = await t.deposit('1500');
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 1, date: '2026-10-01', amount: '1500.00', currency: 'SAR', rate: '1.0000000000', amountBase: '1500.00' });
  assert.equal((await t.summary()).wallet, '1500.00');
  assert.deepEqual(await list('deposits'), [res.body]);
});

test('deposit validation rejects bad input with 400', async () => {
  const bad = [
    {}, { amount: '10' }, { date: '2026-02-30', amount: '10' }, { date: '2026-13-01', amount: '10' },
    { date: '0000-01-01', amount: '10' }, { date: 'abc', amount: '10' }, { date: '2026-10-01', amount: 'abc' },
    { date: '2026-10-01', amount: 0 }, { date: '2026-10-01', amount: '-5' }, { date: '2026-10-01', amount: '1.234' },
    { date: '2026-10-01', amount: 0.1 + 0.2 }, { date: '2026-10-01', amount: '123456789012' },
    { date: '2026-10-01', amount: '10', currency: 'XXZ' }, { date: '2026-10-01', amount: '10', currency: 'sar' },
  ];
  for (const body of bad) {
    const res = await t.call('POST', '/api/deposits', body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.match(res.body.error, /\w/);
  }
  assert.equal((await t.call('POST', '/api/deposits', undefined, { raw: '{bad json', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await t.call('POST', '/api/deposits', undefined, { raw: 'date=2026-10-01', headers: {} })).status, 400);
  assert.equal((await t.call('POST', '/api/deposits', [1, 2])).status, 400);
  assert.deepEqual(await list('deposits'), []);
});

test('numeric amounts are accepted and padded to the currency decimals', async () => {
  assert.equal((await t.deposit(99.5)).body.amount, '99.50');
});

test('an expense on me lowers the wallet and counts as spent by me', async () => {
  await t.deposit('100');
  const res = await t.expense({ amount: '30.25' });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, {
    id: 1, description: 'Taxi', date: '2026-10-05', amount: '30.25', tax: '0.00', currency: 'SAR', rate: '1.0000000000',
    amountBase: '30.25', taxBase: '0.00', paidWith: 'cash', chargedTo: 'me', reimbursedOn: null,
    categoryId: null, categoryName: null, parentCategoryName: null, hasReceipt: false,
  });
  const s = await t.summary();
  assert.equal(s.wallet, '69.75');
  assert.equal(s.spentByMe, '30.25');
  assert.equal(s.owedByCompany, '0.00');
});

test('an expense on the company lowers the wallet and is owed by the company', async () => {
  await t.deposit('100');
  await t.expense({ amount: '40', chargedTo: 'company', paidWith: 'card' });
  const s = await t.summary();
  assert.equal(s.wallet, '60.00');
  assert.equal(s.owedByCompany, '40.00');
  assert.equal(s.spentByMe, '0.00');
});

test('expense validation rejects bad input with 400', async () => {
  const bad = [
    { description: '' }, { description: '   ' }, { description: 'x'.repeat(201) }, { description: 42 },
    { paidWith: 'bitcoin' }, { chargedTo: 'boss' }, { date: '2026-02-29' }, { amount: '0.00' },
    { categoryId: 'abc' }, { categoryId: 999 },
  ];
  for (const fields of bad) {
    assert.equal((await t.expense(fields)).status, 400, `expected 400 for ${JSON.stringify(fields)}`);
  }
  assert.deepEqual(await list('expenses'), []);
});

test('descriptions are trimmed and 200 characters is allowed', async () => {
  assert.equal((await t.expense({ description: '  Dinner  ' })).body.description, 'Dinner');
  assert.equal((await t.expense({ description: 'x'.repeat(200) })).status, 201);
});

test('reimbursing a company expense puts the money back in the wallet', async () => {
  await t.deposit('100');
  const { body: e } = await t.expense({ amount: '40', chargedTo: 'company' });
  const res = await t.reimburse(e.id, '2026-10-20');
  assert.equal(res.status, 200);
  assert.equal(res.body.reimbursedOn, '2026-10-20');
  const s = await t.summary();
  assert.equal(s.wallet, '100.00');
  assert.equal(s.owedByCompany, '0.00');
});

test('reimbursement rules: twice is 409, on me is 409, unknown is 404, bad id is 400', async () => {
  const { body: company } = await t.expense({ chargedTo: 'company' });
  const { body: mine } = await t.expense({ chargedTo: 'me' });
  assert.equal((await t.reimburse(company.id)).status, 200);
  assert.equal((await t.reimburse(company.id)).status, 409);
  assert.equal((await t.reimburse(mine.id)).status, 409);
  assert.equal((await t.reimburse(999)).status, 404);
  assert.equal((await t.reimburse('abc')).status, 400);
  assert.equal((await t.reimburse('9999999999')).status, 400);
});

test('reimbursement date is validated', async () => {
  const { body: e } = await t.expense({ chargedTo: 'company', date: '2026-10-05' });
  assert.equal((await t.reimburse(e.id, '2026-10-04')).status, 400);
  assert.equal((await t.reimburse(e.id, '2026-02-30')).status, 400);
  assert.equal((await t.call('POST', `/api/expenses/${e.id}/reimbursement`, {})).status, 400);
  assert.equal((await t.call('POST', `/api/expenses/${e.id}/reimbursement`)).status, 400);
  assert.equal((await t.reimburse(e.id, '2026-10-05')).status, 200);
});

test('undoing a reimbursement reverts the balance', async () => {
  await t.deposit('100');
  const { body: e } = await t.expense({ amount: '40', chargedTo: 'company' });
  await t.reimburse(e.id);
  const res = await t.call('DELETE', `/api/expenses/${e.id}/reimbursement`);
  assert.equal(res.status, 200);
  assert.equal(res.body.reimbursedOn, null);
  const s = await t.summary();
  assert.equal(s.wallet, '60.00');
  assert.equal(s.owedByCompany, '40.00');
  assert.equal((await t.call('DELETE', `/api/expenses/${e.id}/reimbursement`)).status, 409);
  assert.equal((await t.call('DELETE', '/api/expenses/999/reimbursement')).status, 404);
});

test('balance math is exact', async () => {
  await t.deposit('1500', '2026-09-01');
  await t.deposit('1500', '2026-10-01');
  await t.expense({ amount: '100.10', chargedTo: 'me' });
  const { body: reimbursed } = await t.expense({ amount: '200', chargedTo: 'company' });
  await t.expense({ amount: '50.05', chargedTo: 'company' });
  await t.reimburse(reimbursed.id);
  const s = await t.summary();
  assert.equal(s.wallet, '2849.85');
  assert.equal(s.owedByCompany, '50.05');
  assert.equal(s.spentByMe, '100.10');

  await t.pool.query('TRUNCATE deposits, expenses RESTART IDENTITY CASCADE');
  await t.deposit('0.10');
  await t.deposit('0.20');
  assert.equal((await t.summary()).wallet, '0.30');
});

test('deleting a deposit lowers the wallet; deleting it again is 404', async () => {
  const { body: d } = await t.deposit('100');
  await t.deposit('50');
  assert.equal((await t.call('DELETE', `/api/deposits/${d.id}`)).status, 204);
  assert.equal((await t.summary()).wallet, '50.00');
  assert.equal((await t.call('DELETE', `/api/deposits/${d.id}`)).status, 404);
  assert.equal((await t.call('DELETE', '/api/deposits/abc')).status, 400);
  assert.equal((await t.call('DELETE', '/api/deposits/9999999999')).status, 400);
});

test('deleting expenses undoes their effect on the wallet', async () => {
  await t.deposit('100');
  const { body: reimbursed } = await t.expense({ amount: '30', chargedTo: 'company' });
  const { body: pending } = await t.expense({ amount: '20', chargedTo: 'company' });
  await t.reimburse(reimbursed.id);
  assert.equal((await t.summary()).wallet, '80.00');

  assert.equal((await t.call('DELETE', `/api/expenses/${reimbursed.id}`)).status, 204);
  assert.equal((await t.summary()).wallet, '80.00');

  assert.equal((await t.call('DELETE', `/api/expenses/${pending.id}`)).status, 204);
  const s = await t.summary();
  assert.equal(s.wallet, '100.00');
  assert.equal(s.owedByCompany, '0.00');
  assert.equal((await t.call('DELETE', `/api/expenses/${pending.id}`)).status, 404);
});

test('user text is stored verbatim (escaping is the UI job)', async () => {
  const xss = '<img src=x onerror=alert(1)>';
  await t.expense({ description: xss });
  assert.equal((await list('expenses'))[0].description, xss);
});

test('unknown API routes return JSON 404', async () => {
  const res = await t.call('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: 'Not found', code: 'not_found' });
});

test('the page and its modules are served with the right types', async () => {
  const page = await fetch(t.base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Trip Wallet<\/title>/);
  const js = await fetch(t.base + '/js/main.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('database faults return a generic 500 without details', async (ctx) => {
  ctx.mock.method(console, 'error', () => {});
  const brokenPool = { query: () => Promise.reject(new Error('secret connection detail')) };
  const s = await listen(createApp(brokenPool));
  try {
    const res = await fetch(`http://localhost:${s.address().port}/api/summary`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'Internal server error' });
  } finally {
    await close(s);
  }
});
