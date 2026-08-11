'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryCache } = require('./helpers.js');

let connect;

test.before(async () => {
  connect = await import('../src/connect.ts');
});

const BASE = 'https://api.manyfold.test';

function environment(overrides = {}) {
  return {
    CACHE: memoryCache(),
    ADMIN_SETTINGS_PASSWORD: 'admin-password-with-enough-entropy',
    MANYFOLD_API_BASE_URL: BASE,
    ENVIRONMENT: 'production',
    ...overrides,
  };
}

function agentEntry(overrides = {}) {
  return {
    agentId: 'agt_one',
    name: 'Research Agent',
    rpcUrl: 'https://api.manyfold.test/api/a2a/agents/agt_one/rpc',
    cardUrl: 'https://api.manyfold.test/api/a2a/agents/agt_one/card',
    token: 'nca_agent_one_secret',
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...overrides,
  };
}

/** Routes fetches by URL suffix; every handler returns [status, bodyObject]. */
async function withFetch(routes, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    for (const [match, handler] of Object.entries(routes)) {
      if (href.includes(match)) {
        const [status, body] = await handler(init, href);
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: { message: 'unrouted' } }), { status: 404 });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const startOk = () => [200, {
  requestId: 'req-1',
  userCode: 'ABCD-1234',
  authUrl: 'https://manyfold.test/authorize?code=ABCD-1234',
  deviceCode: 'device-code-secret',
  expiresAt: new Date(Date.now() + 900_000).toISOString(),
}];

// A probe is a tasks/get for an id that cannot exist: the JSON-RPC "not found"
// answer proves the token works without running a billable turn.
const probeOk = () => [200, { jsonrpc: '2.0', error: { code: -32001, message: 'task not found' } }];
const cardOk = () => [200, { description: 'Reads and summarises long articles.' }];

test('start seals the device code and never returns it to the caller', async () => {
  const env = environment();
  await withFetch({ '/api/connect/a2a/start': startOk }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    assert.equal(session.userCode, 'ABCD-1234');
    assert.ok(!('deviceCode' in session));
    assert.ok(!JSON.stringify(session).includes('device-code-secret'));
  });
  const stored = env.CACHE.values.get('__connect:session:v1');
  assert.ok(stored, 'session was not persisted');
  assert.ok(!stored.includes('device-code-secret'), 'device code was stored in the clear');
});

test('start omits clientUrl for a non-https origin because Manyfold rejects it', async () => {
  const env = environment();
  await withFetch({ '/api/connect/a2a/start': startOk }, async (calls) => {
    await connect.startConnect(env, 'http://localhost:8787/settings');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.clientName, 'Article Lens');
    assert.ok(!('clientUrl' in body));
  });
});

test('a 404 on start blames the base URL rather than the device code', async () => {
  const env = environment();
  await withFetch({ '/api/connect/a2a/start': () => [404, { error: { message: 'Cannot POST /api/connect/a2a/start' } }] }, async () => {
    await assert.rejects(
      connect.startConnect(env, 'https://lens.test/settings'),
      /MANYFOLD_API_BASE_URL/,
    );
  });
});

test('a pending poll leaves the session usable', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, { status: 'pending' }],
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    assert.deepEqual(await connect.pollConnect(env, session.connectId), { status: 'pending' });
    assert.ok(await connect.getConnectSession(env));
  });
});

test('approval stores agents, assigns every role, and never exposes a token', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, {
      status: 'approved',
      userEmail: 'zack@netmind.test',
      agents: [agentEntry()],
    }],
    '/card': cardOk,
    '/rpc': probeOk,
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    const outcome = await connect.pollConnect(env, session.connectId);

    assert.equal(outcome.status, 'approved');
    assert.equal(outcome.agents.length, 1);
    assert.equal(outcome.agents[0].verified, true);
    assert.equal(outcome.agents[0].description, 'Reads and summarises long articles.');
    assert.deepEqual(outcome.failed, []);
    // One connected agent serves every role, and that is written down rather
    // than left implicit.
    for (const role of connect.ROLE_KEYS) assert.equal(outcome.roles[role], 'agt_one');
    assert.ok(!JSON.stringify(outcome).includes('nca_agent_one_secret'), 'token leaked in the poll response');
  });

  const agents = await connect.listConnectedAgents(env);
  assert.ok(!JSON.stringify(agents).includes('nca_agent_one_secret'), 'token leaked in the agent list');
  assert.ok(!env.CACHE.values.get('__connect:agents:v1').includes('nca_agent_one_secret'), 'token stored in the clear');
});

test('an agent whose rpcUrl points at a private address is refused, not stored', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, {
      status: 'approved',
      userEmail: null,
      agents: [
        agentEntry({ agentId: 'agt_evil', name: 'Metadata', rpcUrl: 'https://169.254.169.254/latest/meta-data' }),
        agentEntry(),
      ],
    }],
    '/card': cardOk,
    '/rpc': probeOk,
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    const outcome = await connect.pollConnect(env, session.connectId);
    assert.equal(outcome.agents.length, 1);
    assert.equal(outcome.agents[0].agentId, 'agt_one');
    assert.equal(outcome.failed.length, 1);
    assert.match(outcome.failed[0].error, /private address/);
  });
  assert.deepEqual((await connect.listConnectedAgents(env)).map(a => a.agentId), ['agt_one']);
});

test('a failed probe keeps the issued credential but records the warning', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, { status: 'approved', userEmail: null, agents: [agentEntry()] }],
    '/card': cardOk,
    '/rpc': () => [401, { error: { message: 'token rejected' } }],
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    const outcome = await connect.pollConnect(env, session.connectId);
    // Dropping an already-issued token would leave a live credential nobody
    // can revoke, so it is stored with the failure attached.
    assert.equal(outcome.agents.length, 1);
    assert.equal(outcome.agents[0].verified, false);
    assert.match(outcome.agents[0].warning, /rejected this token/);
  });
});

test('a second poll after approval reports expired and does not duplicate agents', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, { status: 'approved', userEmail: null, agents: [agentEntry()] }],
    '/card': cardOk,
    '/rpc': probeOk,
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    await connect.pollConnect(env, session.connectId);
    assert.deepEqual(await connect.pollConnect(env, session.connectId), { status: 'expired' });
  });
  assert.equal((await connect.listConnectedAgents(env)).length, 1);
});

test('a 404 on poll retires the session instead of blaming configuration', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [404, { error: { message: 'deviceCode not found' } }],
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    assert.deepEqual(await connect.pollConnect(env, session.connectId), { status: 'expired' });
    assert.equal(await connect.getConnectSession(env), null);
  });
});

test('re-approving the same agent rotates its token in place', async () => {
  const env = environment();
  const routes = {
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, {
      status: 'approved',
      userEmail: null,
      agents: [agentEntry({ token: 'nca_rotated_secret', name: 'Research Agent v2' })],
    }],
    '/card': cardOk,
    '/rpc': probeOk,
  };
  await withFetch({ ...routes, '/api/connect/a2a/poll': () => [200, { status: 'approved', userEmail: null, agents: [agentEntry()] }] }, async () => {
    const first = await connect.startConnect(env, 'https://lens.test/settings');
    await connect.pollConnect(env, first.connectId);
  });
  await withFetch(routes, async () => {
    const second = await connect.startConnect(env, 'https://lens.test/settings');
    await connect.pollConnect(env, second.connectId);
  });

  const agents = await connect.listConnectedAgents(env);
  assert.equal(agents.length, 1, 'a rotated token created a duplicate agent');
  assert.equal(agents[0].name, 'Research Agent v2');
  const runtime = await connect.loadA2ARuntime(env);
  assert.equal(runtime.credential('agt_one').token, 'nca_rotated_secret');
});

test('disconnecting an agent clears the roles it served', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, { status: 'approved', userEmail: null, agents: [agentEntry()] }],
    '/card': cardOk,
    '/rpc': probeOk,
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    await connect.pollConnect(env, session.connectId);
  });
  await connect.disconnectAgent(env, 'agt_one');
  const roles = await connect.getRoleMap(env);
  for (const role of connect.ROLE_KEYS) assert.equal(roles[role], null);
  assert.equal((await connect.loadA2ARuntime(env)).mode, 'mock');
});

test('the runtime refuses to serialize itself so a stray log cannot print a token', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, { status: 'approved', userEmail: null, agents: [agentEntry()] }],
    '/card': cardOk,
    '/rpc': probeOk,
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    await connect.pollConnect(env, session.connectId);
  });
  const runtime = await connect.loadA2ARuntime(env);
  assert.equal(runtime.mode, 'live');
  assert.equal(JSON.stringify({ env: 'x', A2A: runtime }), '{"env":"x","A2A":"[a2a-runtime]"}');
  assert.equal(runtime.credential('agt_one').token, 'nca_agent_one_secret');
  assert.equal(runtime.credential('agt_missing'), null);
});

test('rotating the admin password makes stored credentials unreadable, not corrupt', async () => {
  const env = environment();
  await withFetch({
    '/api/connect/a2a/start': startOk,
    '/api/connect/a2a/poll': () => [200, { status: 'approved', userEmail: null, agents: [agentEntry()] }],
    '/card': cardOk,
    '/rpc': probeOk,
  }, async () => {
    const session = await connect.startConnect(env, 'https://lens.test/settings');
    await connect.pollConnect(env, session.connectId);
  });
  const rotated = { ...env, ADMIN_SETTINGS_PASSWORD: 'a-completely-different-admin-password' };
  assert.deepEqual(await connect.listConnectedAgents(rotated), []);
  assert.equal((await connect.loadA2ARuntime(rotated)).mode, 'mock');
});
