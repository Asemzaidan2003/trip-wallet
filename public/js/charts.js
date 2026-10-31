import { esc, fmt } from './api.js';
import { t } from './i18n.js';

// Pure-CSS charts. Sizes use Number() for display only; every value is also shown as text or in an aria-label.

// Ranked horizontal bars: label (HTML from `label(row)`), bar, value. `color(row)` optionally colours each bar.
export function barList(rows, label, currency, color) {
  if (!rows.length) return `<p class="empty">${t('nothingInPeriod')}</p>`;
  const max = Math.max(...rows.map((r) => Number(r.total)), 0) || 1;
  return `<div class="bars">${rows.map((r) => `<div class="bar-row">
      ${label(r)}
      <div class="bar-track" aria-hidden="true"><div class="bar" style="width:${(Number(r.total) / max) * 100}%${
        color ? `;background:${color(r)}` : ''}"></div></div>
      <span class="num"><bdi>${esc(fmt(r.total, currency))}</bdi></span>
    </div>`).join('')}</div>`;
}

// Vertical columns. Each item: { total, aria, value?, data?, today?, busiest? }.
// Items with `data` (an attribute string) are buttons; empty days are plain, non-focusable spans.
export function columns(items, { labeled = false } = {}) {
  const max = Math.max(...items.map((i) => Number(i.total)), 0) || 1;
  const cls = `cols${labeled ? ' labeled' : ''}${items.length > 31 ? ' dense' : ''}`;
  return `<div class="${cls}" style="--n:${items.length}">${items.map((i) => {
    const p = Number(i.total) / max;
    const c = `col${i.today ? ' today' : ''}${i.busiest ? ' busiest' : ''}${p === 0 ? ' zero' : ''}`;
    const inner = `${labeled ? `<span class="v" aria-hidden="true">${esc(i.value ?? '')}</span>` : ''}<i style="--p:${p}" aria-hidden="true"></i>`;
    return i.data
      ? `<button type="button" class="${c}" ${i.data} aria-label="${esc(i.aria)}" title="${esc(i.aria)}">${inner}</button>`
      : `<span class="${c}" role="img" aria-label="${esc(i.aria)}">${inner}</span>`;
  }).join('')}</div>`;
}

// One stacked bar for "me vs company".
export function split(mine, company, currency) {
  const m = Number(mine);
  const c = Number(company);
  const total = m + c || 1;
  const me = `${t('me')} ${fmt(mine, currency)}`;
  const co = `${t('company')} ${fmt(company, currency)}`;
  return `<div class="split" role="img" aria-label="${esc(me)}, ${esc(co)}">
      <div class="me" style="width:${(m / total) * 100}%"></div><div class="company" style="width:${(c / total) * 100}%"></div>
    </div>
    <div class="legend">
      <span><i style="background:var(--bar)"></i><bdi>${esc(me)}</bdi></span>
      <span><i style="background:var(--bar-2)"></i><bdi>${esc(co)}</bdi></span>
    </div>`;
}
