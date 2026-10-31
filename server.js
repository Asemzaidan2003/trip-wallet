const crypto = require('node:crypto');
const { Pool } = require('pg');
const { createApp } = require('./app');
const { migrate } = require('./lib/migrate');
const { createAuth } = require('./lib/auth');
const { refreshRates } = require('./routes/settings');
const { fetchRates } = require('./lib/rates');

// NODE_ENV=production means "reachable from the internet" (e.g. hosted on Render): a password is then mandatory.
const production = process.env.NODE_ENV === 'production';
const password = process.env.APP_PASSWORD;

if (production && (!password || password.length < 10)) {
  console.error('Refusing to start: with NODE_ENV=production, APP_PASSWORD must be set and at least 10 characters long,');
  console.error('because this app holds your finances and would be reachable by anyone on the internet.');
  process.exit(1);
}

// Set APP_PASSWORD (and HOST=0.0.0.0) to use the app from your phone on the same Wi-Fi.
// Without SESSION_SECRET the cookie-signing key is derived from the password, so logins survive restarts
// and changing the password logs everyone out.
const auth = password
  ? createAuth({
    password,
    secret: process.env.SESSION_SECRET || crypto.createHash('sha256').update(`trip-wallet-session:${password}`).digest('hex'),
  })
  : undefined;

// Hosted databases (Neon, Render, ...) need TLS: set DATABASE_SSL=true if the URL has no ?sslmode=require.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? true : undefined });
// An idle connection dropped by the DB (e.g. a container restart) must not crash the process.
pool.on('error', (err) => console.error('Idle database connection error:', err.message));

const port = process.env.PORT || 3000;
// No login by default, so only listen on this machine unless HOST says otherwise (hosts need 0.0.0.0).
const host = process.env.HOST || (production ? '0.0.0.0' : '127.0.0.1');

migrate(pool)
  .then(() => {
    if (host !== '127.0.0.1' && !auth) console.warn('Warning: listening beyond this computer without APP_PASSWORD.');
    // Behind the host's HTTPS proxy: trust it for the real client IP and https (Secure cookies, login throttling).
    const trustProxy = production || process.env.TRUST_PROXY === '1';
    // Express 5 passes a listen failure (e.g. the port is taken) to this callback instead of throwing.
    createApp(pool, { auth, trustProxy }).listen(port, host, (err) => {
      if (err) {
        console.error(err.code === 'EADDRINUSE'
          ? `Port ${port} is already in use. Trip Wallet is probably already running: open http://localhost:${port}`
          : `Could not start the server: ${err.message}`);
        process.exit(1);
      }
      console.log(`Trip Wallet running on http://localhost:${port}`);
      // Refresh exchange rates once in the background; the app works offline with stored rates.
      // (SKIP_RATE_REFRESH=1 turns this off, e.g. in tests, so they never touch the network.)
      if (!process.env.SKIP_RATE_REFRESH) {
        refreshRates(pool, fetchRates)
          .then((r) => console.log(`Exchange rates updated: ${r.updated}`))
          .catch((err) => console.log(`Exchange rates: ${err.message}`));
      }
    });
  })
  .catch((err) => {
    console.error('Could not prepare the database:', err.message);
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(err.code)) {
      console.error('The database is not reachable. Start Docker Desktop, run "npm run db:up", then "npm start" again');
      console.error('(or just double-click start.cmd in the trip-wallet folder).');
    }
    process.exit(1);
  });
