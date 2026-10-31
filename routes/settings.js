const express = require('express');
const { HttpError, CURRENCIES, parseCurrency, parseRate, bodyOf } = require('../lib/validate');
const { getSettings } = require('../lib/money');

const publicSettings = ({ baseCurrency, displayCurrency, baseLocked }) => ({ baseCurrency, displayCurrency, baseLocked });

module.exports = (pool, { fetchRates }) => {
  const router = express.Router();

  router.get('/settings', async (req, res) => {
    res.json(publicSettings(await getSettings(pool)));
  });

  router.put('/settings', async (req, res) => {
    const body = bodyOf(req);
    const current = await getSettings(pool);
    const baseCurrency = parseCurrency(body.baseCurrency ?? current.baseCurrency, 'baseCurrency');
    const displayCurrency = parseCurrency(body.displayCurrency ?? current.displayCurrency, 'displayCurrency');
    if (baseCurrency !== current.baseCurrency) {
      // Entries store rates relative to the base, so changing it would rewrite history.
      if (current.baseLocked) throw new HttpError(409, 'The base currency cannot change once deposits or expenses exist', 'base_locked');
      await pool.query('DELETE FROM fx_rates'); // all rates were relative to the old base
    }
    await pool.query('UPDATE settings SET base_currency = $1, display_currency = $2', [baseCurrency, displayCurrency]);
    res.json(publicSettings(await getSettings(pool)));
  });

  router.get('/rates', async (req, res) => {
    const { rows } = await pool.query(
      'SELECT currency, rate, source, updated_at AS "updatedAt" FROM fx_rates ORDER BY currency'
    );
    res.json(rows);
  });

  router.put('/rates/:code', async (req, res) => {
    const currency = parseCurrency(req.params.code);
    const rate = parseRate(bodyOf(req).rate);
    const { baseCurrency } = await getSettings(pool);
    if (currency === baseCurrency) throw new HttpError(400, 'The base currency always has rate 1', 'base_rate_must_be_1');
    const { rows } = await pool.query(
      `INSERT INTO fx_rates (currency, rate, source) VALUES ($1, $2, 'manual')
       ON CONFLICT (currency) DO UPDATE SET rate = excluded.rate, source = 'manual', updated_at = now()
       RETURNING currency, rate, source, updated_at AS "updatedAt"`,
      [currency, rate]
    );
    res.json(rows[0]);
  });

  router.delete('/rates/:code', async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM fx_rates WHERE currency = $1', [parseCurrency(req.params.code)]);
    if (!rowCount) throw new HttpError(404, 'No rate stored for this currency', 'not_found');
    res.sendStatus(204);
  });

  router.post('/rates/refresh', async (req, res) => {
    res.json(await refreshRates(pool, fetchRates));
  });

  return router;
};

// Pulls rates from the API. Manual rates are never overwritten; on failure stored rates are kept.
async function refreshRates(pool, fetchRates) {
  const { baseCurrency } = await getSettings(pool);
  let rates;
  try {
    rates = await fetchRates(baseCurrency);
  } catch (err) {
    console.error('Rate refresh failed:', err.message);
  }
  // The API gives 1 BASE = x CUR; we store base units per 1 CUR, i.e. 1/x.
  const entries = rates && typeof rates === 'object'
    ? Object.entries(rates).filter(([c, x]) => c !== baseCurrency && CURRENCIES.has(c) && Number.isFinite(x) && x > 0)
    : [];
  if (!entries.length) throw new HttpError(502, 'Could not fetch exchange rates; existing rates were kept', 'rates_unavailable');

  const { rowCount } = await pool.query(
    `INSERT INTO fx_rates (currency, rate, source)
     SELECT c, round(1 / x::numeric, 10), 'api' FROM unnest($1::text[], $2::text[]) AS t(c, x)
     WHERE round(1 / x::numeric, 10) > 0
     ON CONFLICT (currency) DO UPDATE SET rate = excluded.rate, updated_at = now()
     WHERE fx_rates.source = 'api'`,
    [entries.map(([c]) => c), entries.map(([, x]) => String(x))]
  );
  return { updated: rowCount };
}

module.exports.refreshRates = refreshRates;
