'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let connect;

test.before(async () => {
  connect = await import('../src/connect.ts');
});

function agent(agentId, name, extra = {}) {
  return {
    agentId,
    name,
    description: '',
    rpcUrl: `https://api.manyfold.test/api/a2a/agents/${agentId}/rpc`,
    expiresAt: null,
    verified: true,
    warning: null,
    connectedAt: '2026-08-11T00:00:00.000Z',
    ...extra,
  };
}

const NO_ROLES = { sum: null, ctx: null, synth: null, jargon: null, comments: null };

test('no agents leaves every role unassigned', () => {
  assert.deepEqual(connect.autoAssignRoles([], NO_ROLES), NO_ROLES);
});

test('a single agent takes every role', () => {
  const roles = connect.autoAssignRoles([agent('agt_solo', 'My Agent')], NO_ROLES);
  for (const role of connect.ROLE_KEYS) assert.equal(roles[role], 'agt_solo');
});

test('several agents are matched to roles by name', () => {
  const roles = connect.autoAssignRoles([
    agent('agt_a', 'Summariser Bot'),
    agent('agt_b', 'Jargon Glossary'),
    agent('agt_c', 'Context Critic'),
    agent('agt_d', 'Synthesis Editor'),
    agent('agt_e', 'Comment Digest'),
  ], NO_ROLES);
  assert.deepEqual(roles, {
    sum: 'agt_a',
    ctx: 'agt_c',
    synth: 'agt_d',
    jargon: 'agt_b',
    comments: 'agt_e',
  });
});

test('roles no name matches fall back to the first verified agent', () => {
  const roles = connect.autoAssignRoles([
    agent('agt_unverified', 'Alpha', { verified: false }),
    agent('agt_ok', 'Beta'),
  ], NO_ROLES);
  for (const role of connect.ROLE_KEYS) assert.equal(roles[role], 'agt_ok');
});

test('an explicit assignment survives reconnecting', () => {
  const chosen = { ...NO_ROLES, synth: 'agt_b' };
  const roles = connect.autoAssignRoles([
    agent('agt_a', 'Synthesis Editor'),
    agent('agt_b', 'Something Else'),
  ], chosen);
  // The name heuristic would have picked agt_a for synth; the operator's
  // choice outranks it.
  assert.equal(roles.synth, 'agt_b');
});

test('a role pointing at a disconnected agent is reassigned, not left dangling', () => {
  const stale = { ...NO_ROLES, sum: 'agt_gone', ctx: 'agt_here' };
  const roles = connect.autoAssignRoles([agent('agt_here', 'Only Agent')], stale);
  assert.equal(roles.sum, 'agt_here');
  assert.equal(roles.ctx, 'agt_here');
});

/* ───────── readiness ───────── */

function runtime(agents, roles, credentials = {}) {
  return {
    mode: agents.length ? 'live' : 'mock',
    roles,
    agents,
    credential: (agentId) => credentials[agentId] ?? null,
    soonestExpiryAt: null,
    distinctAgentCount: new Set(Object.values(roles).filter(Boolean)).size,
    toJSON: () => '[a2a-runtime]',
  };
}

function credential(agentId, label, expiresAt = null) {
  return { agentId, rpcUrl: 'https://api.manyfold.test/rpc', token: 'secret', label, expiresAt };
}

const HORIZON = 30 * 60_000;

test('readiness reports not_connected before anything is connected', () => {
  const result = connect.credentialReadiness(undefined, HORIZON);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_connected');
  assert.equal(result.roles.length, connect.ROLE_KEYS.length);
});

test('readiness passes when every role resolves to a live credential', () => {
  const all = Object.fromEntries(connect.ROLE_KEYS.map(role => [role, 'agt_one']));
  const result = connect.credentialReadiness(
    runtime([agent('agt_one', 'Solo')], all, { agt_one: credential('agt_one', 'Solo') }),
    HORIZON,
  );
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
});

test('readiness fails a role whose authorization lapses before the run could finish', () => {
  const all = Object.fromEntries(connect.ROLE_KEYS.map(role => [role, 'agt_one']));
  const result = connect.credentialReadiness(
    runtime(
      [agent('agt_one', 'Solo', { expiresAt: new Date(Date.now() + 60_000).toISOString() })],
      all,
      { agt_one: credential('agt_one', 'Solo', Date.now() + 60_000) },
    ),
    HORIZON,
  );
  // A token with a minute left would spend the whole 12-minute budget
  // producing an all-fallback report. Refusing early is the useful answer.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'expiring');
});

test('readiness distinguishes an already-expired authorization from an expiring one', () => {
  const all = Object.fromEntries(connect.ROLE_KEYS.map(role => [role, 'agt_one']));
  const result = connect.credentialReadiness(
    runtime(
      [agent('agt_one', 'Solo', { expiresAt: new Date(Date.now() - 1_000).toISOString() })],
      all,
      { agt_one: credential('agt_one', 'Solo', Date.now() - 1_000) },
    ),
    HORIZON,
  );
  assert.equal(result.code, 'expired');
});

test('readiness names the roles that have no agent assigned', () => {
  const partial = { ...NO_ROLES, sum: 'agt_one' };
  const result = connect.credentialReadiness(
    runtime([agent('agt_one', 'Solo')], partial, { agt_one: credential('agt_one', 'Solo') }),
    HORIZON,
  );
  assert.equal(result.code, 'unmapped_roles');
  assert.equal(result.roles.filter(role => !role.ok).length, connect.ROLE_KEYS.length - 1);
  assert.equal(result.roles.find(role => role.role === 'sum').ok, true);
});
