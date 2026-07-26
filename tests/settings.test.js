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
    MF_API_URL: 'https://api.manyfold.ai/api',
    MF_AGENT_ID: 'agt_source',
    MF_API_TOKEN: 'environment-token',
    SPEC_VERSION: '13',
    AGENT_SUMMARIZER: 'agt_sum',
    AGENT_CONTEXT: 'agt_ctx',
    AGENT_SYNTHESIZER: 'agt_synth',
    AGENT_COMMENT_MAP: 'agt_comment_map',
    AGENT_JARGON: 'agt_jargon',
    AGENT_COMMENT_REDUCE: 'agt_comment_reduce',
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
  const token = body.fields.find(field => field.key === 'MF_API_TOKEN');
  const passcode = body.fields.find(field => field.key === 'ACCESS_PASSCODE');
  assert.deepEqual(
    { value: token.value, configured: token.configured, source: token.source },
    { value: '', configured: true, source: 'environment' },
  );
  assert.equal(passcode.value, '');
  assert.deepEqual(
    body.infrastructure.map(binding => binding.name),
    ['CACHE', 'ANALYSIS_JOBS', 'ANALYSIS_TASK_QUEUE', 'ASSETS'],
  );
});

test('validates passcode, URL, number, and required fields together', async () => {
  const env = environment({ AGENT_CONTEXT: '' });
  const { cookie } = await login(env);
  const response = await settings.handleAdminSettings(request('/api/admin/settings', {
    method: 'PUT',
    headers: { cookie },
    body: JSON.stringify({
      values: {
        ACCESS_PASSCODE: '123',
        MF_API_URL: 'ftp://api.test',
        SPEC_VERSION: '0',
      },
    }),
  }), env);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'validation failed');
  assert.ok(body.details.some(detail => detail.includes('exactly 6 digits')));
  assert.ok(body.details.some(detail => detail.includes('HTTP or HTTPS')));
  assert.ok(body.details.some(detail => detail.includes('positive integer')));
  assert.ok(body.details.some(detail => detail.includes('Context agent is required')));
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
        MF_API_TOKEN: 'saved-token',
        SPEC_VERSION: '14',
      },
    }),
  }), env);
  assert.equal(response.status, 200);

  const stored = env.CACHE.values.get('__admin:runtime-settings:v1');
  assert.equal(typeof stored, 'string');
  assert.doesNotMatch(stored, /saved-token|654321/);

  const runtime = await settings.resolveRuntimeEnv(env);
  assert.equal(runtime.ACCESS_PASSCODE, '654321');
  assert.equal(runtime.MF_API_TOKEN, 'saved-token');
  assert.equal(runtime.SPEC_VERSION, '14');

  const read = await settings.handleAdminSettings(request('/api/admin/settings', {
    headers: { cookie },
  }), env);
  const body = await read.json();
  const token = body.fields.find(field => field.key === 'MF_API_TOKEN');
  assert.deepEqual(
    { value: token.value, configured: token.configured, source: token.source },
    { value: '', configured: true, source: 'settings' },
  );
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
