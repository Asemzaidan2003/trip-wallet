import { $, api, cache, esc, fmt, go, pager, today, segment, changed } from './api.js';
import { t } from './i18n.js';
import { openDialog, wireCurrency, rateFor, amountOf } from './dialogs.js';
import { deleteWithUndo, isPendingDelete, toast, emptyState } from './ui.js';

// `last` prefills a new deposit with the previous amount and currency (the per diem rarely changes).
function openDeposit(d, last) {
  openDialog($('#deposit-dialog'), (form) => {
    form.querySelector('h2').textContent = t(d ? 'editDeposit' : 'addDeposit');
    form.date.value = d?.date ?? today();
    form.amount.value = d?.amount ?? last?.amount ?? '';
    form.currency.value = d?.currency ?? last?.currency ?? cache.settings.baseCurrency;
    wireCurrency(form, d);
  }, async (form) => {
    const body = { date: form.date.value, amount: amountOf(form), currency: form.currency.value, rate: rateFor(form) };
    await (d ? api('PUT', `/api/deposits/${d.id}`, body) : api('POST', '/api/deposits', body));
    toast(t('saved'));
  });
}

export async function render(el, params) {
  const base = cache.settings.baseCurrency;
  const data = await api('GET', `/api/deposits?${params}`);
  const items = data.items.filter((d) => !isPendingDelete(`/api/deposits/${d.id}`));
  const byId = new Map(items.map((d) => [String(d.id), d]));
  const last = data.page === 1 ? items[0] : undefined;

  el.innerHTML = `${segment('deposits')}<section>
    <div class="toolbar"><h2>${t('perDiemDeposits')}</h2><button class="primary" data-add>+ ${t('addDeposit')}</button></div>
    ${items.length ? `<div class="table-wrap"><table class="stack">
      <thead><tr><th>${t('date')}</th><th class="num">${t('amount')}</th><th class="num">${esc(t('inCurrency', { cur: base }))}</th><th></th></tr></thead>
      <tbody>${items.map((d) => `<tr data-row="${d.id}">
        <td>${esc(d.date)}</td>
        <td class="num"><bdi>${esc(fmt(d.amount, d.currency))}</bdi></td>
        <td class="num">${d.currency === base ? '' : esc(fmt(d.amountBase, base))}</td>
        <td class="actions"><button class="link" data-edit="${d.id}">${t('edit')}</button>
          <button class="link danger" data-delete="${d.id}">${t('delete')}</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${pager(data.page, data.pageSize, data.total)}` : emptyState(t('noDepositsYet'))}
  </section>`;

  el.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.add !== undefined) openDeposit(undefined, last);
    if (d.edit) openDeposit(byId.get(d.edit));
    if (d.delete) {
      const row = el.querySelector(`[data-row="${d.delete}"]`);
      deleteWithUndo(`/api/deposits/${d.delete}`, {
        label: fmt(byId.get(d.delete).amount, byId.get(d.delete).currency),
        hide: () => { row.hidden = true; },
        onDone: changed,
      });
    }
    if (d.page) {
      params.set('page', d.page);
      go('deposits', params);
    }
  };
}
