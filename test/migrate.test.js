// Runs in its own database because it drops and rebuilds the schema.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pg = require('pg');
const { migrate } = require('../lib/migrate');
const { createTestDatabase } = require('./helpers');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
let pool;

const resetSchema = () => pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
const one = async (sql) => (await pool.query(sql)).rows[0];

before(async () => {
  pool = new pg.Pool({ connectionString: await createTestDatabase('_migrate') });
});
after(() => pool.end());

test('a v1 database upgrades with its data and wallet intact', async () => {
  await resetSchema();
  await pool.query(fs.readFileSync(path.join(MIGRATIONS, '001_v1_baseline.sql'), 'utf8'));
  await pool.query(`
    INSERT INTO deposits (deposited_on, amount) VALUES ('2026-09-01', 1500), ('2026-10-01', 1500);
    INSERT INTO expenses (description, spent_on, amount, paid_with, charged_to, reimbursed_on) VALUES
      ('Dinner', '2026-09-05', 100.10, 'cash', 'me', NULL),
      ('Taxi', '2026-09-06', 200, 'card', 'company', '2026-09-20'),
      ('Hotel', '2026-09-07', 50.05, 'card', 'company', NULL)`);

  await migrate(pool);

  assert.deepEqual(await one('SELECT base_currency, display_currency FROM settings'), { base_currency: 'SAR', display_currency: 'USD' });
  const rows = (await pool.query('SELECT amount, currency, rate, amount_base, reimbursed_on FROM expenses ORDER BY id')).rows;
  assert.deepEqual(rows.map((r) => [r.amount, r.currency, r.rate, r.amount_base]), [
    ['100.10', 'SAR', '1.0000000000', '100.10'], ['200.00', 'SAR', '1.0000000000', '200.00'], ['50.05', 'SAR', '1.0000000000', '50.05'],
  ]);
  const { wallet } = await one(`SELECT (SELECT sum(amount_base) FROM deposits)
    + (SELECT sum(amount_base) FILTER (WHERE reimbursed_on IS NOT NULL) - sum(amount_base) FROM expenses) AS wallet`);
  assert.equal(wallet, '2849.85');
  assert.equal((await one('SELECT count(*)::int AS n FROM categories WHERE parent_id IS NULL')).n, 5);
  assert.equal((await one('SELECT count(*)::int AS n FROM categories WHERE parent_id IS NOT NULL')).n, 13);
});

test('running migrations again is a no-op', async () => {
  await migrate(pool);
  assert.equal((await one('SELECT count(*)::int AS n FROM schema_migrations')).n, 4);
  assert.equal((await one('SELECT count(*)::int AS n FROM categories')).n, 18);
});

test('a fresh database migrates, honouring BASE_CURRENCY for the default settings', async () => {
  await resetSchema();
  await migrate(pool, { baseCurrency: 'USD' });
  assert.deepEqual(await one('SELECT base_currency, display_currency FROM settings'), { base_currency: 'USD', display_currency: 'EUR' });
  assert.equal((await one('SELECT count(*)::int AS n FROM deposits')).n, 0);
});

test('a failing migration rolls back completely', async () => {
  await resetSchema();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-wallet-migrations-'));
  try {
    fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE ok (id int);');
    fs.writeFileSync(path.join(dir, '002_bad.sql'), 'CREATE TABLE half (id int); SELECT * FROM missing_table;');
    await assert.rejects(migrate(pool, { dir }), /Migration 002_bad\.sql failed/);
    assert.deepEqual((await pool.query('SELECT version FROM schema_migrations')).rows, [{ version: '001_ok.sql' }]);
    assert.equal((await one("SELECT to_regclass('public.half') AS t")).t, null);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
