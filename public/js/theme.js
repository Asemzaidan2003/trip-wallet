import { store } from './api.js';
import { t } from './i18n.js';

// Light/dark switch. Without a saved choice the theme follows the device setting.
const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

const root = document.documentElement;
const media = matchMedia('(prefers-color-scheme: dark)');
const current = () => root.dataset.theme || (media.matches ? 'dark' : 'light');

export function initTheme(button) {
  const paint = () => {
    const dark = current() === 'dark';
    button.innerHTML = dark ? SUN : MOON;
    button.title = t(dark ? 'toLight' : 'toDark');
    button.setAttribute('aria-label', button.title);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0F172A' : '#F8FAFC');
  };
  button.onclick = () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    store.set('theme', next);
    paint();
  };
  media.addEventListener('change', paint);
  paint();
}
