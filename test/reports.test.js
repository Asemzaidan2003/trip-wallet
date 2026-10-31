const { test } = require('node:test');
const assert = require('node:assert/strict');
const { useTestServer } = require('./helpers');

const t = useTestServer();
const report = async (q = '') => {
  const res = await t.call('GET', `/api/reports${q ? `?${q}` : ''}`);
  assert.equal(res.status, 200);
  return res.body;
};

test('an empty report has zero totals with the right scale', async () => {
  const r = await report();
  assert.deepEqual(r.totals, {
    count: 0, spent: '0.00', spentDisplay: null, mine: '0.00', mineDisplay: null, company: '0.00', companyDisplay: null,
    pending: '0.00', pendingDisplay: null, reimbursed: '0.00', reimbursedDisplay: null, tax: '0.00', taxDisplay: null, deposits: '0.00', depositsDisplay: null,
  });
  assert.deepEqual([r.byCategory, r.byMonth, r.byCurrency], [[], [], []]);
});

test('reports roll up, drill down and convert', async () => {
  await t.setRate('USD', '3.75');
  await t.setRate('KWD', '12.5');
  const food = (await t.category('Food')).body;
  const lunch = (await t.category('Lunch', food.id)).body;
  const dinner = (await t.category('Dinner', food.id)).body;
  const travel = (await t.category('Travel')).body;
  await t.deposit('3000', '2026-09-01');
  await t.deposit('100', '2026-10-01', { currency: 'USD' });
  await t.expense({ amount: '30', date: '2026-09-10', categoryId: lunch.id });
  await t.expense({ amount: '45', date: '2026-10-02', categoryId: dinner.id, chargedTo: 'company' });
  await t.expense({ amount: '15', date: '2026-10-03', categoryId: food.id });
  await t.expense({ amount: '2.000', currency: 'KWD', date: '2026-10-04', categoryId: travel.id, chargedTo: 'company' });
  const { body: r1 } = await t.expense({ amount: '100', currency: 'USD', date: '2026-10-05', chargedTo: 'company' });
  await t.reimburse(r1.id);

  const r = await report();
  assert.deepEqual(r.totals, {
    count: 5, spent: '490.00', spentDisplay: '130.67', mine: '45.00', mineDisplay: '12.00',
    company: '445.00', companyDisplay: '118.67', pending: '70.00', pendingDisplay: '18.67',
    reimbursed: '375.00', reimbursedDisplay: '100.00', tax: '0.00', taxDisplay: '0.00', deposits: '3375.00', depositsDisplay: '900.00',
  });
  assert.deepEqual(r.byCategory.map((c) => [c.name, c.total, c.count, c.hasChildren]), [
    ['Uncategorized', '375.00', 1, false], ['Food', '90.00', 3, true], ['Travel', '25.00', 1, false],
  ]);
  assert.deepEqual(r.byMonth, [{ month: '2026-09', total: '30.00', count: 1 }, { month: '2026-10', total: '460.00', count: 4 }]);
  assert.deepEqual(r.byCurrency, [
    { currency: 'SAR', amount: '90.00', amountBase: '90.00', pending: '45.00' },
    { currency: 'USD', amount: '100.00', amountBase: '375.00', pending: '0.00' },
    { currency: 'KWD', amount: '2.000', amountBase: '25.00', pending: '2.000' },
  ].sort((a, b) => Number(b.amountBase) - Number(a.amountBase)));

  const drill = await report(`categoryId=${food.id}`);
  assert.deepEqual(drill.byCategory.map((c) => [c.name, c.total]), [['Dinner', '45.00'], ['Lunch', '30.00'], ['Food (general)', '15.00']]);
  assert.equal(drill.totals.spent, '90.00');
});

test('filters narrow reports; dates also limit deposits', async () => {
  await t.deposit('1000', '2026-09-01');
  await t.deposit('500', '2026-10-01');
  await t.expense({ amount: '10', date: '2026-09-15' });
  await t.expense({ amount: '20', date: '2026-10-15', chargedTo: 'company' });
  const company = await report('chargedTo=company');
  assert.deepEqual([company.totals.spent, company.totals.count, company.totals.deposits], ['20.00', 1, '1500.00']);
  const oct = await report('from=2026-10-01&to=2026-10-31');
  assert.deepEqual([oct.totals.spent, oct.totals.deposits, oct.byMonth.length], ['20.00', '500.00', 1]);
  assert.equal((await t.call('GET', '/api/reports?from=bad')).status, 400);
});

// Fixture: 2026-10-04 and 10-11 are Sundays, 10-05 Monday, 10-10 Saturday. Total 97.75 SAR.
async function dailyFixture() {
  await t.setRate('KWD', '12.5');
  await t.expense({ amount: '10.00', date: '2026-10-04', paidWith: 'cash' });
  await t.expense({ amount: '15.50', date: '2026-10-04', paidWith: 'card' });
  await t.expense({ amount: '40.00', date: '2026-10-05', paidWith: 'card' });
  await t.expense({ amount: '7.25', date: '2026-10-10', paidWith: 'other' });
  await t.expense({ amount: '2.000', currency: 'KWD', date: '2026-10-11', paidWith: 'card', chargedTo: 'company' });
}

test('new report fields are empty but well-formed on an empty database', async () => {
  const r = await report();
  assert.deepEqual([r.byDay, r.byPaidWith, r.topExpenses], [[], [], []]);
  assert.deepEqual(r.byWeekday, [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, total: '0.00', count: 0 })));
  assert.deepEqual([r.days, r.dailyAverage, r.busiestDay], [null, null, null]);
  const oct = await report('from=2026-10-01&to=2026-10-31');
  assert.deepEqual([oct.days, oct.dailyAverage], [31, '0.00']);
});

test('reports break spending down by day, weekday, payment method and biggest expense', async () => {
  await dailyFixture();
  const r = await report();
  assert.deepEqual(r.byDay.map((d) => [d.date, d.total, d.count]), [
    ['2026-10-04', '25.50', 2], ['2026-10-05', '40.00', 1], ['2026-10-10', '7.25', 1], ['2026-10-11', '25.00', 1],
  ]);
  assert.deepEqual(r.busiestDay, { date: '2026-10-05', total: '40.00', count: 1 });
  assert.deepEqual(r.byWeekday.map((w) => [w.total, w.count]), [
    ['50.50', 3], ['40.00', 1], ['0.00', 0], ['0.00', 0], ['0.00', 0], ['0.00', 0], ['7.25', 1],
  ]);
  assert.deepEqual(r.byPaidWith.map((p) => [p.paidWith, p.total, p.count]), [['card', '80.50', 3], ['cash', '10.00', 1], ['other', '7.25', 1]]);
  assert.deepEqual(r.topExpenses.map((e) => e.amountBase), ['40.00', '25.00', '15.50', '10.00', '7.25']);
  assert.deepEqual([r.topExpenses[1].amount, r.topExpenses[1].currency, r.topExpenses[1].description], ['2.000', 'KWD', 'Taxi']);

  const company = await report('chargedTo=company');
  assert.deepEqual(company.byPaidWith.map((p) => [p.paidWith, p.total, p.count]), [['card', '25.00', 1]]);
  assert.deepEqual([company.topExpenses.length, company.byDay.length], [1, 1]);
});

test('the busiest day goes to the earliest of equal days', async () => {
  await t.expense({ amount: '30', date: '2026-10-08' });
  await t.expense({ amount: '30', date: '2026-10-03' });
  await t.expense({ amount: '5', date: '2026-10-01' });
  assert.deepEqual((await report()).busiestDay, { date: '2026-10-03', total: '30.00', count: 1 });
});

test('top limits the biggest expenses and is validated', async () => {
  await dailyFixture();
  assert.equal((await report('top=2')).topExpenses.length, 2);
  assert.equal((await report('top=50')).topExpenses.length, 5);
  for (const q of ['top=0', 'top=51', 'top=abc', 'top=1.5']) {
    assert.equal((await t.call('GET', `/api/reports?${q}`)).status, 400, q);
  }
});

test('days and the daily average are exact', async () => {
  await dailyFixture();
  const oct = await report('from=2026-10-01&to=2026-10-31');
  assert.deepEqual([oct.days, oct.dailyAverage], [31, '3.15']);
  const upTo = await report('to=2026-10-11');
  assert.deepEqual([upTo.days, upTo.dailyAverage], [8, '12.22']);
  const today = new Date().toLocaleDateString('en-CA');
  const end = today > '2026-10-11' ? today : '2026-10-11';
  assert.equal((await report()).days, (Date.parse(end) - Date.parse('2026-10-04')) / 86400000 + 1);
  const future = await report('from=2099-01-01');
  assert.deepEqual([future.days, future.dailyAverage], [1, '0.00']);

  await t.pool.query('TRUNCATE expenses RESTART IDENTITY CASCADE');
  await t.expense({ amount: '0.05', date: '2026-10-01' });
  assert.equal((await report('from=2026-10-01&to=2026-10-02')).dailyAverage, '0.03'); // half rounds away from zero
});
