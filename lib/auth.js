const crypto = require('node:crypto');
const { HttpError, bodyOf } = require('./validate');

// Optional password protection (set APP_PASSWORD). The session is an HMAC-signed expiry time in an HttpOnly cookie.
const COOKIE = 'tw_session';
const MAX_AGE_S = 30 * 24 * 3600;
const PUBLIC = new Set(['/login.html', '/styles.css', '/js/login.js', '/manifest.webmanifest', '/icon.svg', '/api/login', '/api/session']);

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function createAuth({ password, secret = crypto.randomBytes(32).toString('hex'), now = Date.now } = {}) {
  const mac = (exp) => crypto.createHmac('sha256', secret).update(exp).digest('base64url');
  const sign = (exp) => `${exp}.${mac(exp)}`;
  const failures = new Map(); // ip -> { count, since }
  // ponytail: in-memory throttle per IP; fine for one process and one user.

  function validToken(token) {
    const [exp, given] = String(token || '').split('.');
    if (!exp || !given || !/^\d+$/.test(exp)) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(mac(exp));
    return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(exp) > now();
  }

  const cookieOf = (req) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1];

  const setCookie = (req, res, value, maxAge) => res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`);

  function middleware(req, res, next) {
    if (PUBLIC.has(req.path) || validToken(cookieOf(req))) return next();
    if (req.path.startsWith('/api/')) return next(new HttpError(401, 'Please log in', 'login_required'));
    res.redirect(302, '/login.html');
  }

  function login(req, res) {
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && now() - f.since < 60_000 && f.count >= 5) {
      throw new HttpError(429, 'Too many attempts; wait a minute', 'too_many_attempts');
    }
    // Hashing both sides gives equal lengths for the constant-time comparison.
    if (!crypto.timingSafeEqual(digest(bodyOf(req).password ?? ''), digest(password))) {
      failures.set(ip, f && now() - f.since < 60_000 ? { ...f, count: f.count + 1 } : { count: 1, since: now() });
      throw new HttpError(401, 'Wrong password', 'wrong_password');
    }
    failures.delete(ip);
    setCookie(req, res, sign(String(now() + MAX_AGE_S * 1000)), MAX_AGE_S);
    res.sendStatus(204);
  }

  function logout(req, res) {
    setCookie(req, res, '', 0);
    res.sendStatus(204);
  }

  return { middleware, login, logout };
}

module.exports = { createAuth };
