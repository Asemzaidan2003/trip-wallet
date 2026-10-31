import en from './lang/en.js';
import ar from './lang/ar.js';

// English / Arabic. Reads storage directly (not via api.js) so it can load first without an import cycle.
const DICTS = { en, ar };
function initialLang() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'en' || saved === 'ar') return saved;
  } catch { /* storage unavailable */ }
  return (navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
}
export const lang = initialLang();
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

// Dates and names follow the language; Arabic keeps Western digits and the Gregorian calendar.
export const locale = lang === 'ar' ? 'ar-u-nu-latn-ca-gregory' : 'en';

// t('key', { n: 3 }) — entries are strings with {placeholders} or functions (for Arabic plurals).
export function t(key, vars = {}) {
  const entry = DICTS[lang][key] ?? en[key];
  if (entry === undefined) return key;
  if (typeof entry === 'function') return entry(vars);
  return entry.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export function setLang(next) {
  try { localStorage.setItem('lang', next); } catch { /* not persisted */ }
  location.reload(); // every view, dialog and date format re-renders in the new language
}

// Translates static markup: data-i18n (text), data-i18n-aria (aria-label + title), data-i18n-ph (placeholder).
export function translateStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria));
    el.title = t(el.dataset.i18nAria);
  }
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
}

// The seeded default categories are shown translated; names the user typed are shown as typed.
export function catName(name) {
  if (name === null || name === undefined) return t('uncategorized');
  const general = name.endsWith(' (general)');
  const base = general ? name.slice(0, -' (general)'.length) : name;
  const shown = (lang === 'ar' && ar.defaultCategories[base]) || base;
  return general ? t('generalOf', { name: shown }) : shown;
}

// Turns an API error body into a message in the current language.
export function errorText(body, fallback) {
  const code = body?.code;
  if (code && DICTS[lang].errors[code]) return DICTS[lang].errors[code];
  if (code?.startsWith('invalid_')) {
    const field = code.slice('invalid_'.length);
    return t('invalidField', { field: DICTS[lang].fields[field] ?? en.fields[field] ?? field });
  }
  return body?.error || fallback;
}
