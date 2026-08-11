'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let a2a;

test.before(async () => {
  a2a = await import('../src/a2a.ts');
});

const RPC_URL = 'https://api.manyfold.ai/api/a2a/agents/agt_example/rpc';

test('accepts a production Manyfold RPC URL and drops the fragment', () => {
  assert.equal(a2a.validateA2AUrl(`${RPC_URL}#frag`, true, 'RPC URL'), RPC_URL);
});

test('rejects every host that could exfiltrate a bearer token in production', () => {
  const rejected = [
    'http://api.manyfold.ai/rpc',
    'https://user:pass@api.manyfold.ai/rpc',
    'https://localhost/rpc',
    'https://127.0.0.1/rpc',
    'https://0.0.0.0/rpc',
    'https://10.0.0.8/rpc',
    'https://192.168.1.5/rpc',
    'https://172.16.0.1/rpc',
    // The cloud metadata endpoint: the single highest-value SSRF target.
    'https://169.254.169.254/latest/meta-data',
    'https://agent.local/rpc',
    'https://[::1]/rpc',
    'https://[fd00::1]/rpc',
    'https://[fe80::1]/rpc',
    'not a url',
  ];
  for (const url of rejected) {
    assert.throws(
      () => a2a.validateA2AUrl(url, true, 'RPC URL'),
      (error) => error instanceof a2a.A2AError && error.retryable === false,
      `expected ${url} to be rejected`,
    );
  }
});

test('allows a loopback agent outside production so local development works', () => {
  assert.equal(
    a2a.validateA2AUrl('http://localhost:8787/rpc', false, 'RPC URL'),
    'http://localhost:8787/rpc',
  );
});

test('redacts bearer tokens, JWTs, and token query parameters from error text', () => {
  // A full JWT header, not the truncated `{"alg":"HS256"}` form: the pattern
  // requires 20+ characters per segment so it cannot match ordinary prose.
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    + '.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkFnZW50In0'
    + '.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const raw = `failed with authorization: Bearer nca_live_secret_value and ${jwt} `
    + 'while calling https://agent.example/rpc?token=abc123&x=1';
  const safe = a2a.safeErrorText(raw);
  assert.ok(!safe.includes('nca_live_secret_value'), 'bearer token survived');
  assert.ok(!safe.includes('abc123'), 'token query parameter survived');
  assert.ok(!safe.includes(jwt), 'JWT survived');
  assert.ok(safe.includes('Bearer [redacted]'));
  assert.ok(safe.includes('[redacted-token]'));
  assert.ok(safe.includes('token=[redacted]'));
});

test('an A2AError redacts on construction so no caller can leak a token by forgetting', () => {
  const error = new a2a.A2AError('upstream said authorization: Bearer nca_secret', true);
  assert.ok(!error.message.includes('nca_secret'));
  assert.ok(error.message.includes('Bearer [redacted]'));
});

test('collapses whitespace and bounds the length of error text', () => {
  assert.equal(a2a.safeErrorText('a\n\n  b'), 'a b');
  assert.ok(a2a.safeErrorText('x'.repeat(5_000)).length <= 1_000);
});

test('normalizes protobuf and hyphenated task states without whitelisting', () => {
  assert.equal(a2a.normalizeState('TASK_STATE_COMPLETED'), 'completed');
  assert.equal(a2a.normalizeState('INPUT_REQUIRED'), 'input-required');
  assert.equal(a2a.normalizeState('  Working '), 'working');
  // An unrecognised state must stay truthy: the recovery loop reads an empty
  // state as "task finished", so silently blanking one would look like success.
  assert.equal(a2a.normalizeState('queued-behind-others'), 'queued-behind-others');
  assert.ok(a2a.isTerminalTaskState(a2a.normalizeState('TASK_STATE_COMPLETED')));
});

test('folds artifact chunks in arrival order and appends only when asked', () => {
  const folded = a2a.foldA2AResults([
    { kind: 'status-update', taskId: 't1', status: { state: 'working' } },
    { kind: 'artifact-update', taskId: 't1', artifact: { artifactId: 'a', parts: [{ text: 'Hello' }] } },
    { kind: 'artifact-update', taskId: 't1', append: true, artifact: { artifactId: 'a', parts: [{ text: ', world' }] } },
    { kind: 'artifact-update', taskId: 't1', artifact: { artifactId: 'b', parts: [{ text: 'second' }] } },
    { kind: 'status-update', taskId: 't1', status: { state: 'completed' }, final: true },
  ]);
  assert.equal(a2a.taskId(folded), 't1');
  assert.equal(a2a.taskState(folded), 'completed');
  assert.equal(a2a.extractAgentText(folded), 'Hello, world\nsecond');
});

test('a repeated artifact id without append replaces rather than concatenates', () => {
  const folded = a2a.foldA2AResults([
    { kind: 'artifact-update', taskId: 't2', artifact: { artifactId: 'a', parts: [{ text: 'draft' }] } },
    { kind: 'artifact-update', taskId: 't2', artifact: { artifactId: 'a', parts: [{ text: 'final' }] } },
  ]);
  assert.equal(a2a.extractAgentText(folded), 'final');
});
