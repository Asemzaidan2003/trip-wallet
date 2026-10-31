import { $, api, cache, esc, currencyOptions, run, showError, changed, shortDate } from './api.js';
import { t, lang, setLang, catName, errorText } from './i18n.js';
import { confirmBox, toast } from './ui.js';

const plainRate = (r) => r.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

function categoryItem(c, isTop) {
  return `<li><div class="item-row">
      <input value="${esc(catName(c.name))}" maxlength="50" aria-label="${t('categoryName')}" data-name="${c.id}">
      <button class="link" data-rename="${c.id}">${t('rename')}</button>
      <button class="link danger" data-delete-cat="${c.id}">${t('delete')}</button>
    </div>
    ${isTop ? `<ul>${c.children.map((k) => categoryItem(k, false)).join('')}
      <li><div class="item-row"><input placeholder="${t('newSubcategory')}" aria-label="${t('newSubcategory')}" maxlength="50" data-new-under="${c.id}">
        <button class="link" data-add-sub="${c.id}">${t('add')}</button></div></li></ul>` : ''}
  </li>`;
}

export async function render(el) {
  const s = cache.settings;
  const auth = cache.session.authEnabled;
  el.innerHTML = `<section>
    <h2>${t('appSection')}</h2>
    <div class="inline">
      <label>${t('language')}
        <select data-lang><option value="en"${lang === 'en' ? ' selected' : ''}>English</option>
          <option value="ar"${lang === 'ar' ? ' selected' : ''}>العربية</option></select></label>
    </div>
  </section>

  <section>
    <h2>${t('currencies')}</h2>
    <form class="inline" data-form="currencies">
      <label>${t('walletCurrency')}
        <select name="baseCurrency" ${s.baseLocked ? 'disabled' : ''}>${currencyOptions(s.baseCurrency)}</select></label>
      <label>${t('alsoShowIn')}
        <select name="displayCurrency">${currencyOptions(s.displayCurrency)}</select></label>
      <button class="primary">${t('save')}</button>
    </form>
    <p class="muted">${t(s.baseLocked ? 'baseLockedHint' : 'baseFreeHint')}</p>
  </section>

  <section>
    <h2>${t('exchangeRates')}</h2>
    <p class="muted">${esc(t('ratesHint', { base: s.baseCurrency, display: s.displayCurrency }))}</p>
    <div class="toolbar">
      <form class="inline" data-form="add-rate">
        <label>${t('currency')} <select name="code">${currencyOptions('USD')}</select></label>
        <label>${t('rate')} <input type="text" inputmode="decimal" name="rate" required></label>
        <button>${t('setRate')}</button>
      </form>
      <button data-refresh>${t('updateOnline')}</button>
    </div>
    <details class="filters"><summary>${esc(t('showRates', { n: cache.rates.length }))}</summary>
    <div class="table-wrap"><table class="stack">
      <thead><tr><th>${t('currency')}</th><th>${esc(t('rateIn', { cur: s.baseCurrency }))}</th><th>${t('source')}</th><th></th></tr></thead>
      <tbody>${cache.rates.map((r) => `<tr>
        <td>${esc(r.currency)}</td>
        <td><input type="text" inputmode="decimal" value="${esc(plainRate(r.rate))}" data-rate-input="${esc(r.currency)}" aria-label="${esc(t('rateFor', { cur: r.currency }))}"></td>
        <td class="muted">${t(r.source === 'manual' ? 'setByYou' : 'online')} · ${esc(shortDate(r.updatedAt.slice(0, 10)))}</td>
        <td class="actions"><button class="link" data-save-rate="${esc(r.currency)}">${t('save')}</button>
          <button class="link danger" data-clear-rate="${esc(r.currency)}">${t('remove')}</button></td>
      </tr>`).join('') || `<tr><td colspan="4" class="wide muted">${t('noRates')}</td></tr>`}</tbody>
    </table></div></details>
    <p class="muted"><a href="https://www.exchangerate-api.com" target="_blank" rel="noopener">Rates By Exchange Rate API</a>. ${t('manualKept')}</p>
  </section>

  <section class="tree">
    <h2>${t('categories')}</h2>
    <ul>${cache.categories.map((c) => categoryItem(c, true)).join('')}</ul>
    <form class="inline" data-form="add-category">
      <input name="name" placeholder="${t('newCategory')}" maxlength="50" required aria-label="${t('newCategory')}">
      <button>${t('addCategory')}</button>
    </form>
  </section>

  <section>
    <h2>${t('backup')}</h2>
    <p class="muted">${t('backupHint')}</p>
    <div class="inline">
      <a class="button" href="/api/backup" download>${t('downloadBackup')}</a>
      <label class="button">${t('restoreBackup')}<input type="file" accept="application/json,.json" data-restore class="visually-hidden"></label>
    </div>
  </section>

  <section>
    <h2>${t('phoneAccess')}</h2>
    <p class="muted">${t(auth ? 'phoneOn' : 'phoneOff')}</p>
    ${auth ? `<button type="button" data-logout>${t('logout')}</button>` : '<pre class="code">HOST=0.0.0.0 APP_PASSWORD=your-password npm start</pre>'}
  </section>`;

  $('[data-lang]', el).onchange = (ev) => setLang(ev.target.value);

  for (const form of el.querySelectorAll('form[data-form]')) {
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const action = {
        currencies: () => api('PUT', '/api/settings', { baseCurrency: s.baseLocked ? s.baseCurrency : f.baseCurrency, displayCurrency: f.displayCurrency }),
        'add-rate': () => api('PUT', `/api/rates/${f.code}`, { rate: f.rate.replace(',', '.') }),
        'add-category': () => api('POST', '/api/categories', { name: f.name }),
      }[form.dataset.form];
      run(async () => { await action(); toast(t('saved')); });
    };
  }

  $('[data-restore]', el).onchange = async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return showError(errorText({ code: 'invalid_backup' }));
    }
    if (!(await confirmBox(t('restoreConfirm'), t('replaceAll')))) return;
    run(async () => {
      const r = await api('POST', '/api/restore?confirm=replace', data);
      toast(t('restored', { n: r.expenses }));
    });
  };

  el.onclick = async (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.form) return;
    const d = b.dataset;
    if (d.refresh !== undefined) {
      b.disabled = true;
      showError('');
      try {
        const { updated } = await api('POST', '/api/rates/refresh');
        toast(t('ratesUpdated', { n: updated }));
        changed();
      } catch (e) {
        showError(e.message);
        b.disabled = false;
      }
    }
    if (d.logout !== undefined) {
      await fetch('/api/logout', { method: 'POST' });
      location.replace('/login.html');
    }
    if (d.saveRate) run(() => api('PUT', `/api/rates/${d.saveRate}`, { rate: $(`[data-rate-input="${d.saveRate}"]`, el).value.replace(',', '.') }));
    if (d.clearRate) run(() => api('DELETE', `/api/rates/${d.clearRate}`));
    if (d.rename) run(() => api('PATCH', `/api/categories/${d.rename}`, { name: $(`[data-name="${d.rename}"]`, el).value }));
    if (d.addSub) run(() => api('POST', '/api/categories', { name: $(`[data-new-under="${d.addSub}"]`, el).value, parentId: d.addSub }));
    if (d.deleteCat && (await confirmBox(t('deleteCategoryConfirm'), t('delete')))) run(() => api('DELETE', `/api/categories/${d.deleteCat}`));
  };
}
