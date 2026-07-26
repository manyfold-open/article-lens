'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryCache, request, responseCookie } = require('./helpers.js');

let access;

test.before(async () => {
  access = await import('../src/admin/settings.ts');
});

function environment(passcode = '246810') {
  return {
    CACHE: memoryCache(),
    ADMIN_SETTINGS_PASSWORD: 'test-admin-signing-secret-with-enough-entropy',
    ACCESS_PASSCODE: passcode,
  };
}

test('redirects documents and rejects APIs until the access passcode is entered', async () => {
  const env = environment();
  const documentGuard = await access.guardArticleAccess(request('/?analysis=abc'), env);
  assert.equal(documentGuard.response.status, 302);
  assert.equal(
    new URL(documentGuard.response.headers.get('location')).searchParams.get('next'),
    '/?analysis=abc',
  );

  const apiGuard = await access.guardArticleAccess(request('/api/frontpage'), env);
  assert.equal(apiGuard.response.status, 401);
  assert.equal((await apiGuard.response.json()).code, 'ACCESS_REQUIRED');
});

test('issues a signed access cookie and invalidates it when the passcode changes', async () => {
  const env = environment();
  const denied = await access.handleArticleAccess(request('/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: '111111' }),
  }), env);
  assert.equal(denied.status, 401);

  const login = await access.handleArticleAccess(request('/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: '246810' }),
  }), env);
  assert.equal(login.status, 200);
  const cookie = responseCookie(login, 'article_lens_access');

  const authenticated = await access.handleArticleAccess(request('/api/access/status', {
    headers: { cookie },
  }), env);
  assert.deepEqual(await authenticated.json(), {
    configured: true,
    ready: true,
    authenticated: true,
  });
  const allowed = await access.guardArticleAccess(request('/', { headers: { cookie } }), env);
  assert.equal(allowed.response, undefined);

  env.ACCESS_PASSCODE = '135790';
  const rotated = await access.handleArticleAccess(request('/api/access/status', {
    headers: { cookie },
  }), env);
  assert.equal((await rotated.json()).authenticated, false);
});

test('reports an unconfigured gate without exposing the application', async () => {
  const env = environment('');
  const status = await access.handleArticleAccess(request('/api/access/status'), env);
  assert.deepEqual(await status.json(), {
    configured: false,
    ready: false,
    authenticated: false,
  });
  const guarded = await access.guardArticleAccess(request('/api/health'), env);
  assert.equal(guarded.response.status, 503);
  assert.equal((await guarded.response.json()).code, 'ACCESS_NOT_CONFIGURED');
});

test('rate-limits repeated incorrect passcodes', async () => {
  const env = environment();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const denied = await access.handleArticleAccess(request('/api/access/login', {
      method: 'POST',
      body: JSON.stringify({ passcode: '000000' }),
    }), env);
    assert.equal(denied.status, 401);
  }
  const limited = await access.handleArticleAccess(request('/api/access/login', {
    method: 'POST',
    body: JSON.stringify({ passcode: '246810' }),
  }), env);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('rejects cross-site access requests and unsupported methods', async () => {
  const env = environment();
  const crossSite = await access.handleArticleAccess(request('/api/access/login', {
    method: 'POST',
    headers: {
      origin: 'https://attacker.test',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ passcode: '246810' }),
  }), env);
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error, 'cross-site request rejected');

  const wrongMethod = await access.handleArticleAccess(request('/api/access/status', {
    method: 'POST',
  }), env);
  assert.equal(wrongMethod.status, 405);
});

test('clears the access cookie on logout', async () => {
  const response = await access.handleArticleAccess(request('/api/access/logout', {
    method: 'POST',
  }), environment());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /^article_lens_access=;/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});
