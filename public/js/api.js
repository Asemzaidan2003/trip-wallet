// Shared helpers: API calls, escaping, money and date formatting, cached settings/categories/rates.
import { t, locale, catName, errorText } from './i18n.js';
import { ICONS, catColor } from './ui.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) location.replace('/login.html');
  if (!res.ok) throw new Error(errorText(await res.json().catch(() => ({})), res.statusText));
  return res.status === 204 ? null : res.json();
}

// localStorage can be missing or throw (private mode, blocked storage); the app works without it.
export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not persisted */ } },
};

// Date strings are YYYY-MM-DD; maths is done in UTC so DST and time zones never shift a day.
const ymdToUtc = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const addDays = (ymd, n) => new Date(ymdToUtc(ymd) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((ymdToUtc(b) - ymdToUtc(a)) / 86400000);
export const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
export const shortDate = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
export const longDate = (ymd) => new Date(`${ymd}T00:00:00`).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
export const monthName = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(locale, { month: 'long', year: 'numeric' });

// Exact sums/differences of decimal strings that share one scale (e.g. base-currency totals).
const toUnits = (s, scale) => {
  const [i, f = ''] = String(s).replace('-', '').split('.');
  const v = BigInt(i + f.padEnd(scale, '0').slice(0, scale));
  return String(s).startsWith('-') ? -v : v;
};
const fromUnits = (n, scale) => {
  let s = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  if (scale) s = `${s.slice(0, -scale)}.${s.slice(-scale)}`;
  return (n < 0n ? '-' : '') + s;
};
export const subMoney = (a, b) => { const sc = (a.split('.')[1] || '').length; return fromUnits(toUnits(a, sc) - toUnits(b, sc), sc); };
export const sumMoney = (values, scale) => fromUnits(values.reduce((acc, v) => acc + toUnits(v, scale), 0n), scale);

export const minorOf = (code) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;

// Amounts arrive as exact decimal strings; Number() is only for display. Digits stay Western in both languages.
// The result is wrapped in Unicode isolates (LRI … PDI) so "64.81 SAR" never flips inside Arabic sentences.
export function fmt(amount, currency) {
  if (amount === null || amount === undefined) return '—';
  const minor = minorOf(currency);
  return `⁦${Number(amount).toLocaleString('en', { minimumFractionDigits: minor, maximumFractionDigits: minor })} ${currency}⁩`;
}
const compactFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const compact = (amount) => compactFormat.format(Number(amount));

// "1,234.50 SAR" plus a muted "≈ 329.20 USD" line when a display value exists.
export function money2(value, display, s) {
  const second = display !== null && display !== undefined && s.displayCurrency !== s.baseCurrency
    ? `<small class="muted">≈ ${esc(fmt(display, s.displayCurrency))}</small>` : '';
  return `<bdi>${esc(fmt(value, s.baseCurrency))}</bdi>${second}`;
}

const names = new Intl.DisplayNames([locale], { type: 'currency' });
export const CURRENCIES = Intl.supportedValuesOf('currency').filter((c) => minorOf(c) <= 3);
export const currencyOptions = (selected) => CURRENCIES
  .map((c) => `<option value="${c}"${c === selected ? ' selected' : ''}>${c} — ${esc(names.of(c))}</option>`).join('');

export function showError(message) {
  $('#error').textContent = message || '';
}

// Runs an action, shows its error, and tells every view that data changed.
export async function run(fn) {
  showError('');
  try {
    await fn();
    changed();
  } catch (e) {
    showError(e.message);
  }
}
export const changed = () => document.dispatchEvent(new Event('data-changed'));

export const cache = { settings: null, categories: [], rates: [], session: { authEnabled: false } };
export async function loadCache() {
  [cache.settings, cache.categories, cache.rates, cache.session] = await Promise.all([
    api('GET', '/api/settings'), api('GET', '/api/categories'), api('GET', '/api/rates'), api('GET', '/api/session'),
  ]);
}

export function categoryOptions(selected, { any = false } = {}) {
  const opt = (id, label) => `<option value="${id}"${String(id) === String(selected ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
  const head = any ? opt('', t('anyCategory')) + opt('none', t('uncategorized')) : opt('', t('noCategory'));
  return head + cache.categories.map((c) => c.children.length
    ? `<optgroup label="${esc(catName(c.name))}">${opt(c.id, t('generalOf', { name: catName(c.name) }))}${
      c.children.map((k) => opt(k.id, catName(k.name))).join('')}</optgroup>`
    : opt(c.id, catName(c.name))).join('');
}

// Hash routing: "#view?key=value". Returns { view, params }.
export function route() {
  const [view, query = ''] = location.hash.slice(1).split('?');
  return { view: view || 'home', params: new URLSearchParams(query) };
}
export function go(view, params) {
  const q = new URLSearchParams([...params].filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
  location.hash = q ? `${view}?${q}` : view;
}

export function pager(page, pageSize, total) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return `<div class="pager">
    <button data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}><span class="flip">‹</span> ${t('prev')}</button>
    <span class="muted">${t('pageOf', { page, pages, total })}</span>
    <button data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>${t('next')} <span class="flip">›</span></button></div>`;
}

// Expenses | Deposits | To claim switch shown at the top of the three lists.
export const segment = (active) => `<nav class="segment" aria-label="${t('show')}">${['expenses', 'deposits', 'claims']
  .map((v) => `<a href="#${v}"${active === v ? ' aria-current="page"' : ''}>${t(`seg.${v}`)}</a>`).join('')}</nav>`;

export const categoryLabel = (e) => (e.parentCategoryName
  ? `${catName(e.parentCategoryName)} › ${catName(e.categoryName)}` : e.categoryName ? catName(e.categoryName) : '');

// One expense as a tappable row (opens the edit dialog via data-edit).
export function expenseRow(e, base) {
  const cat = categoryLabel(e);
  const baseLine = (e.currency !== base ? `<small>${esc(fmt(e.amountBase, base))}</small>` : '')
    + (Number(e.tax) > 0 ? `<small>${esc(t('inclTax', { amount: fmt(e.tax, e.currency) }))}</small>` : '');
  return `<button type="button" class="item" data-edit="${e.id}">
    <span class="dot" style="background:${catColor(cache.categories, e.categoryId)}" aria-hidden="true"></span>
    <span class="what">${esc(e.description)}${e.hasReceipt ? `<span class="clip" title="${t('hasReceipt')}">${ICONS.receipt}</span>` : ''}
      <small>${esc(shortDate(e.date))}${cat ? ` · ${esc(cat)}` : ''}</small></span>
    <span class="num"><bdi>${esc(fmt(e.amount, e.currency))}</bdi>${baseLine}</span></button>`;
}
