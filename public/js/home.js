import { api, cache, esc, fmt, go, today, addDays, daysBetween, monthEnd, store, money2, expenseRow, longDate } from './api.js';
import { t, catName } from './i18n.js';
import { barList } from './charts.js';
import { openExpense } from './expenses.js';
import { catColor, emptyState } from './ui.js';

// Home answers "how much?" for a chosen period, "what is the most?", and "how much can I still spend?".
const PERIODS = ['today', '7d', 'month', 'trip'];

// Local-date ranges. `to` is always sent so "today" is the device's date, not the server's.
function rangeOf(period, t0) {
  if (period === 'today') return { from: t0, to: t0 };
  if (period === '7d') return { from: addDays(t0, -6), to: t0 };
  if (period === 'month') return { from: `${t0.slice(0, 7)}-01`, to: t0 };
  return { to: t0 };
}
const query = (range, extra) => new URLSearchParams({ ...range, ...extra }).toString();

// Per diem budget for this month. The inputs are exact SQL totals; the per-day split is a display estimate.
function budgetCard(month, summary, s, t0) {
  const received = Number(month.totals.deposits);
  const spent = Number(month.totals.spent);
  const wallet = Number(summary.wallet);
  const daysLeft = daysBetween(t0, monthEnd(t0.slice(0, 7))) + 1;
  const safe = Math.max(wallet, 0) / daysLeft;
  const pace = Number(month.dailyAverage ?? 0);
  const over = wallet <= 0 || pace > safe;
  const pct = received ? Math.min(100, (spent / received) * 100) : 0;
  const money = (n) => fmt(n.toFixed(6), s.baseCurrency);
  return `<section class="budget ${over ? 'is-over' : 'is-ok'}">
    <div class="toolbar"><h2>${t('budgetTitle')}</h2><span class="badge">${t(over ? 'overPace' : 'onTrack')}</span></div>
    <p class="label">${t('safePerDay')}</p>
    <p class="big">≈ ${esc(money(safe))}</p>
    <small>${esc(t('daysLeft', { n: daysLeft }))} · ${esc(t('yourPace', { amount: money(pace) }))}</small>
    <div class="progress" role="img" aria-label="${esc(t('spentOfReceived', { spent: fmt(month.totals.spent, s.baseCurrency), received: fmt(month.totals.deposits, s.baseCurrency) }))}">
      <div style="width:${pct}%"></div></div>
    <div class="cards">
      <div class="card"><span>${t('receivedThisMonth')}</span><strong>${money2(month.totals.deposits, month.totals.depositsDisplay, s)}</strong></div>
      <div class="card"><span>${t('inWallet')}</span><strong>${money2(summary.wallet, summary.walletDisplay, summary)}</strong></div>
      <div class="card"><span>${t('companyOwes')}</span><strong>${money2(summary.owedByCompany, summary.owedByCompanyDisplay, summary)}</strong></div>
    </div>
    ${received ? '' : `<p class="muted">${t('noDepositThisMonth')} <a href="#deposits">${t('addDeposit')}</a></p>`}
  </section>`;
}

export async function render(el) {
  const s = cache.settings;
  const t0 = today();
  let period = store.get('homePeriod');
  if (!PERIODS.includes(period)) period = 'today';
  const range = rangeOf(period, t0);

  const [r, week, month, recent, summary] = await Promise.all([
    api('GET', `/api/reports?${query(range, { top: 5 })}`),
    api('GET', `/api/reports?${query(rangeOf('7d', t0), { top: 1 })}`),
    api('GET', `/api/reports?${query(rangeOf('month', t0), { top: 1 })}`),
    api('GET', '/api/expenses?pageSize=5'),
    api('GET', '/api/summary'),
  ]);
  const rows = new Map([...r.topExpenses, ...recent.items].map((e) => [String(e.id), e]));
  const count = r.totals.count;
  const list = (items, empty) => (items.length
    ? `<div class="list">${items.map((e) => expenseRow(e, s.baseCurrency)).join('')}</div>` : `<p class="empty">${empty}</p>`);

  el.innerHTML = `<p class="greeting muted">${esc(longDate(t0))}</p>
  ${recent.total === 0 ? emptyState(t('welcome'), `<button class="primary" data-add-expense>${t('addFirstExpense')}</button>`) : ''}
  <div class="home-grid">
    <div class="stack">
      <section>
        <div class="chips" role="group" aria-label="${t('period')}">${PERIODS.map((key) =>
          `<button type="button" data-period="${key}" aria-pressed="${key === period}">${t(`chip.${key}`)}</button>`).join('')}</div>
        <p class="label">${t(`spentLabel.${period}`)}</p>
        <p class="big"><bdi>${esc(fmt(r.totals.spent, s.baseCurrency))}</bdi></p>
        <small>${r.totals.spentDisplay !== null && s.displayCurrency !== s.baseCurrency
          ? `≈ ${esc(fmt(r.totals.spentDisplay, s.displayCurrency))} · ` : ''}${esc(t('expenseCount', { n: count }))}</small>
        <div class="tiles">
          <div class="tile"><span>${t('last7')}</span><b>${esc(fmt(week.totals.spent, s.baseCurrency))}</b></div>
          <div class="tile"><span>${t('thisMonth')}</span><b>${esc(fmt(month.totals.spent, s.baseCurrency))}</b></div>
          <div class="tile"><span>${t('dailyAverage')}</span><b>${esc(fmt(r.dailyAverage, s.baseCurrency))}</b></div>
        </div>
      </section>
      ${budgetCard(month, summary, s, t0)}
    </div>
    <div class="stack">
      <section>
        <h2>${t('mostSpentOn')}</h2>
        ${barList(r.byCategory.slice(0, 5), (c) => `<button type="button" class="link" data-cat="${c.id ?? 'none'}">${esc(catName(c.id ? c.name : null))}</button>`,
          s.baseCurrency, (c) => catColor(cache.categories, c.id))}
      </section>
      <section>
        <h2>${t('biggestExpenses')}</h2>
        ${list(r.topExpenses, t('nothingInPeriod'))}
      </section>
      <section>
        <div class="toolbar"><h2>${t('recent')}</h2><a href="#expenses">${t('seeAll')}</a></div>
        ${list(recent.items, t('noExpensesYet'))}
      </section>
    </div>
  </div>`;

  el.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.period) {
      store.set('homePeriod', b.dataset.period);
      render(el);
    } else if (b.dataset.cat) {
      go('expenses', new URLSearchParams({ ...range, categoryId: b.dataset.cat }));
    } else if (b.dataset.edit) {
      openExpense(rows.get(b.dataset.edit));
    }
  };
}
