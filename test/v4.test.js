const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createAuth } = require('../lib/auth');
const { useTestServer, listen, close } = require('./helpers');

const t = useTestServer();
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const upload = (id, bytes, type = 'image/jpeg') =>
  fetch(`${t.base}/api/expenses/${id}/receipt`, { method: 'PUT', headers: { 'Content-Type': type }, body: bytes });

test('a receipt photo can be attached, fetched, replaced and removed', async () => {
  const { body: e } = await t.expense();
  assert.equal(e.hasReceipt, false);
  assert.equal((await upload(e.id, JPEG)).status, 204);
  const got = await fetch(`${t.base}/api/expenses/${e.id}/receipt`);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), JPEG);
  assert.equal((await t.call('GET', '/api/expenses')).body.items[0].hasReceipt, true);

  // The stored type comes from the bytes, not the header.
  assert.equal((await upload(e.id, PNG, 'image/jpeg')).status, 204);
  assert.equal((await fetch(`${t.base}/api/expenses/${e.id}/receipt`)).headers.get('content-type'), 'image/png');

  assert.equal((await t.call('DELETE', `/api/expenses/${e.id}/receipt`)).status, 204);
  assert.equal((await t.call('DELETE', `/api/expenses/${e.id}/receipt`)).status, 404);
  assert.equal((await t.call('GET', `/api/expenses/${e.id}/receipt`)).status, 404);
});

test('receipts are validated and go away with their expense', async () => {
  const { body: e } = await t.expense();
  const bad = await upload(e.id, Buffer.from('<script>alert(1)</script>'));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'invalid_receipt');
  assert.equal((await upload(e.id, JPEG, 'text/html')).status, 400);
  assert.equal((await upload(999, JPEG)).status, 404);
  const big = await upload(e.id, Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).code, 'too_large');

  await upload(e.id, JPEG);
  await t.call('DELETE', `/api/expenses/${e.id}`);
  assert.equal((await t.pool.query('SELECT count(*)::int AS n FROM receipts')).rows[0].n, 0);
});

test('several company expenses can be reimbursed at once, all or nothing', async () => {
  await t.deposit('100');
  const a = (await t.expense({ amount: '10', chargedTo: 'company', date: '2026-10-05' })).body;
  const b = (await t.expense({ amount: '20', chargedTo: 'company', date: '2026-10-06' })).body;
  const mine = (await t.expense({ amount: '5', chargedTo: 'me' })).body;

  const conflict = await t.call('POST', '/api/reimbursements', { ids: [a.id, mine.id], date: '2026-10-20' });
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'not_claimable']);
  assert.equal((await t.summary()).owedByCompany, '30.00'); // nothing changed

  const early = await t.call('POST', '/api/reimbursements', { ids: [a.id, b.id], date: '2026-10-05' });
  assert.deepEqual([early.status, early.body.code], [400, 'reimbursement_before_expense']);

  const ok = await t.call('POST', '/api/reimbursements', { ids: [a.id, b.id, a.id], date: '2026-10-20' });
  assert.deepEqual([ok.status, ok.body], [200, { updated: 2 }]);
  const s = await t.summary();
  assert.deepEqual([s.owedByCompany, s.wallet], ['0.00', '95.00']);
  assert.equal((await t.call('POST', '/api/reimbursements', { ids: [a.id], date: '2026-10-21' })).status, 409);
  for (const body of [{}, { ids: [], date: '2026-10-20' }, { ids: ['x'], date: '2026-10-20' }, { ids: [a.id] }]) {
    assert.equal((await t.call('POST', '/api/reimbursements', body)).status, 400, JSON.stringify(body));
  }
});

test('suggestions list recent distinct descriptions with their last choices', async () => {
  const food = (await t.category('Food')).body;
  await t.expense({ description: 'Taxi', date: '2026-10-01', paidWith: 'cash' });
  await t.expense({ description: 'Lunch', date: '2026-10-02', categoryId: food.id, chargedTo: 'company' });
  await t.expense({ description: 'taxi', date: '2026-10-03', paidWith: 'card' });
  const { body } = await t.call('GET', '/api/suggestions');
  assert.deepEqual(body, [
    { description: 'taxi', categoryId: null, paidWith: 'card', chargedTo: 'me', currency: 'SAR' },
    { description: 'Lunch', categoryId: food.id, paidWith: 'cash', chargedTo: 'company', currency: 'SAR' },
  ]);
});

test('errors carry stable codes for translation', async () => {
  const cases = [
    [await t.expense({ amount: 'abc' }), 400, 'invalid_amount'],
    [await t.expense({ description: '' }), 400, 'invalid_description'],
    [await t.expense({ currency: 'AED' }), 409, 'no_rate'],
    [await t.call('DELETE', '/api/expenses/999'), 404, 'not_found'],
    [await t.call('GET', '/api/expenses?from=2026-10-05&to=2026-10-01'), 400, 'invalid_range'],
  ];
  for (const [res, status, code] of cases) assert.deepEqual([res.status, res.body.code], [status, code]);
  await t.category('Food');
  const dup = await t.category('food');
  assert.equal(dup.body.code, 'name_taken');
});

test('a backup restores exactly, keeping receipts for expenses that still exist', async () => {
  await t.setRate('USD', '3.75');
  const food = (await t.category('Food')).body;
  const lunch = (await t.category('Lunch', food.id)).body;
  await t.deposit('1500');
  const e1 = (await t.expense({ amount: '10', currency: 'USD', categoryId: lunch.id, chargedTo: 'company' })).body;
  await t.reimburse(e1.id);
  await t.expense({ description: 'مواصلات', amount: '35' });
  await upload(e1.id, JPEG);
  const before = { summary: await t.summary(), expenses: (await t.call('GET', '/api/expenses')).body.items };

  const backup = await t.call('GET', '/api/backup');
  assert.match(backup.headers.get('content-disposition'), /trip-wallet-backup-\d{4}-\d{2}-\d{2}\.json/);
  assert.equal(backup.body.app, 'trip-wallet');

  await t.expense({ description: 'added after backup' });
  const restored = await t.call('POST', '/api/restore?confirm=replace', backup.body);
  assert.deepEqual([restored.status, restored.body], [200, { deposits: 1, expenses: 2, categories: 2 }]);
  assert.deepEqual(await t.summary(), before.summary);
  assert.deepEqual((await t.call('GET', '/api/expenses')).body.items, before.expenses);
  assert.equal((await t.expense()).body.id, 3); // sequences continue after the restored ids
});

test('an invalid restore changes nothing', async () => {
  await t.deposit('100');
  const { body: backup } = await t.call('GET', '/api/backup');
  assert.equal((await t.call('POST', '/api/restore', backup)).body.code, 'confirm_required');
  for (const broken of [
    { ...backup, app: 'other' },
    { ...backup, deposits: [{ ...backup.deposits[0], amount: '-1' }] },
    { ...backup, expenses: [{ id: 1, description: 'x', date: '2026-10-05', amount: '1', currency: 'SAR', rate: '1',
      paidWith: 'cash', chargedTo: 'me', reimbursedOn: '2026-10-01', categoryId: null }] }, // reimbursed on a "me" expense
    { ...backup, deposits: [backup.deposits[0], backup.deposits[0]] }, // duplicate id
  ]) {
    const res = await t.call('POST', '/api/restore?confirm=replace', broken);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.code, /^invalid_/);
  }
  assert.equal((await t.summary()).wallet, '100.00');
});

test('with APP_PASSWORD set, everything but the login page needs a session', async (ctx) => {
  let clock = Date.now();
  const s = await listen(createApp(t.pool, { auth: createAuth({ password: 'secret pw', secret: 'k', now: () => clock }) }));
  const base = `http://localhost:${s.address().port}`;
  const req = (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts });
  const login = (password) => req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  try {
    assert.deepEqual(await (await req('/api/session')).json(), { authEnabled: true });
    const api = await req('/api/summary');
    assert.deepEqual([api.status, (await api.json()).code], [401, 'login_required']);
    const page = await req('/');
    assert.deepEqual([page.status, page.headers.get('location')], [302, '/login.html']);
    assert.equal((await req('/login.html')).status, 200);

    assert.equal((await login('wrong')).status, 401);
    const ok = await login('secret pw');
    assert.equal(ok.status, 204);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /^tw_session=\d+\.[\w-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    const session = cookie.split(';')[0];
    assert.equal((await req('/api/summary', { headers: { cookie: session } })).status, 200);
    assert.equal((await req('/api/summary', { headers: { cookie: `${session}x` } })).status, 401);

    clock += 31 * 24 * 3600 * 1000; // sessions expire
    assert.equal((await req('/api/summary', { headers: { cookie: session } })).status, 401);

    for (let i = 0; i < 5; i++) await login('nope'); // the earlier success reset the count; 5 failures within a minute
    assert.equal((await login('secret pw')).status, 429);
    clock += 61_000;
    assert.equal((await login('secret pw')).status, 204);
  } finally {
    await close(s);
  }
  assert.deepEqual((await t.call('GET', '/api/session')).body, { authEnabled: false });
  assert.equal((await t.call('GET', '/api/summary')).status, 200); // default stays open
});
