'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryCache, request, responseCookie } = require('./helpers.js');

let settings;

test.before(async () => {
  settings = await import('../src/admin/settings.ts');
});

function environment(overrides = {}) {
  return {
    CACHE: memoryCache(),
    ADMIN_SETTINGS_PASSWORD: 'admin-password-with-enough-entropy',
    ACCESS_PASSCODE: '246810',
    SPEC_VERSION: '13',
    ANALYSIS_JOBS: {},
    ANALYSIS_TASK_QUEUE: {},
    ASSETS: {},
    ...overrides,
  };
}

async function login(env, password = env.ADMIN_SETTINGS_PASSWORD) {
  const response = await settings.handleAdminSettings(request('/api/admin/settings/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  }), env);
  return { response, cookie: response.status === 200 ? responseCookie(response, 'article_lens_admin') : '' };
}

test('requires the admin secret and rejects cross-site login', async () => {
  const missing = await settings.handleAdminSettings(request('/api/admin/settings'), environment({
    ADMIN_SETTINGS_PASSWORD: '',
  }));
  assert.equal(missing.status, 503);

  const crossSite = await settings.handleAdminSettings(request('/api/admin/settings/login', {
    method: 'POST',
    headers: {
      origin: 'https://attacker.test',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify({ password: 'admin-password-with-enough-entropy' }),
  }), environment());
  assert.equal(crossSite.status, 403);
});

test('authenticates settings and never returns secret values', async () => {
  const env = environment();
  const denied = await login(env, 'wrong-password');
  assert.equal(denied.response.status, 401);

  const authenticated = await login(env);
  assert.equal(authenticated.response.status, 200);
  assert.match(authenticated.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(authenticated.response.headers.get('set-cookie'), /SameSite=Strict/);

  const response = await settings.handleAdminSettings(request('/api/admin/settings', {
    headers: { cookie: authenticated.cookie },
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  const passcode = body.fields.find(field => field.key === 'ACCESS_PASSCODE');
  assert.deepEqual(
    { value: passcode.value, configured: passcode.configured, source: passcode.source },
    { value: '', configured: true, source: 'environment' },
  );
  // Manyfold configuration is no longer a settings field: agents arrive
  // through the connect handshake, not as pasted ids and a pasted token.
  assert.deepEqual(body.fields.map(field => field.key), ['ACCESS_PASSCODE', 'SPEC_VERSION']);
  assert.deepEqual(
    body.infrastructure.map(binding => binding.name),
    ['CACHE', 'ANALYSIS_JOBS', 'ANALYSIS_TASK_QUEUE', 'ASSETS'],
  );
});

test('validates passcode and number fields together', async () => {
  const env = environment();
  const { cookie } = await login(env);
  const response = await settings.handleAdminSettings(request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie },
    body: JSON.stringify({
      values: {
        ACCESS_PASSCODE: '123',
        SPEC_VERSION: '0',
      },
    }),
  }), env);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'validation failed');
  assert.ok(body.details.some(detail => detail.includes('exactly 6 digits')));
  assert.ok(body.details.some(detail => detail.includes('positive integer')));
});

test('encrypts saved overrides and resolves them without exposing secrets', async () => {
  const env = environment();
  const { cookie } = await login(env);
  const response = await settings.handleAdminSettings(request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie },
    body: JSON.stringify({
      values: {
        ACCESS_PASSCODE: '654321',
        SPEC_VERSION: '14',
      },
    }),
  }), env);
  assert.equal(response.status, 200);

  const stored = env.CACHE.values.get('__admin:runtime-settings:v1');
  assert.equal(typeof stored, 'string');
  assert.doesNotMatch(stored, /654321/);

  const runtime = await settings.resolveRuntimeEnv(env);
  assert.equal(runtime.ACCESS_PASSCODE, '654321');
  assert.equal(runtime.SPEC_VERSION, '14');

  const read = await settings.handleAdminSettings(request('/api/admin/settings', {
    headers: { cookie },
  }), env);
  const body = await read.json();
  const passcode = body.fields.find(field => field.key === 'ACCESS_PASSCODE');
  assert.deepEqual(
    { value: passcode.value, configured: passcode.configured, source: passcode.source },
    { value: '', configured: true, source: 'settings' },
  );
});

test('prunes peer-mint settings so they cannot outrank the connect role map', async () => {
  const env = environment();
  const { cookie } = await login(env);
  // Simulate a blob written before the cutover, when these were real fields.
  const stale = {
    updatedAt: new Date().toISOString(),
    values: {
      SPEC_VERSION: '14',
      MF_API_TOKEN: 'stale-token',
      MF_AGENT_ID: 'agt_stale_source',
      AGENT_SUMMARIZER: 'agt_stale_sum',
      AGENT_CONTEXT: 'agt_stale_ctx',
    },
  };
  const crypto = await import('../src/crypto.ts');
  env.CACHE.values.set(
    '__admin:runtime-settings:v1',
    await crypto.seal(stale, env.ADMIN_SETTINGS_PASSWORD, 'settings'),
  );

  const read = await settings.handleAdminSettings(request('/api/admin/settings', {
    headers: { cookie },
  }), env);
  assert.equal(read.status, 200);

  const runtime = await settings.resolveRuntimeEnv(env);
  assert.equal(runtime.SPEC_VERSION, '14', 'a still-valid field must survive the prune');
  // A stale AGENT_* spread over env would route a role at an agent nobody
  // connected, and would beat the connect mapping because it is applied later.
  assert.equal(runtime.AGENT_SUMMARIZER, '');
  assert.equal(runtime.AGENT_CONTEXT, '');
  assert.equal(runtime.MF_API_TOKEN, undefined);
  assert.equal(runtime.MF_AGENT_ID, undefined);
  assert.equal(runtime.A2A.mode, 'mock');
});

test('reports encrypted settings that cannot be read after password rotation', async () => {
  const env = environment();
  const firstLogin = await login(env);
  const save = await settings.handleAdminSettings(request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie: firstLogin.cookie },
    body: JSON.stringify({ values: { SPEC_VERSION: '14' } }),
  }), env);
  assert.equal(save.status, 200);

  env.ADMIN_SETTINGS_PASSWORD = 'rotated-admin-password-with-enough-entropy';
  const secondLogin = await login(env);
  assert.equal(secondLogin.response.status, 200);
  const read = await settings.handleAdminSettings(request('/api/admin/settings', {
    headers: { cookie: secondLogin.cookie },
  }), env);
  const body = await read.json();
  assert.match(body.warning, /could not be decrypted/i);
  assert.equal(body.updated_at, null);
});
