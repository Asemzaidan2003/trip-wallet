const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useTestServer } = require('./helpers');

const t = useTestServer();
const get = async (path) => (await t.call('GET', path)).body;
const descs = async (query) => (await get(`/api/expenses?${query}`)).items.map((e) => e.description);

test('expenses are paged with a correct total', async () => {
  for (let i = 1; i <= 30; i++) await t.expense({ description: `E${i}`, date: `2026-10-${String(i).padStart(2, '0')}` });
  const p1 = await get('/api/expenses');
  assert.deepEqual([p1.items.length, p1.total, p1.page, p1.pageSize], [25, 30, 1, 25]);
  assert.equal(p1.items[0].description, 'E30');
  const p2 = await get('/api/expenses?page=2');
  assert.deepEqual([p2.items.length, p2.total, p2.items.at(-1).description], [5, 30, 'E1']);
  assert.deepEqual((await get('/api/expenses?page=3')).items, []);
  assert.equal((await get('/api/expenses?page=3')).total, 30);
  assert.equal((await get('/api/expenses?pageSize=100')).items.length, 30);
  assert.equal((await get('/api/expenses?pageSize=7&page=5')).items.length, 2);
});

test('invalid paging is 400', async () => {
  for (const q of ['pageSize=101', 'pageSize=0', 'pageSize=abc', 'page=0', 'page=-1', 'page=1.5', 'page=99999999999999999999']) {
    assert.equal((await t.call('GET', `/api/expenses?${q}`)).status, 400, q);
  }
});

test('same-day expenses are newest first', async () => {
  await t.expense({ description: 'first' });
  await t.expense({ description: 'second' });
  assert.deepEqual(await descs(''), ['second', 'first']);
});

test('each filter works on its own', async () => {
  const food = (await t.category('Food')).body;
  const lunch = (await t.category('Lunch', food.id)).body;
  const travel = (await t.category('Travel')).body;
  await t.setRate('USD', '3.75');
  await t.expense({ description: 'Lunch 50%', date: '2026-10-01', categoryId: lunch.id, chargedTo: 'company' });
  await t.expense({ description: 'Groceries', date: '2026-10-02', categoryId: food.id, paidWith: 'card' });
  await t.expense({ description: 'Flight', date: '2026-10-03', categoryId: travel.id, chargedTo: 'company', currency: 'USD' });
  const { body: r } = await t.expense({ description: 'Hotel', date: '2026-10-04', chargedTo: 'company', paidWith: 'other' });
  await t.reimburse(r.id);

  assert.deepEqual(await descs('from=2026-10-02&to=2026-10-03'), ['Flight', 'Groceries']);
  assert.deepEqual(await descs('from=2026-10-04'), ['Hotel']);
  assert.deepEqual(await descs('to=2026-10-01'), ['Lunch 50%']);
  assert.deepEqual(await descs(`categoryId=${food.id}`), ['Groceries', 'Lunch 50%']);
  assert.deepEqual(await descs(`categoryId=${lunch.id}`), ['Lunch 50%']);
  assert.deepEqual(await descs('categoryId=none'), ['Hotel']);
  assert.deepEqual(await descs('chargedTo=me'), ['Groceries']);
  assert.deepEqual(await descs('paidWith=other'), ['Hotel']);
  assert.deepEqual(await descs('status=pending'), ['Flight', 'Lunch 50%']);
  assert.deepEqual(await descs('status=reimbursed'), ['Hotel']);
  assert.deepEqual(await descs('currency=USD'), ['Flight']);
  assert.deepEqual(await descs('q=LIGHT'), ['Flight']);
  assert.deepEqual(await descs('q=%25'), ['Lunch 50%']); // a literal % must not match everything
  assert.deepEqual(await descs('q=_'), []);
  assert.equal((await get('/api/expenses?chargedTo=company&status=pending&currency=SAR')).total, 1);
});

test('invalid filters are 400', async () => {
  for (const q of ['from=2026-02-30', 'from=2026-10-05&to=2026-10-01', 'categoryId=abc', 'chargedTo=boss',
    'paidWith=gold', 'status=lost', 'currency=XXZ', `q=${'x'.repeat(101)}`]) {
    assert.equal((await t.call('GET', `/api/expenses?${q}`)).status, 400, q);
  }
});

test('deposits are paged and filtered by date and currency', async () => {
  await t.setRate('USD', '3.75');
  for (let i = 1; i <= 3; i++) await t.deposit('100', `2026-0${i}-01`);
  await t.deposit('50', '2026-04-01', { currency: 'USD' });
  const p = await get('/api/deposits?pageSize=2&page=2');
  assert.deepEqual([p.total, p.items.map((d) => d.date)], [4, ['2026-02-01', '2026-01-01']]);
  assert.equal((await get('/api/deposits?from=2026-02-01&to=2026-03-31')).total, 2);
  assert.equal((await get('/api/deposits?currency=USD')).items[0].amountBase, '187.50');
  assert.equal((await t.call('GET', '/api/deposits?pageSize=500')).status, 400);
});

test('CSV export applies filters and is safe for spreadsheets', async () => {
  const food = (await t.category('Food')).body;
  const lunch = (await t.category('Lunch', food.id)).body;
  await t.expense({ description: 'Said "hi", paid', categoryId: lunch.id });
  await t.expense({ description: '=HYPERLINK("http://evil")', chargedTo: 'company' });
  await t.expense({ description: '-negative?', chargedTo: 'company', amount: '5' });

  const res = await t.call('GET', '/api/expenses.csv?chargedTo=me');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="?expenses-\d{4}-\d{2}-\d{2}\.csv"?/);
  const lines = res.body.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'date,description,category,subcategory,subtotal,tax,total,currency,rate,total_base,tax_base,base_currency,paid_with,charged_to,reimbursed_on,receipt');
  assert.deepEqual(lines.slice(1), ['2026-10-05,"Said ""hi"", paid",Food,Lunch,20.00,0.00,20.00,SAR,1.0000000000,20.00,0.00,SAR,cash,me,,no']);

  // text() strips a BOM while decoding, so check the raw bytes for the UTF-8 BOM (EF BB BF).
  const bytes = new Uint8Array(await (await fetch(`${t.base}/api/expenses.csv`)).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const all = (await t.call('GET', '/api/expenses.csv')).body;
  assert.match(all, /,"'=HYPERLINK\(""http:\/\/evil""\)",/);
  assert.match(all, /,'-negative\?,/);
  assert.equal((await t.call('GET', '/api/expenses.csv?status=bad')).status, 400);
});
