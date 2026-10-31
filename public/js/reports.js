import {
  $, api, cache, esc, fmt, go, today, addDays, daysBetween, monthEnd, shortDate, monthName, subMoney, compact, money2, expenseRow,
} from './api.js';
import { t, locale, catName } from './i18n.js';
import { renderFilters, filterParams } from './filters.js';
import { barList, columns, split } from './charts.js';
import { openExpense } from './expenses.js';
import { catColor } from './ui.js';

const MAX_DAILY_COLUMNS = 62;
// 2026-10-04 is a Sunday, so adding 0..6 days gives Sun..Sat names in the current language.
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((i) =>
  new Date(`${addDays('2026-10-04', i)}T00:00:00`).toLocaleDateString(locale, { weekday: 'short' }));
const count = (n) => t('expenseCount', { n });

// Works out the period from the hash: a calendar month (default: this month), a custom range, or the whole trip.
function periodOf(params, t0) {
  const filters = filterParams(params);
  const rest = new URLSearchParams([...filters].filter(([k]) => k !== 'from' && k !== 'to'));
  const all = params.get('range') === 'all';
  let from = all ? null : filters.get('from');
  const to = all ? t0 : filters.get('to') || t0;
  if (!all && !filters.get('from') && !filters.get('to')) from = `${t0.slice(0, 7)}-01`;
  const month = from && from.endsWith('-01') ? from.slice(0, 7) : null;
  const monthMode = Boolean(month && (to === monthEnd(month) || (month === t0.slice(0, 7) && to === t0)));
  return { rest, all, from, to, month: monthMode ? month : null };
}

// Same length, just before this period (only the dates change; every other filter stays).
function previousOf({ from, to, month }) {
  if (month) {
    const pm = addDays(from, -1).slice(0, 7);
    const day = Math.min(Number(to.slice(8)), Number(monthEnd(pm).slice(8)));
    return { from: `${pm}-01`, to: `${pm}-${String(day).padStart(2, '0')}` };
  }
  if (!from) return null;
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

function withRange(rest, from, to, extra = {}) {
  const q = new URLSearchParams(rest);
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q;
}

function changeLine(r, p, prev, s) {
  if (!p) return '';
  const diff = subMoney(r.totals.spent, p.totals.spent);
  const before = Number(p.totals.spent);
  const range = `${shortDate(prev.from)}–${shortDate(prev.to)}`;
  if (Number(diff) === 0) return `<p class="muted">${esc(t('sameAs', { range }))}</p>`;
  const up = Number(diff) > 0;
  const pct = before ? ` (${up ? '+' : '−'}${Math.abs(Math.round((Number(diff) / before) * 100))}%)` : '';
  return `<p class="${up ? 'change-up' : 'change-down'}">${up ? '▲' : '▼'} <bdi>${esc(fmt(diff.replace('-', ''), s.baseCurrency))}${pct}</bdi>
    <span class="muted">${esc(t('versus', { range }))}</span></p>`;
}

function dailyChart(r, start, end, t0) {
  if (!start || daysBetween(start, end) + 1 > MAX_DAILY_COLUMNS) return '';
  const byDate = new Map(r.byDay.map((d) => [d.date, d]));
  const busiest = r.busiestDay?.date;
  const n = daysBetween(start, end) + 1;
  const base = cache.settings.baseCurrency;
  const items = Array.from({ length: n }, (_, i) => {
    const day = addDays(start, i);
    const d = byDate.get(day);
    return {
      total: d?.total ?? '0',
      aria: `${shortDate(day)}: ${fmt(d?.total ?? '0', base)}, ${count(d?.count ?? 0)}`,
      data: d ? `data-day="${day}"` : null,
      today: day === t0,
      busiest: day === busiest,
    };
  });
  const mid = addDays(start, Math.floor((n - 1) / 2));
  return `<section>
    <h2>${t('everyDay')}</h2>
    ${columns(items)}
    <div class="axis" aria-hidden="true"><span>${esc(shortDate(start))}</span>${n > 2 ? `<span>${esc(shortDate(mid))}</span>` : ''}<span>${esc(shortDate(end))}</span></div>
    ${r.busiestDay ? `<p class="callout">${t('busiestDay')}: <b>${esc(shortDate(r.busiestDay.date))}</b> · <bdi>${esc(fmt(r.busiestDay.total, base))}</bdi>
      (${esc(count(r.busiestDay.count))})</p>` : ''}
    <div class="legend"><span><i style="background:var(--accent)"></i>${t('today')}</span><span><i style="background:var(--bar-2)"></i>${t('busiestDay')}</span></div>
  </section>`;
}

export async function render(el, params) {
  const s = cache.settings;
  const t0 = today();
  const period = periodOf(params, t0);
  const { rest, all, from, to, month } = period;
  const prev = previousOf(period);
  const current = withRange(rest, from, to);
  const [r, p] = await Promise.all([
    api('GET', `/api/reports?${withRange(rest, from, to, { top: 10 })}`),
    prev ? api('GET', `/api/reports?${withRange(rest, prev.from, prev.to, { top: 1 })}`) : null,
  ]);
  const T = r.totals;
  const drilled = rest.get('categoryId') && rest.get('categoryId') !== 'none';
  const parentName = drilled && cache.categories.find((c) => String(c.id) === rest.get('categoryId'))?.name;
  const thisMonth = t0.slice(0, 7);
  const stepBase = month ?? thisMonth;
  const prevMonth = addDays(`${stepBase}-01`, -1).slice(0, 7);
  const nextMonth = addDays(monthEnd(stepBase), 1).slice(0, 7);
  const monthLink = (m) => withRange(rest, `${m}-01`, m === thisMonth ? t0 : monthEnd(m)).toString();
  const title = all ? t('wholeTrip') : month ? monthName(month) : `${shortDate(from ?? to)} – ${shortDate(to)}`;
  const rows = new Map(r.topExpenses.map((e) => [String(e.id), e]));
  const keep = all ? new URLSearchParams([...current, ['range', 'all']]) : current;
  const PAID = { cash: t('cash'), card: t('card'), other: t('other') };

  el.innerHTML = `<section>
    <div class="stepper">
      <button type="button" data-go="${esc(monthLink(prevMonth))}" aria-label="${t('prevMonth')}"><span class="flip">‹</span></button>
      <span class="period">${esc(title)}</span>
      <button type="button" data-go="${esc(monthLink(nextMonth))}" aria-label="${t('nextMonth')}" ${nextMonth > thisMonth ? 'disabled' : ''}><span class="flip">›</span></button>
    </div>
    <div class="chips" role="group" aria-label="${t('period')}">
      <button type="button" data-go="${esc(monthLink(thisMonth))}" aria-pressed="${month === thisMonth}">${t('thisMonth')}</button>
      <button type="button" data-go="${esc(new URLSearchParams([...rest, ['range', 'all']]))}" aria-pressed="${all}">${t('wholeTrip')}</button>
    </div>
    <div class="report-filters"></div>
    <div class="cards">
      <div class="card"><span>${t('spent')}</span><strong>${money2(T.spent, T.spentDisplay, s)}</strong></div>
      <div class="card"><span>${t('dailyAverage')}</span><strong><bdi>${esc(fmt(r.dailyAverage, s.baseCurrency))}</bdi></strong>
        <small>${r.days ? esc(t('overDays', { n: r.days })) : ''}</small></div>
      <div class="card"><span>${t('expenses')}</span><strong>${T.count}</strong></div>
      <div class="card"><span>${t('waitingReimbursement')}</span><strong>${money2(T.pending, T.pendingDisplay, s)}</strong></div>
      <div class="card"><span>${t('taxPaid')}</span><strong>${money2(T.tax, T.taxDisplay, s)}</strong></div>
    </div>
    ${changeLine(r, p, prev, s)}
    <p><a href="/api/expenses.csv?${esc(current)}" download>${t('exportThese')}</a></p>
  </section>
  ${dailyChart(r, from ?? r.byDay[0]?.date, to, t0)}
  <div class="grid-2">
    <section>
      <h2>${t('mostSpentOn')}${parentName ? `: ${esc(catName(parentName))}` : ''}</h2>
      ${drilled ? `<p><button type="button" class="link" data-back><span class="flip">‹</span> ${t('allCategories')}</button></p>` : ''}
      ${barList(r.byCategory, (c) => `<button type="button" class="link" data-cat="${c.id ?? 'none'}" data-children="${c.hasChildren}"
        title="${t(c.hasChildren && !drilled ? 'showSubcategories' : 'showExpenses')}">${esc(catName(c.id ? c.name : null))}</button>`,
        s.baseCurrency, (c) => catColor(cache.categories, c.id))}
    </section>
    <section>
      <h2>${t('biggestExpenses')}</h2>
      ${r.topExpenses.length ? `<div class="list">${r.topExpenses.map((e) => expenseRow(e, s.baseCurrency)).join('')}</div>`
        : `<p class="empty">${t('nothingInPeriod')}</p>`}
    </section>
    <section>
      <h2>${t('byWeekday')}</h2>
      ${columns(r.byWeekday.map((w) => ({
        total: w.total, value: Number(w.total) ? compact(w.total) : '',
        aria: `${WEEKDAYS[w.weekday]}: ${fmt(w.total, s.baseCurrency)}, ${count(w.count)}`,
      })), { labeled: true })}
      <div class="axis7" aria-hidden="true">${WEEKDAYS.map((d) => `<span>${esc(d)}</span>`).join('')}</div>
    </section>
    <section>
      <h2>${t('howYouPaid')}</h2>
      ${barList(r.byPaidWith, (x) => `<span>${esc(PAID[x.paidWith])}</span>`, s.baseCurrency)}
    </section>
    <section>
      <h2>${t('meVsCompany')}</h2>
      ${split(T.mine, T.company, s.baseCurrency)}
      <p class="callout muted">${esc(t('reimbursedSoFar', { amount: fmt(T.reimbursed, s.baseCurrency) }))}</p>
    </section>
    <section>
      <h2>${t('byMonth')}</h2>
      ${barList(r.byMonth, (m) => `<span>${esc(monthName(m.month))}</span>`, s.baseCurrency)}
    </section>
    <section>
      <h2>${t('byCurrency')}</h2>
      ${r.byCurrency.length ? `<div class="table-wrap"><table>
        <thead><tr><th>${t('currency')}</th><th class="num">${t('spent')}</th><th class="num">${esc(t('inCurrency', { cur: s.baseCurrency }))}</th><th class="num">${t('companyOwes')}</th></tr></thead>
        <tbody>${r.byCurrency.map((c) => `<tr><td>${esc(c.currency)}</td><td class="num">${esc(fmt(c.amount, c.currency))}</td>
          <td class="num">${esc(fmt(c.amountBase, s.baseCurrency))}</td><td class="num">${esc(fmt(c.pending, c.currency))}</td></tr>`).join('')}
        </tbody></table></div>` : `<p class="empty">${t('nothingInPeriod')}</p>`}
    </section>
  </div>`;

  renderFilters($('.report-filters', el), 'reports', current, { dates: false });

  el.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.closest('form')) return;
    const d = b.dataset;
    if (d.go !== undefined) go('reports', new URLSearchParams(d.go));
    else if (d.day) go('expenses', withRange(rest, d.day, d.day));
    else if (d.edit) openExpense(rows.get(d.edit));
    else if (d.back !== undefined) {
      keep.delete('categoryId');
      go('reports', keep);
    } else if (d.cat) {
      const q = new URLSearchParams(keep);
      q.set('categoryId', d.cat);
      if (d.children === 'true' && !drilled) go('reports', q);
      else {
        q.delete('range');
        go('expenses', q);
      }
    }
  };
}
