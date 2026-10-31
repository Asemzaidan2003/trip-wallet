// Input parsing for every API boundary. Each parser returns a clean value or throws HttpError(400).
// Every 4xx carries a stable `code` so the UI can show the message in the user's language.

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_INT4 = 2147483647;
const DATE_RE = /^(19|20)\d{2}-\d{2}-\d{2}$/;
const RATE_RE = /^\d{1,10}(\.\d{1,10})?$/;
const MAX_MINOR = 3; // DB allows scale <= 3; currencies with more (CLF, UYW) are not offered.

const minorOf = (code) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;

// Intl accepts any 3-letter code, so validate against the supported list.
const CURRENCIES = new Set(Intl.supportedValuesOf('currency').filter((c) => minorOf(c) <= MAX_MINOR));

const invalid = (field, message) => new HttpError(400, message, `invalid_${field}`);

function parseId(value, field = 'id') {
  const s = String(value);
  if (!/^[1-9]\d{0,9}$/.test(s) || Number(s) > MAX_INT4) throw invalid(field, `${field} must be a positive integer`);
  return Number(s);
}

function parseDate(value, field = 'date') {
  const d = new Date(`${value}T00:00:00Z`);
  // The round trip rejects impossible days such as 2026-02-30.
  if (typeof value !== 'string' || !DATE_RE.test(value) || isNaN(d) || d.toISOString().slice(0, 10) !== value) {
    throw invalid(field, `${field} must be a valid date (YYYY-MM-DD)`);
  }
  return value;
}

function parseCurrency(value, field = 'currency') {
  if (typeof value !== 'string' || !CURRENCIES.has(value)) throw invalid(field, `${field} must be a supported ISO 4217 code`);
  return value;
}

// Returns the amount padded to the currency's minor units ("1500" SAR -> "1500.00", "1.25" KWD -> "1.250").
// `zero: true` also accepts 0 (used for tax).
function parseMoney(value, currency, { zero = false, field = 'amount' } = {}) {
  const minor = minorOf(currency);
  const s = typeof value === 'number' ? String(value) : value;
  const re = minor ? new RegExp(`^(\\d{1,11})(?:\\.(\\d{1,${minor}}))?$`) : /^(\d{1,11})$/;
  const m = typeof s === 'string' && s.match(re);
  if (!m || Number(s) < 0 || (Number(s) === 0 && !zero) || Number(s) >= 1e11) {
    throw invalid(field, `${field} must be a ${zero ? 'non-negative' : 'positive'} number with at most ${minor} decimals for ${currency}`);
  }
  return minor ? `${m[1]}.${(m[2] || '').padEnd(minor, '0')}` : m[1];
}

function parseRate(value, field = 'rate') {
  const s = typeof value === 'number' ? String(value) : value;
  if (typeof s !== 'string' || !RATE_RE.test(s) || Number(s) <= 0) {
    throw invalid(field, `${field} must be a positive number with at most 10 decimals`);
  }
  return s;
}

function parseText(value, field, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < 1 || s.length > max) throw invalid(field, `${field} must be 1-${max} characters`);
  return s;
}

function parseEnum(value, field, allowed) {
  if (!allowed.includes(value)) throw invalid(field, `${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function parsePaging(query) {
  const page = query.page ?? '1';
  const pageSize = query.pageSize ?? '25';
  if (!/^[1-9]\d{0,5}$/.test(page)) throw invalid('page', 'page must be an integer from 1 to 999999');
  if (!/^\d{1,3}$/.test(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 100) {
    throw invalid('pageSize', 'pageSize must be an integer from 1 to 100');
  }
  return { page: Number(page), pageSize: Number(pageSize) };
}

function bodyOf(req) {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) {
    throw invalid('body', 'Request body must be a JSON object');
  }
  return body;
}

module.exports = {
  HttpError, CURRENCIES, minorOf, parseId, parseDate, parseCurrency, parseMoney, parseRate, parseText, parseEnum,
  parsePaging, bodyOf,
};
