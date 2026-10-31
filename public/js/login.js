// Login page (only used when the server runs with APP_PASSWORD). Kept separate so it loads without a session.
const ar = document.documentElement.lang === 'ar';
const TEXT = ar
  ? { title: 'محفظة الرحلة', password: 'كلمة المرور', login: 'دخول', wrong_password: 'كلمة المرور غير صحيحة',
    too_many_attempts: 'محاولات كثيرة، انتظر دقيقة', failed: 'تعذّر تسجيل الدخول' }
  : { title: 'Trip Wallet', password: 'Password', login: 'Log in', wrong_password: 'Wrong password',
    too_many_attempts: 'Too many attempts; wait a minute', failed: 'Could not log in' };

for (const el of document.querySelectorAll('[data-t]')) el.textContent = TEXT[el.dataset.t];

const form = document.getElementById('login-form');
const error = form.querySelector('.dialog-error');
form.onsubmit = async (ev) => {
  ev.preventDefault();
  error.textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: form.password.value }),
  }).catch(() => null);
  if (res?.ok) location.replace('/');
  else error.textContent = TEXT[(await res?.json().catch(() => ({})))?.code] || TEXT.failed;
};
