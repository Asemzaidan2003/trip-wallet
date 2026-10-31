const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useTestServer } = require('./helpers');

const t = useTestServer();
const rates = async () => Object.fromEntries((await t.call('GET', '/api/rates')).body.map((r) => [r.currency, r]));

test('a foreign expense is converted to the base at the stored rate', async () => {
  assert.equal((await t.setRate('USD', '3.75')).status, 200);
  const { body } = await t.expense({ amount: '10', currency: 'USD' });
  assert.equal(body.amount, '10.00');
  assert.equal(body.rate, '3.7500000000');
  assert.equal(body.amountBase, '37.50');
});

test('conversion rounds half away from zero to the base decimals', async () => {
  await t.setRate('KWD', '12.2');
  assert.equal((await t.expense({ amount: '1.255', currency: 'KWD' })).body.amountBase, '15.31');
  await t.setRate('EUR', '3.333');
  assert.equal((await t.expense({ amount: '1.50', currency: 'EUR' })).body.amountBase, '5.00'); // 4.9995
});

test('amount decimals follow the currency', async () => {
  await t.setRate('KWD', '12');
  await t.setRate('JPY', '0.025');
  assert.equal((await t.expense({ amount: '1.234', currency: 'KWD' })).body.amount, '1.234');
  assert.equal((await t.expense({ amount: '1.2', currency: 'KWD' })).body.amount, '1.200');
  assert.equal((await t.expense({ amount: '1.234', currency: 'SAR' })).status, 400);
  assert.equal((await t.expense({ amount: '1.5', currency: 'JPY' })).status, 400);
  const jpy = (await t.expense({ amount: '500', currency: 'JPY' })).body;
  assert.equal(jpy.amount, '500');
  assert.equal(jpy.amountBase, '12.50');
});

test('currencies with more than 3 decimals are not supported', async () => {
  assert.equal((await t.expense({ amount: '1.2345', currency: 'CLF', rate: '400' })).status, 400);
  assert.equal((await t.setRate('CLF', '400')).status, 400);
});

test('a missing rate is 409 unless the entry gives its own rate', async () => {
  const res = await t.expense({ currency: 'AED' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /AED/);
  const ok = await t.expense({ currency: 'AED', amount: '100', rate: '1.0213' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.amountBase, '102.13');
  assert.equal((await t.expense({ currency: 'AED', rate: '-1' })).status, 400);
});

test('base-currency entries always have rate 1', async () => {
  assert.equal((await t.expense({ currency: 'SAR', rate: '2' })).status, 400);
  assert.equal((await t.expense({ currency: 'SAR', rate: '1' })).body.rate, '1.0000000000');
  assert.equal((await t.deposit('10', '2026-10-01', { currency: 'SAR', rate: '3' })).status, 400);
});

test('changing a rate later does not change existing entries', async () => {
  await t.setRate('USD', '3.75');
  await t.deposit('100', '2026-10-01', { currency: 'USD' });
  await t.setRate('USD', '4');
  const [d] = (await t.call('GET', '/api/deposits')).body.items;
  assert.equal(d.amountBase, '375.00');
  assert.equal((await t.summary()).wallet, '375.00');
});

test('the summary shows the second currency at the current rate', async () => {
  await t.deposit('375');
  assert.equal((await t.summary()).walletDisplay, null); // no USD rate yet
  await t.setRate('USD', '3.75');
  const s = await t.summary();
  assert.equal(s.displayRate, '3.7500000000');
  assert.equal(s.walletDisplay, '100.00');
  assert.equal(s.spentByMeDisplay, '0.00');

  await t.call('PUT', '/api/settings', { displayCurrency: 'SAR' });
  assert.equal((await t.summary()).walletDisplay, '375.00');
  await t.setRate('KWD', '12.5');
  await t.call('PUT', '/api/settings', { displayCurrency: 'KWD' });
  assert.equal((await t.summary()).walletDisplay, '30.000');
});

test('the base currency can change only while there is no data', async () => {
  await t.setRate('USD', '3.75');
  const res = await t.call('PUT', '/api/settings', { baseCurrency: 'KWD', displayCurrency: 'SAR' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { baseCurrency: 'KWD', displayCurrency: 'SAR', baseLocked: false });
  assert.deepEqual(await rates(), {}); // old rates were relative to SAR

  assert.equal((await t.deposit('10')).body.amount, '10.000');
  assert.equal((await t.call('GET', '/api/settings')).body.baseLocked, true);
  assert.equal((await t.call('PUT', '/api/settings', { baseCurrency: 'SAR' })).status, 409);
  assert.equal((await t.call('PUT', '/api/settings', { displayCurrency: 'USD' })).status, 200);
  assert.equal((await t.call('PUT', '/api/settings', { displayCurrency: 'XXZ' })).status, 400);
});

test('refresh stores inverted API rates', async () => {
  let asked;
  t.fetchImpl = async (base) => { asked = base; return { USD: 0.25, EUR: 0.5, SAR: 1, XXZ: 2, KWD: 0.08 }; };
  const res = await t.call('POST', '/api/rates/refresh');
  assert.equal(res.status, 200);
  assert.equal(asked, 'SAR');
  assert.equal(res.body.updated, 3);
  const r = await rates();
  assert.deepEqual(Object.keys(r), ['EUR', 'KWD', 'USD']);
  assert.equal(r.USD.rate, '4.0000000000');
  assert.equal(r.EUR.rate, '2.0000000000');
  assert.equal(r.KWD.rate, '12.5000000000');
  assert.equal(r.USD.source, 'api');
});

test('manual rates survive a refresh', async () => {
  await t.setRate('USD', '3.70');
  t.fetchImpl = async () => ({ USD: 0.25, EUR: 0.5 });
  await t.call('POST', '/api/rates/refresh');
  const r = await rates();
  assert.equal(r.USD.rate, '3.7000000000');
  assert.equal(r.USD.source, 'manual');
  assert.equal(r.EUR.rate, '2.0000000000');
});

test('a failed refresh is 502 and keeps existing rates', async (ctx) => {
  ctx.mock.method(console, 'error', () => {});
  await t.setRate('USD', '3.75');
  for (const impl of [
    async () => { throw new Error('offline'); },
    async () => 'not an object',
    async () => ({ USD: NaN, EUR: -1, GBP: 'x' }),
    async () => null,
  ]) {
    t.fetchImpl = impl;
    const res = await t.call('POST', '/api/rates/refresh');
    assert.equal(res.status, 502);
    assert.match(res.body.error, /existing rates were kept/);
  }
  assert.equal((await rates()).USD.rate, '3.7500000000');
});

test('rate endpoints validate input', async () => {
  assert.equal((await t.setRate('SAR', '1')).status, 400);
  assert.equal((await t.setRate('USD', '0')).status, 400);
  assert.equal((await t.setRate('USD', 'abc')).status, 400);
  assert.equal((await t.setRate('usd', '3')).status, 400);
  assert.equal((await t.call('DELETE', '/api/rates/USD')).status, 404);
  await t.setRate('USD', '3.75');
  assert.equal((await t.call('DELETE', '/api/rates/USD')).status, 204);
});
