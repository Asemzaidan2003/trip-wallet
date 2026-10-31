import { cache, changed, esc, store, minorOf, sumMoney, fmt } from './api.js';
import { t } from './i18n.js';

// Opens a <dialog> form. `fill(form)` sets values; `submit(form)` saves and may throw to show an error.
// With `onAgain`, "Save & add another" saves, calls onAgain(form) and keeps the dialog open;
// otherwise (Save / Enter) the dialog closes after saving.
export function openDialog(dialog, fill, submit, { onAgain } = {}) {
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('.dialog-error');
  const status = dialog.querySelector('.dialog-status');
  const again = form.querySelector('button[value="again"]');
  form.reset();
  error.textContent = '';
  if (status) status.textContent = '';
  if (again) again.hidden = !onAgain;
  fill(form);
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const addAnother = onAgain && ev.submitter?.value === 'again';
    error.textContent = '';
    if (status) status.textContent = '';
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    try {
      await submit(form);
      changed();
      if (addAnother) {
        onAgain(form);
        if (status) status.textContent = t('savedNext');
        form.amount.focus();
      } else {
        dialog.close();
      }
    } catch (e) {
      error.textContent = e.message;
    } finally {
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  };
  form.querySelector('button[value="cancel"]').onclick = () => dialog.close();
  dialog.showModal();
}

// Accepts "12,50" as well as "12.50" (phone keypads differ by region); the server validates the rest.
export const amountOf = (form) => form.amount.value.trim().replace(/[,٫]/, '.');
export const taxOf = (form) => form.tax.value.trim().replace(/[,٫]/, '.');

// Exact total = subtotal + tax, or null when either isn't a valid amount for the currency (the server then explains why).
export function totalOf(form) {
  const minor = minorOf(form.currency.value);
  const valid = minor ? new RegExp(`^\\d{1,11}(\\.\\d{1,${minor}})?$`) : /^\d{1,11}$/;
  const sub = amountOf(form);
  const tax = taxOf(form);
  if (!valid.test(sub) || (tax && !valid.test(tax))) return null;
  return sumMoney([sub, tax || '0'], minor);
}

// Shows "Total: subtotal + tax" live while typing.
export function wireTotal(form) {
  const update = () => {
    const total = totalOf(form);
    form.total.value = total ? fmt(total, form.currency.value) : '—';
  };
  for (const name of ['amount', 'tax']) form[name].oninput = update;
  // The same <form> is reused for every expense, so replace the previous listener instead of stacking another.
  if (form.totalHandler) form.currency.removeEventListener('change', form.totalHandler);
  form.totalHandler = update;
  form.currency.addEventListener('change', update);
  update();
}

// Stored rates come back as "3.7500000000"; show them without trailing zeros.
const plainRate = (r) => r.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

// Keeps the rate field in step with the chosen currency (hidden for the wallet currency).
export function wireCurrency(form, existing) {
  const field = form.querySelector('.rate-field');
  const hint = form.querySelector('.rate-hint');
  const update = () => {
    const base = cache.settings.baseCurrency;
    const cur = form.currency.value;
    field.classList.toggle('hidden', cur === base);
    const stored = cache.rates.find((r) => r.currency === cur);
    form.rate.value = existing && existing.currency === cur ? plainRate(existing.rate) : stored ? plainRate(stored.rate) : '';
    hint.innerHTML = `<span class="muted">${esc(t('ratePer', { base, cur }))}${stored ? '' : ` — ${esc(t('noStoredRate'))}`}</span>`;
  };
  form.currency.onchange = update;
  update();
}

// The rate is only sent for foreign currencies; empty means "use the stored rate".
export function rateFor(form) {
  return form.currency.value === cache.settings.baseCurrency || form.rate.value === ''
    ? undefined : form.rate.value.trim().replace(/[,٫]/, '.');
}

export const rememberCurrency = (code) => store.set('lastCurrency', code);
export const lastCurrency = () => store.get('lastCurrency');

// Shrinks a photo before upload: longest side 1600 px, JPEG quality 0.8 (a phone photo becomes ~200-400 KB).
export async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('photoFailed')))), 'image/jpeg', 0.8));
}

// Receipt photo controls inside the expense dialog. Returns a function that applies the change after saving.
export function wireReceipt(form, expense) {
  const box = form.querySelector('.receipt-box');
  const input = form.querySelector('input[name="receipt"]');
  const thumb = box.querySelector('img');
  const view = box.querySelector('.receipt-view');
  const remove = box.querySelector('[data-remove-receipt]');
  let blob = null;
  let removed = false;
  const show = (src) => {
    thumb.hidden = !src;
    remove.hidden = !src;
    view.hidden = !src || !expense?.hasReceipt || Boolean(blob);
    if (src) thumb.src = src; else thumb.removeAttribute('src');
  };
  show(expense?.hasReceipt ? `/api/expenses/${expense.id}/receipt?v=${Date.now()}` : null);
  view.href = expense ? `/api/expenses/${expense.id}/receipt` : '#';
  input.value = '';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      blob = await shrinkImage(file);
      removed = false;
      show(URL.createObjectURL(blob));
    } catch {
      form.querySelector('.dialog-error').textContent = t('photoFailed');
    }
  };
  remove.onclick = () => { blob = null; removed = true; input.value = ''; show(null); };
  return {
    reset() { blob = null; removed = false; input.value = ''; show(null); },
    async apply(id) {
      if (blob) {
        const res = await fetch(`/api/expenses/${id}/receipt`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        if (!res.ok) throw new Error(t('photoFailed'));
      } else if (removed && expense?.hasReceipt) {
        await fetch(`/api/expenses/${id}/receipt`, { method: 'DELETE' });
      }
    },
  };
}
