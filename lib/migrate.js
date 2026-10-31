const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = path.join(__dirname, '..', 'migrations');

// Applies migrations/*.sql in name order, each in its own transaction, once.
// ponytail: no advisory lock; single process. Add pg_advisory_xact_lock if two servers ever start together.
async function migrate(pool, { dir = DEFAULT_DIR, baseCurrency = process.env.BASE_CURRENCY || 'SAR' } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files.filter((f) => !applied.has(f))) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Read by 002 to label pre-v2 rows; only matters when upgrading a v1 database.
      await client.query("SELECT set_config('app.base_currency', $1, true)", [baseCurrency]);
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      err.message = `Migration ${file} failed: ${err.message}`;
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { migrate };
