import { lang, setLang, translateStatic, t } from './i18n.js';
import { $, api, esc, fmt, loadCache, route, showError, currencyOptions } from './api.js';
import { initTheme } from './theme.js';
import { skeleton } from './ui.js';
import * as home from './home.js';
import * as expenses from './expenses.js';
import * as deposits from './deposits.js';
import * as claims from './claims.js';
import * as reports from './reports.js';
import * as settings from './settings.js';

const views = { home, expenses, deposits, claims, reports, settings };
let shown = null;

async function render() {
  let { view, params } = route();
  // The old dashboard now lives on Reports; replace() keeps Back from bouncing.
  if (view === 'dashboard') return location.replace(`#reports${params.size ? `?${params}` : ''}`);
  if (!views[view]) view = 'home';
  const el = $(`#view-${view}`);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v !== el);
  const tab = ['deposits', 'claims'].includes(view) ? 'expenses' : view;
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.view === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // Placeholders only when switching views, so refreshes after a save don't flicker.
  if (shown !== view) el.innerHTML = skeleton();
  shown = view;
  try {
    await views[view].render(el, params);
  } catch (e) {
    showError(e.message);
  }
}

// The net wallet total, always visible: received - spent + reimbursed, plus what the company still owes.
async function renderWallet() {
  const s = await api('GET', '/api/summary');
  const money = (v) => `<bdi>${esc(fmt(v, s.baseCurrency))}</bdi>`;
  const second = s.walletDisplay !== null && s.displayCurrency !== s.baseCurrency
    ? `<small>≈ <bdi>${esc(fmt(s.walletDisplay, s.displayCurrency))}</bdi></small>` : '';
  $('#wallet-bar').innerHTML = `
    <div class="wallet-main${Number(s.wallet) < 0 ? ' neg' : ''}"><span>${t('netWallet')}</span><strong>${money(s.wallet)}</strong>${second}</div>
    <div class="wallet-side"><span>${t('companyOwes')}</span><strong>${money(s.owedByCompany)}</strong></div>
    <p class="wallet-formula">${t('walletFormula', {
    received: fmt(s.received, s.baseCurrency), spent: fmt(s.spentTotal, s.baseCurrency), reimbursed: fmt(s.reimbursedTotal, s.baseCurrency),
  })}</p>`;
}

async function refreshAll() {
  try {
    await loadCache();
    await Promise.all([renderWallet(), render()]);
  } catch (e) {
    showError(e.message);
  }
}

translateStatic();
initTheme($('#theme-toggle'));
const langButton = $('#lang-toggle');
langButton.onclick = () => setLang(lang === 'ar' ? 'en' : 'ar');
for (const select of document.querySelectorAll('.currency-select')) select.innerHTML = currencyOptions();

// Every "+" (bottom bar, top bar, empty states) opens the add-expense dialog from any view.
document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-add-expense]')) expenses.openExpense();
});
// Desktop shortcut: "n" for a new expense, unless typing or a dialog is open.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'n' || ev.ctrlKey || ev.metaKey || ev.altKey || document.querySelector('dialog[open]')) return;
  if (ev.target.closest('input, select, textarea, [contenteditable]')) return;
  ev.preventDefault();
  expenses.openExpense();
});
document.addEventListener('data-changed', refreshAll);
window.addEventListener('hashchange', () => {
  showError('');
  render();
});
refreshAll();
