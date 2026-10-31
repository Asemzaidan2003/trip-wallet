const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createApp } = require('../app');
const { createAuth } = require('../lib/auth');
const { useTestServer, listen, close } = require('./helpers');

const t = useTestServer();

test('the health check works without a login and touches the database', async () => {
  assert.deepEqual((await t.call('GET', '/api/health')).body, { ok: true });
  const s = await listen(createApp(t.pool, { auth: createAuth({ password: 'a long password', secret: 'k' }) }));
  try {
    const res = await fetch(`http://localhost:${s.address().port}/api/health`);
    assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
  } finally {
    await close(s);
  }
  const broken = await listen(createApp({ query: () => Promise.reject(new Error('db down')) }));
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await fetch(`http://localhost:${broken.address().port}/api/health`)).status, 500);
  } finally {
    console.error = orig;
    await close(broken);
  }
});

test('responses carry security headers and hide the framework', async () => {
  const res = await fetch(`${t.base}/api/session`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'same-origin');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('strict-transport-security'), null); // plain http
});

test('behind an HTTPS proxy the session cookie is Secure and HSTS is sent', async () => {
  const s = await listen(createApp(t.pool, { trustProxy: true, auth: createAuth({ password: 'a long password', secret: 'k' }) }));
  try {
    const res = await fetch(`http://localhost:${s.address().port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ password: 'a long password' }),
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('set-cookie'), /; HttpOnly; SameSite=Lax; Path=\/; Max-Age=\d+; Secure$/);
    assert.match(res.headers.get('strict-transport-security'), /max-age=\d+/);
  } finally {
    await close(s);
  }
});

test('the login throttle counts each real client separately behind a proxy', async () => {
  const s = await listen(createApp(t.pool, { trustProxy: true, auth: createAuth({ password: 'a long password', secret: 'k' }) }));
  const login = (ip, password) => fetch(`http://localhost:${s.address().port}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ password }),
  });
  try {
    for (let i = 0; i < 5; i++) await login('203.0.113.7', 'nope');
    assert.equal((await login('203.0.113.7', 'a long password')).status, 429); // that client is locked out...
    assert.equal((await login('198.51.100.9', 'a long password')).status, 204); // ...others are not
  } finally {
    await close(s);
  }
});

test('before login only small requests are accepted', async () => {
  const s = await listen(createApp(t.pool, { auth: createAuth({ password: 'a long password', secret: 'k' }) }));
  try {
    const res = await fetch(`http://localhost:${s.address().port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(5000) }),
    });
    assert.deepEqual([res.status, (await res.json()).code], [413, 'too_large']);
  } finally {
    await close(s);
  }
});

// Starts server.js as a real process with the given environment and returns what it printed.
function runServer(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.TEST_DATABASE_URL, PORT: '0', SKIP_RATE_REFRESH: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('exit', (code) => resolve({ code, output }));
    setTimeout(() => child.kill(), 4000); // a healthy server never exits by itself
  });
}

test('in production the server refuses to start without a strong APP_PASSWORD', async () => {
  for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', APP_PASSWORD: 'short' }]) {
    const { code, output } = await runServer(env);
    assert.equal(code, 1, JSON.stringify(env));
    assert.match(output, /APP_PASSWORD must be set and at least 10 characters/);
  }
  const ok = await runServer({ NODE_ENV: 'production', APP_PASSWORD: 'a long enough password' });
  assert.match(ok.output, /Trip Wallet running/); // starts (then is stopped by the test)
});
