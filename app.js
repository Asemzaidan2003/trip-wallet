const path = require('node:path');
const express = require('express');
const pg = require('pg');
const { HttpError } = require('./lib/validate');
const { fetchRates: defaultFetchRates } = require('./lib/rates');

// Return DATE columns as 'YYYY-MM-DD' strings; JS Date would shift them by the local timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

// `auth` (from lib/auth.js) is optional: without it the app is open, as when it only listens on 127.0.0.1.
// `trustProxy` is for hosting behind an HTTPS proxy (Render, ...): real client IP and https come from its headers.
function createApp(pool, { fetchRates = defaultFetchRates, auth, trustProxy = false } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  app.get('/api/session', (req, res) => res.json({ authEnabled: Boolean(auth) }));
  // For the host's health check; it touches the database, so a broken database shows up as unhealthy.
  app.get('/api/health', async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });
  if (auth) {
    // Before login only tiny bodies are accepted; the large limit below applies to logged-in users only.
    app.post('/api/login', express.json({ limit: '2kb' }), auth.login);
    app.post('/api/logout', auth.logout);
    app.use(auth.middleware);
  }
  app.use(express.json({ limit: '10mb' })); // restores can be large
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/api/deposits', require('./routes/deposits')(pool));
  app.use('/api/categories', require('./routes/categories')(pool));
  app.use('/api', require('./routes/extras')(pool));
  app.use('/api', require('./routes/expenses')(pool));
  app.use('/api', require('./routes/settings')(pool, { fetchRates }));
  app.use('/api', require('./routes/reports')(pool));
  app.use('/api', require('./routes/backup')(pool));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', code: 'not_found' }));

  // Express 5 forwards rejected async handlers here.
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large', code: 'too_large' });
    if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'Invalid request', code: 'invalid_request' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
