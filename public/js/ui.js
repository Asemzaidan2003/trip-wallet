import { t } from './i18n.js';

// Small shared UI pieces: toasts, styled confirm, delayed delete with Undo, skeletons, category colours, icons.

export const ICONS = {
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>',
  empty: '<svg viewBox="0 0 64 64" class="empty-art" aria-hidden="true"><rect x="12" y="10" width="40" height="46" rx="6"/><path d="M22 24h20M22 32h20M22 40h12"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
};

let toastBox;
// A short message at the bottom (above the phone tab bar), optionally with one action button.
export function toast(message, { action, onAction, duration = 4000 } = {}) {
  if (!toastBox) {
    toastBox = Object.assign(document.createElement('div'), { className: 'toasts' });
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.append(Object.assign(document.createElement('span'), { textContent: message }));
  const remove = () => el.remove();
  if (action) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: action });
    b.onclick = () => { onAction(); remove(); };
    el.append(b);
  }
  toastBox.append(el);
  setTimeout(remove, duration);
}

// Styled replacement for window.confirm. Resolves true when the user confirms.
export function confirmBox(message, okLabel = t('ok')) {
  const dlg = document.getElementById('confirm-dialog');
  dlg.querySelector('.confirm-text').textContent = message;
  dlg.querySelector('[value="ok"]').textContent = okLabel;
  const form = dlg.querySelector('form');
  dlg.showModal();
  // Resolve from the submit/cancel events themselves rather than 'close', which some browsers deliver late.
  return new Promise((resolve) => {
    const done = (value) => {
      form.onsubmit = null;
      dlg.oncancel = null;
      dlg.close();
      resolve(value);
    };
    form.onsubmit = (ev) => { ev.preventDefault(); done(ev.submitter?.value === 'ok'); };
    dlg.oncancel = (ev) => { ev.preventDefault(); done(false); };
  });
}

// Deletes after a 5 s grace period with Undo. Pending deletes are flushed if the page is closed.
const pending = new Map(); // url -> timer
export const isPendingDelete = (url) => pending.has(url);
export function deleteWithUndo(url, { hide, label, onDone }) {
  hide?.();
  const commit = async () => {
    pending.delete(url);
    try {
      await fetch(url, { method: 'DELETE' });
    } finally {
      onDone?.();
    }
  };
  pending.set(url, setTimeout(commit, 5000));
  toast(t('deleted', { label }), {
    action: t('undo'),
    duration: 5000,
    onAction: () => {
      clearTimeout(pending.get(url));
      pending.delete(url);
      onDone?.();
    },
  });
}
addEventListener('pagehide', () => {
  for (const [url, timer] of pending) {
    clearTimeout(timer);
    fetch(url, { method: 'DELETE', keepalive: true });
  }
});

export const skeleton = (rows = 4) => `<section class="skeleton" aria-busy="true" aria-label="${t('loading')}">
  ${'<div class="sk-line"></div>'.repeat(rows)}</section>`;

export const emptyState = (text, actionHtml = '') => `<div class="empty-state">${ICONS.empty}<p>${text}</p>${actionHtml}</div>`;

// Fixed palette by top-level category; colour is always paired with the category's name.
const PALETTE = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];
export function catColor(categories, categoryId) {
  if (!categoryId) return '#94A3B8';
  const top = categories.find((c) => c.id === Number(categoryId) || c.children.some((k) => k.id === Number(categoryId)));
  return top ? PALETTE[(top.id - 1) % PALETTE.length] : '#94A3B8';
}
