import { $, api, cache, esc, fmt, today, segment, categoryLabel, sumMoney, minorOf, changed, longDate } from './api.js';
import { t } from './i18n.js';
import { toast, ICONS, emptyState } from './ui.js';

// "To claim": company expenses not yet reimbursed. Select several, mark them reimbursed at once, or print a claim sheet.

// Totals per original currency plus the base total, all exact.
function totals(items, base) {
  const byCur = new Map();
  for (const e of items) byCur.set(e.currency, [...(byCur.get(e.currency) ?? []), e.amount]);
  // The per-currency breakdown only adds information when something wasn't paid in the base currency.
  const mixed = byCur.size > 1 || (byCur.size === 1 && !byCur.has(base));
  return {
    base: sumMoney(items.map((e) => e.amountBase), minorOf(base)),
    tax: sumMoney(items.map((e) => e.taxBase), minorOf(base)),
    perCurrency: mixed ? [...byCur].map(([cur, amounts]) => fmt(sumMoney(amounts, minorOf(cur)), cur)) : [],
  };
}

function printSheet(items, s) {
  const tot = totals(items, s.baseCurrency);
  const dates = items.map((e) => e.date).sort();
  $('#print-area').innerHTML = `<h1>${t('claimTitle')}</h1>
    <p>${esc(t('claimPeriod', { from: longDate(dates[0]), to: longDate(dates.at(-1)) }))} · ${esc(t('printedOn', { date: longDate(today()) }))}</p>
    <table><thead><tr><th>${t('date')}</th><th>${t('what')}</th><th>${t('category')}</th><th class="num">${t('total')}</th>
      <th class="num">${esc(t('taxIn', { cur: s.baseCurrency }))}</th><th class="num">${esc(t('inCurrency', { cur: s.baseCurrency }))}</th><th>${t('receipt')}</th></tr></thead>
    <tbody>${items.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.description)}</td><td>${esc(categoryLabel(e))}</td>
      <td class="num"><bdi>${esc(fmt(e.amount, e.currency))}</bdi></td><td class="num">${Number(e.taxBase) > 0 ? esc(fmt(e.taxBase, s.baseCurrency)) : ''}</td>
      <td class="num">${esc(fmt(e.amountBase, s.baseCurrency))}</td><td>${e.hasReceipt ? '✓' : ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="4">${t('total')}${tot.perCurrency.length ? ` (${esc(tot.perCurrency.join(' + '))})` : ''}</th>
      <th class="num">${esc(fmt(tot.tax, s.baseCurrency))}</th><th class="num">${esc(fmt(tot.base, s.baseCurrency))}</th><th></th></tr></tfoot></table>`;
  window.print();
}

export async function render(el) {
  const s = cache.settings;
  const { items, total } = await api('GET', '/api/expenses?status=pending&pageSize=100');
  const selected = new Set();

  const summary = () => {
    const chosen = items.filter((e) => selected.has(e.id));
    const tot = totals(chosen.length ? chosen : items, s.baseCurrency);
    $('.claim-summary', el).innerHTML = `<strong>${esc(fmt(tot.base, s.baseCurrency))}</strong>
      <small class="muted">${esc(tot.perCurrency.join(' + '))}</small>
      <span class="muted">${esc(chosen.length ? t('selectedCount', { n: chosen.length }) : t('allPending', { n: items.length }))}</span>`;
    $('[data-mark]', el).disabled = !chosen.length;
    $('[data-all]', el).checked = chosen.length === items.length;
  };

  el.innerHTML = `${segment('claims')}<section>
    <div class="toolbar"><h2>${t('toClaim')}</h2>${items.length ? `<button type="button" data-print>${t('printClaim')}</button>` : ''}</div>
    ${items.length ? `
      <p class="muted">${t('claimHint')}</p>
      <div class="claim-bar">
        <div class="claim-summary"></div>
        <label class="inline-label">${t('paidBackOn')} <input type="date" name="claimDate" value="${today()}"></label>
        <button class="primary" type="button" data-mark disabled>${ICONS.check}${t('markReimbursed')}</button>
      </div>
      <div class="list claim-list">
        <label class="item select-all"><input type="checkbox" data-all> <span>${t('selectAll')}</span></label>
        ${items.map((e) => `<label class="item">
          <input type="checkbox" data-id="${e.id}">
          <span class="what">${esc(e.description)}${e.hasReceipt ? `<a class="clip" href="/api/expenses/${e.id}/receipt" target="_blank" rel="noopener" aria-label="${t('viewReceipt')}">${ICONS.receipt}</a>` : ''}
            <small>${esc(longDate(e.date))}${categoryLabel(e) ? ` · ${esc(categoryLabel(e))}` : ''}</small></span>
          <span class="num"><bdi>${esc(fmt(e.amount, e.currency))}</bdi>${e.currency !== s.baseCurrency ? `<small>${esc(fmt(e.amountBase, s.baseCurrency))}</small>` : ''}${
            Number(e.tax) > 0 ? `<small>${esc(t('inclTax', { amount: fmt(e.tax, e.currency) }))}</small>` : ''}</span>
        </label>`).join('')}
      </div>
      ${total > items.length ? `<p class="muted">${esc(t('claimLimit', { n: items.length, total }))}</p>` : ''}`
    : emptyState(t('nothingToClaim'))}
  </section>`;
  if (!items.length) return;
  summary();

  el.onchange = (ev) => {
    const box = ev.target;
    if (box.dataset.all !== undefined) {
      for (const c of el.querySelectorAll('[data-id]')) c.checked = box.checked;
      items.forEach((e) => (box.checked ? selected.add(e.id) : selected.delete(e.id)));
    } else if (box.dataset.id) {
      box.checked ? selected.add(Number(box.dataset.id)) : selected.delete(Number(box.dataset.id));
    }
    summary();
  };
  el.onclick = async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.print !== undefined) printSheet(items.filter((e) => !selected.size || selected.has(e.id)), s);
    if (b.dataset.mark !== undefined) {
      b.disabled = true;
      try {
        const { updated } = await api('POST', '/api/reimbursements', { ids: [...selected], date: $('[name="claimDate"]', el).value });
        toast(t('markedCount', { n: updated }));
        changed();
      } catch (e) {
        toast(e.message, { duration: 6000 });
        b.disabled = false;
      }
    }
  };
}
