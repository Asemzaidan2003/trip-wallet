import { $, api, cache, esc, fmt, go, pager, today, categoryOptions, categoryLabel, run, segment, subMoney } from './api.js';
import { t } from './i18n.js';
import { renderFilters, filterParams } from './filters.js';
import { openDialog, wireCurrency, wireReceipt, wireTotal, rateFor, rememberCurrency, lastCurrency, amountOf, taxOf, totalOf } from './dialogs.js';
import { deleteWithUndo, isPendingDelete, toast, ICONS, emptyState, catColor } from './ui.js';

// The total paid, with its base-currency value when foreign and a "incl. tax" note when there is tax.
function amountCell(e, base) {
  const original = `<bdi>${esc(fmt(e.amount, e.currency))}</bdi>`;
  const inBase = e.currency === base ? '' : `<span class="muted">${esc(fmt(e.amountBase, base))}</span>`;
  const tax = Number(e.tax) > 0 ? `<span class="muted">${esc(t('inclTax', { amount: fmt(e.tax, e.currency) }))}</span>` : '';
  return original + inBase + tax;
}

function statusCell(e) {
  if (e.chargedTo !== 'company') return '';
  return e.reimbursedOn
    ? `<span class="good">${esc(t('reimbursedOn', { date: e.reimbursedOn }))}</span> <button class="link" data-undo="${e.id}">${t('undo')}</button>`
    : `<span class="warn">${t('pending')}</span> <button class="link" data-reimburse="${e.id}">${t('depositToWallet')}</button>`;
}

let suggestions = [];
const loadSuggestions = () => api('GET', '/api/suggestions').then((s) => { suggestions = s; }).catch(() => {});

// Add (no argument), edit, or duplicate (`asNew`) an expense. Does nothing until settings have loaded.
export function openExpense(e, { asNew = false } = {}) {
  if (!cache.settings) return;
  const isNew = !e || asNew;
  const dialog = $('#expense-dialog');
  let receipt;
  openDialog(dialog, (form) => {
    form.querySelector('h2').textContent = t(asNew ? 'duplicateExpense' : isNew ? 'addExpense' : 'editExpense');
    // The form takes the subtotal and the tax; the stored `amount` is their sum (the total paid).
    form.amount.value = e ? subMoney(e.amount, e.tax) : '';
    form.tax.value = e && Number(e.tax) > 0 ? e.tax : '';
    form.description.value = e?.description ?? '';
    form.date.value = asNew ? today() : e?.date ?? today();
    form.currency.value = e?.currency ?? lastCurrency() ?? cache.settings.baseCurrency;
    if (!form.currency.value) form.currency.value = cache.settings.baseCurrency;
    form.categoryId.innerHTML = categoryOptions(e?.categoryId);
    form.paidWith.value = e?.paidWith ?? 'cash';
    form.chargedTo.value = e?.chargedTo ?? 'me';
    wireCurrency(form, isNew ? undefined : e);
    wireTotal(form);
    receipt = wireReceipt(form, isNew ? undefined : e);
    form.querySelector('[data-duplicate]').hidden = isNew;
    form.querySelector('[data-duplicate]').onclick = () => { dialog.close(); openExpense(e, { asNew: true }); };

    // Typing a known description pre-fills its last choices, but never overrides what the user already changed.
    $('#desc-suggestions').innerHTML = suggestions.map((s) => `<option value="${esc(s.description)}">`).join('');
    const touched = new Set();
    for (const name of ['categoryId', 'paidWith', 'chargedTo', 'currency']) form[name].addEventListener('change', () => touched.add(name), { once: true });
    form.description.oninput = () => {
      if (!isNew) return;
      const s = suggestions.find((x) => x.description.toLowerCase() === form.description.value.trim().toLowerCase());
      if (!s) return;
      if (!touched.has('categoryId') && s.categoryId) form.categoryId.value = String(s.categoryId);
      if (!touched.has('paidWith')) form.paidWith.value = s.paidWith;
      if (!touched.has('chargedTo')) form.chargedTo.value = s.chargedTo;
      if (!touched.has('currency') && s.currency !== form.currency.value) {
        form.currency.value = s.currency;
        form.currency.dispatchEvent(new Event('change'));
      }
    };
  }, async (form) => {
    // If either number isn't valid, send what was typed so the server's message explains what to fix.
    const body = {
      description: form.description.value, date: form.date.value, amount: totalOf(form) ?? amountOf(form), tax: taxOf(form) || '0',
      currency: form.currency.value, rate: rateFor(form), paidWith: form.paidWith.value,
      chargedTo: form.chargedTo.value, categoryId: form.categoryId.value || null,
    };
    const saved = await (isNew ? api('POST', '/api/expenses', body) : api('PUT', `/api/expenses/${e.id}`, body));
    await receipt.apply(saved.id);
    rememberCurrency(body.currency);
    toast(t('saved'));
    loadSuggestions();
  }, {
    // Keep date, currency, category and payment choices; clear what changes per receipt.
    onAgain: isNew ? (form) => {
      form.amount.value = ''; form.tax.value = ''; form.description.value = '';
      form.amount.dispatchEvent(new Event('input')); // refresh the total readout
      receipt.reset();
    } : undefined,
  });
}
loadSuggestions();

function openReimburse(e) {
  openDialog($('#reimburse-dialog'), (form) => {
    $('.reimburse-what', form).textContent = `${e.description}: ${fmt(e.amount, e.currency)}`;
    form.date.value = today();
  }, (form) => api('POST', `/api/expenses/${e.id}/reimbursement`, { date: form.date.value }));
}

const PAID = () => ({ cash: t('cash'), card: t('card'), other: t('other'), me: t('me'), company: t('company') });

export async function render(el, params) {
  const s = cache.settings;
  const data = await api('GET', `/api/expenses?${params}`);
  const items = data.items.filter((e) => !isPendingDelete(`/api/expenses/${e.id}`));
  const byId = new Map(items.map((e) => [String(e.id), e]));
  const L = PAID();
  const filtered = [...filterParams(params)].length > 0;

  el.innerHTML = `${segment('expenses')}<section>
    <div class="toolbar">
      <h2>${t('expenses')}</h2>
      <a href="/api/expenses.csv?${esc(filterParams(params))}" download>${t('exportCsv')}</a>
    </div>
    <div class="list-filters"></div>
    ${items.length ? `<div class="table-wrap"><table class="stack">
      <thead><tr><th>${t('date')}</th><th>${t('what')}</th><th>${t('paidOn')}</th><th class="num">${t('total')}</th><th>${t('status')}</th><th></th></tr></thead>
      <tbody>${items.map((e) => `<tr data-row="${e.id}">
        <td>${esc(e.date)}</td>
        <td class="wide"><span class="dot" style="background:${catColor(cache.categories, e.categoryId)}" aria-hidden="true"></span>${esc(e.description)}${
          e.hasReceipt ? ` <a class="clip" href="/api/expenses/${e.id}/receipt" target="_blank" rel="noopener" title="${t('viewReceipt')}" aria-label="${t('viewReceipt')}">${ICONS.receipt}</a>` : ''}
          <span class="muted">${esc(categoryLabel(e))}</span></td>
        <td>${esc(L[e.paidWith])} · ${esc(L[e.chargedTo])}</td>
        <td class="num">${amountCell(e, s.baseCurrency)}</td>
        <td class="wide">${statusCell(e)}</td>
        <td class="actions"><button class="link" data-edit="${e.id}">${t('edit')}</button>
          <button class="link danger" data-delete="${e.id}">${t('delete')}</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${pager(data.page, data.pageSize, data.total)}`
    : emptyState(t(filtered ? 'noMatch' : 'noExpensesYet'), filtered ? '' : `<button class="primary" data-add-expense>${t('addExpense')}</button>`)}
  </section>`;

  renderFilters($('.list-filters', el), 'expenses', filterParams(params));

  el.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.edit) openExpense(byId.get(d.edit));
    if (d.reimburse) openReimburse(byId.get(d.reimburse));
    if (d.undo) run(() => api('DELETE', `/api/expenses/${d.undo}/reimbursement`));
    if (d.delete) {
      const row = el.querySelector(`[data-row="${d.delete}"]`);
      deleteWithUndo(`/api/expenses/${d.delete}`, {
        label: byId.get(d.delete).description,
        hide: () => { row.hidden = true; },
        onDone: () => document.dispatchEvent(new Event('data-changed')),
      });
    }
    if (d.page) {
      params.set('page', d.page);
      go('expenses', params);
    }
  };
}
