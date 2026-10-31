const { HttpError, minorOf, parseRate } = require('./validate');

// Settings plus everything needed to show a second currency.
// displayRate is null when the display currency has no known rate; the UI then shows "—".
async function getSettings(db) {
  const { rows } = await db.query(`
    SELECT s.base_currency AS "baseCurrency", s.display_currency AS "displayCurrency",
      CASE WHEN s.display_currency = s.base_currency THEN 1::numeric ELSE r.rate END AS "displayRate",
      EXISTS (SELECT 1 FROM deposits) OR EXISTS (SELECT 1 FROM expenses) AS "baseLocked"
    FROM settings s LEFT JOIN fx_rates r ON r.currency = s.display_currency`);
  const s = rows[0];
  return { ...s, baseMinor: minorOf(s.baseCurrency), displayMinor: minorOf(s.displayCurrency) };
}

// Picks the rate (base units per 1 unit of `currency`) for a new or edited entry.
// Base-currency entries are always 1; an edit that keeps its currency keeps its historical rate.
async function resolveRate(db, settings, currency, bodyRate, existing) {
  if (currency === settings.baseCurrency) {
    if (bodyRate !== undefined && bodyRate !== null && bodyRate !== '' && Number(bodyRate) !== 1) {
      throw new HttpError(400, `rate must be 1 (or omitted) for the base currency ${currency}`, 'base_rate_must_be_1');
    }
    return '1';
  }
  if (bodyRate !== undefined && bodyRate !== null && bodyRate !== '') return parseRate(bodyRate);
  if (existing && existing.currency === currency) return existing.rate;
  const { rows } = await db.query('SELECT rate FROM fx_rates WHERE currency = $1', [currency]);
  if (!rows.length) throw new HttpError(409, `No exchange rate for ${currency}: set one in Settings or enter a rate`, 'no_rate');
  return rows[0].rate;
}

// SQL for amount_base, exact: round(amount * rate, base minor units). Params: amount, rate, minor.
const AMOUNT_BASE_SQL = (a, r, m) => `round(${a}::numeric * ${r}::numeric, ${m}::int)`;

// "x AS key, x converted AS keyDisplay" for each money expression, using $b/$r/$d placeholders.
function withDisplay(exprs, { b, r, d }) {
  return Object.entries(exprs)
    .map(([key, x]) => `round(${x}, ${b}::int) AS "${key}", round((${x}) / ${r}::numeric, ${d}::int) AS "${key}Display"`)
    .join(',\n');
}

module.exports = { getSettings, resolveRate, AMOUNT_BASE_SQL, withDisplay };
