'use strict';

function memoryCache(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  const deletes = [];
  return {
    values,
    writes,
    deletes,
    async get(key) {
      return values.get(key) ?? null;
    },
    async put(key, value, options) {
      values.set(key, value);
      writes.push({ key, value, options });
    },
    async delete(key) {
      values.delete(key);
      deletes.push(key);
    },
  };
}

function request(path, init = {}) {
  const {
    baseUrl = 'http://article.test',
    clientIp = '192.0.2.10',
    ...requestInit
  } = init;
  const headers = new Headers(requestInit.headers);
  if (!headers.has('origin')) headers.set('origin', new URL(baseUrl).origin);
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', clientIp);
  if (requestInit.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Request(new URL(path, baseUrl), { ...requestInit, headers });
}

function responseCookie(response, name) {
  const header = response.headers.get('set-cookie') || '';
  const cookie = header.split(';')[0];
  if (name && !cookie.startsWith(`${name}=`)) {
    throw new Error(`Expected ${name} cookie, received ${header || '<none>'}`);
  }
  return cookie;
}

/**
 * Stands in for the A2ARuntime that resolveRuntimeEnv attaches to env.
 *
 * Each entry needs agentId/name/rpcUrl/token; expiresAt is epoch ms or null.
 * Keeps mf.ts tests free of the whole connect handshake, which has its own
 * suite in connect.test.js.
 */
function fakeRuntime(entries = []) {
  const agents = entries.map(entry => ({
    agentId: entry.agentId,
    name: entry.name ?? entry.agentId,
    description: entry.description ?? '',
    rpcUrl: entry.rpcUrl,
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
    verified: entry.verified ?? true,
    warning: null,
    connectedAt: '2026-08-11T00:00:00.000Z',
  }));
  const credentials = new Map(entries.map(entry => [entry.agentId, {
    agentId: entry.agentId,
    rpcUrl: entry.rpcUrl,
    token: entry.token,
    label: entry.name ?? entry.agentId,
    expiresAt: entry.expiresAt ?? null,
  }]));
  return {
    mode: entries.length ? 'live' : 'mock',
    roles: { sum: null, ctx: null, synth: null, jargon: null, comments: null },
    agents,
    credential: agentId => credentials.get(agentId) ?? null,
    soonestExpiryAt: null,
    distinctAgentCount: entries.length,
    toJSON: () => '[a2a-runtime]',
  };
}

module.exports = { memoryCache, request, responseCookie, fakeRuntime };
