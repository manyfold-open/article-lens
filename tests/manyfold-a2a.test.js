'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let manyfold;

test.before(async () => {
  manyfold = await import('../src/crew/mf.ts');
});

function environment() {
  return {
    MF_API_URL: 'https://api.manyfold.test/api',
    MF_AGENT_ID: 'agt_source',
    MF_API_TOKEN: 'manyfold-secret',
  };
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

test('extracts text from direct parts, artifacts, and status messages', () => {
  assert.equal(manyfold.extractAgentText({
    result: { parts: [{ text: 'first' }, { text: 'second' }] },
  }), 'first\nsecond');

  assert.equal(manyfold.extractAgentText({
    result: {
      artifacts: [
        { parts: [{ text: 'artifact one' }] },
        { parts: [{ text: 'artifact two' }] },
      ],
    },
  }), 'artifact one\nartifact two');

  assert.equal(manyfold.extractAgentText({
    result: {
      status: { message: { parts: [{ text: 'gemini exited 1' }] } },
    },
  }), 'gemini exited 1');
});

test('sends non-blocking A2A requests and emits input/output traces', async t => {
  const requests = [];
  mockFetch(t, async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('/token')) {
      assert.equal(init.headers.authorization, 'Bearer manyfold-secret');
      return jsonResponse({
        token: 'short-lived-peer-token',
        rpcUrl: 'https://agent.manyfold.test/rpc',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    return jsonResponse({
      result: {
        status: { state: 'completed' },
        artifacts: [{ parts: [{ text: '{"ok":true}' }] }],
      },
    });
  });

  const traces = [];
  const output = await manyfold.callMfAgent(environment(), 'agt_success', 'real prompt', {
    attempts: 1,
    trace: {
      agent: 'sum',
      emit(event) { traces.push(event); },
    },
  });

  assert.equal(output, '{"ok":true}');
  assert.equal(requests.length, 2);
  const rpcBody = JSON.parse(requests[1].init.body);
  assert.equal(rpcBody.method, 'message/send');
  assert.deepEqual(rpcBody.params.configuration, { blocking: false });
  assert.equal(rpcBody.params.message.parts[0].text, 'real prompt');
  assert.deepEqual(
    traces.map(trace => trace.phase),
    ['input', 'progress', 'progress', 'output'],
  );
  assert.equal(traces[0].content, 'real prompt');
  assert.equal(traces.at(-1).content, '{"ok":true}');
  assert.ok(traces.every(trace => !JSON.stringify(trace).includes('short-lived-peer-token')));
});

test('polls an accepted A2A task without submitting the prompt twice', async t => {
  const methods = [];
  mockFetch(t, async (url, init = {}) => {
    if (String(url).includes('/token')) {
      return jsonResponse({
        token: 'peer-token',
        rpcUrl: 'https://agent.manyfold.test/rpc',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    const body = JSON.parse(init.body);
    methods.push(body.method);
    if (body.method === 'message/send') {
      return jsonResponse({
        result: {
          id: 'task-1',
          status: { state: 'submitted' },
        },
      });
    }
    assert.equal(body.method, 'tasks/get');
    assert.equal(body.params.id, 'task-1');
    return jsonResponse({
      result: {
        id: 'task-1',
        status: { state: 'completed' },
        artifacts: [{ parts: [{ text: 'completed asynchronously' }] }],
      },
    });
  });

  const output = await manyfold.callMfAgent(environment(), 'agt_async', 'prompt', {
    attempts: 1,
    timeoutMs: 5_000,
  });
  assert.equal(output, 'completed asynchronously');
  assert.deepEqual(methods, ['message/send', 'tasks/get']);
});

test('surfaces the remote task failure reason without hiding it', async t => {
  mockFetch(t, async url => {
    if (String(url).includes('/token')) {
      return jsonResponse({
        token: 'peer-token',
        rpcUrl: 'https://agent.manyfold.test/rpc',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    return jsonResponse({
      result: {
        status: {
          state: 'failed',
          message: {
            parts: [{ text: 'gemini exited 1: SyntaxError: Unexpected end of JSON input' }],
          },
        },
      },
    });
  });

  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_failed', 'prompt', { attempts: 1 }),
    /task failed: gemini exited 1: SyntaxError: Unexpected end of JSON input/,
  );
});

test('reports invalid credential JSON responses precisely', async t => {
  mockFetch(t, async () => new Response('{"token":', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));

  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_invalid_credential_json', 'prompt', { attempts: 1 }),
    /Peer credential response was not valid JSON/,
  );
});

test('reports invalid RPC JSON responses precisely', async t => {
  let requestCount = 0;
  mockFetch(t, async url => {
    requestCount += 1;
    if (String(url).includes('/token')) {
      return jsonResponse({
        token: 'peer-token',
        rpcUrl: 'https://agent.manyfold.test/rpc',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    }
    return new Response('{"result":', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_invalid_json', 'prompt', { attempts: 1 }),
    /returned invalid JSON/,
  );
  assert.equal(requestCount, 2);
});
