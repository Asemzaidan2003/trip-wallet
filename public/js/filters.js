import { $, esc, go, categoryOptions, currencyOptions } from './api.js';
import { t } from './i18n.js';

const KEYS = ['from', 'to', 'categoryId', 'chargedTo', 'status', 'paidWith', 'currency', 'q'];

const select = (name, label, options, value) => `<label>${label}<select name="${name}">${options
  .map(([v, text]) => `<option value="${v}"${v === (value ?? '') ? ' selected' : ''}>${text}</option>`).join('')}</select></label>`;

// Renders the shared filter form into `el`; applying it updates the hash (and resets to page 1).
// `dates: false` leaves from/to out of the "active" count (Reports always has a date range).
export function renderFilters(el, view, params, { dates = true } = {}) {
  const p = (k) => params.get(k) ?? '';
  const active = KEYS.filter((k) => p(k) && (dates || (k !== 'from' && k !== 'to'))).length;
  el.innerHTML = `<details class="filters"${active ? ' open' : ''}>
    <summary>${t('filters')}${active ? ` (${t('activeCount', { n: active })})` : ''}</summary>
    <form>
      <label>${t('from')} <input type="date" name="from" value="${esc(p('from'))}"></label>
      <label>${t('to')} <input type="date" name="to" value="${esc(p('to'))}"></label>
      <label>${t('category')} <select name="categoryId">${categoryOptions(p('categoryId'), { any: true })}</select></label>
      ${select('chargedTo', t('countedOn'), [['', t('anyone')], ['me', t('me')], ['company', t('company')]], p('chargedTo'))}
      ${select('status', t('reimbursement'), [['', t('any')], ['pending', t('pending')], ['reimbursed', t('reimbursed')]], p('status'))}
      ${select('paidWith', t('paidWith'), [['', t('any')], ['cash', t('cash')], ['card', t('card')], ['other', t('other')]], p('paidWith'))}
      <label>${t('currency')} <select name="currency"><option value="">${t('any')}</option>${currencyOptions(p('currency'))}</select></label>
      <label>${t('search')} <input type="search" name="q" maxlength="100" value="${esc(p('q'))}"></label>
      <div class="inline">
        <button class="primary">${t('apply')}</button>
        <button type="button" data-clear>${t('clear')}</button>
      </div>
    </form>
  </details>`;
  const form = $('form', el);
  form.onsubmit = (ev) => {
    ev.preventDefault();
    go(view, new URLSearchParams(new FormData(form)));
  };
  $('[data-clear]', el).onclick = () => go(view, new URLSearchParams());
}

// Filter params only (drops paging), for links between views and the CSV export.
export const filterParams = (params) => new URLSearchParams([...params].filter(([k]) => KEYS.includes(k)));
