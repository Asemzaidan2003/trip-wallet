// Shared setup for the integration tests: real Postgres, never the network.
const { before, beforeEach, after } = require('node:test');
const pg = require('pg');
const { createApp } = require('../app');
const { migrate } = require('../lib/migrate');

const TEST_URL = process.env.TEST_DATABASE_URL;

// Guard: these tests TRUNCATE and DROP, so never point them at the real database.
if (!TEST_URL || TEST_URL === process.env.DATABASE_URL || !new URL(TEST_URL).pathname.endsWith('_test')) {
  throw new Error('TEST_DATABASE_URL must be set, differ from DATABASE_URL, and name a database ending in _test');
}

// Returns a connection string for a sibling database (still ending in _test), creating it if needed.
async function createTestDatabase(suffix = '') {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1).replace(/_test$/, `${suffix}_test`);
  const admin = new URL(TEST_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.href });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    if (err.code !== '42P04') throw err; // already exists
  } finally {
    await client.end();
  }
  url.pathname = `/${dbName}`;
  return url.href;
}

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

// Starts the app on a migrated test DB; every test begins with empty tables and SAR/USD settings.
function useTestServer() {
  const ctx = { fetchImpl: async () => { throw new Error('network disabled in tests'); } };

  before(async () => {
    ctx.pool = new pg.Pool({ connectionString: await createTestDatabase() });
    await migrate(ctx.pool);
    ctx.server = await listen(createApp(ctx.pool, { fetchRates: (base) => ctx.fetchImpl(base) }));
    ctx.base = `http://localhost:${ctx.server.address().port}`;
  });

  beforeEach(async () => {
    ctx.fetchImpl = async () => { throw new Error('network disabled in tests'); };
    await ctx.pool.query(`TRUNCATE deposits, expenses, categories, fx_rates RESTART IDENTITY CASCADE;
      UPDATE settings SET base_currency = 'SAR', display_currency = 'USD'`);
  });

  after(async () => {
    await close(ctx.server);
    await ctx.pool.end();
  });

  ctx.call = async (method, path, body, { raw, headers } = {}) => {
    const res = await fetch(ctx.base + path, {
      method,
      headers: headers ?? (body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: json && text ? JSON.parse(text) : text || null, headers: res.headers };
  };

  ctx.summary = async () => (await ctx.call('GET', '/api/summary')).body;
  ctx.deposit = (amount, date = '2026-10-01', extra = {}) => ctx.call('POST', '/api/deposits', { date, amount, ...extra });
  ctx.expense = (fields = {}) => ctx.call('POST', '/api/expenses', {
    description: 'Taxi', date: '2026-10-05', amount: '20.00', paidWith: 'cash', chargedTo: 'me', ...fields,
  });
  ctx.reimburse = (id, date = '2026-10-20') => ctx.call('POST', `/api/expenses/${id}/reimbursement`, { date });
  ctx.setRate = (code, rate) => ctx.call('PUT', `/api/rates/${code}`, { rate });
  ctx.category = (name, parentId) => ctx.call('POST', '/api/categories', { name, parentId });

  return ctx;
}

module.exports = { useTestServer, createTestDatabase, listen, close };
