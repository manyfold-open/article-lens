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

function sseResponse(results) {
  const body = results
    .map(result => `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'rpc', result })}\r\n\r\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
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

test('streams an A2A task to completion and emits input/output traces', async t => {
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
    return sseResponse([
      {
        kind: 'status-update',
        taskId: 'task-success',
        status: { state: 'working' },
        final: false,
      },
      {
        kind: 'artifact-update',
        taskId: 'task-success',
        artifact: {
          artifactId: 'answer',
          parts: [{ kind: 'text', text: '{"ok":' }],
        },
        append: false,
        lastChunk: false,
      },
      {
        kind: 'artifact-update',
        taskId: 'task-success',
        artifact: {
          artifactId: 'answer',
          parts: [{ kind: 'text', text: 'true}' }],
        },
        append: true,
        lastChunk: true,
      },
      {
        kind: 'status-update',
        taskId: 'task-success',
        status: { state: 'completed' },
        final: true,
      },
    ]);
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
  assert.equal(rpcBody.method, 'message/stream');
  assert.deepEqual(rpcBody.params.configuration, { acceptedOutputModes: ['text/plain'] });
  assert.equal(rpcBody.params.message.parts[0].text, 'real prompt');
  assert.equal(requests[1].init.headers.Accept, 'text/event-stream');
  assert.deepEqual(
    traces.map(trace => trace.phase),
    ['input', 'progress', 'progress', 'progress', 'progress', 'output'],
  );
  assert.equal(traces[0].content, 'real prompt');
  assert.equal(traces.at(-1).content, '{"ok":true}');
  assert.ok(traces.every(trace => !JSON.stringify(trace).includes('short-lived-peer-token')));
});

test('recovers an accepted task after stream interruption without resubmitting the prompt', async t => {
  const methods = [];
  const traces = [];
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
    if (body.method === 'message/stream') {
      return sseResponse([{
        kind: 'status-update',
        taskId: 'task-1',
        status: { state: 'working' },
        final: false,
      }]);
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
    trace: {
      agent: 'sum',
      emit(event) { traces.push(event); },
    },
  });
  assert.equal(output, 'completed asynchronously');
  assert.deepEqual(methods, ['message/stream', 'tasks/get']);
  assert.ok(traces.some(trace => trace.content?.includes('stream ended before')));
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
    return sseResponse([{
      kind: 'status-update',
      taskId: 'task-failed',
      status: {
          state: 'failed',
          message: {
            kind: 'message',
            role: 'agent',
            parts: [{ kind: 'text', text: 'gemini exited 1: SyntaxError: Unexpected end of JSON input' }],
          },
        },
      final: true,
    }]);
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

test('stops before exceeding the shared Free Workers A2A request budget', async t => {
  let requestCount = 0;
  mockFetch(t, async url => {
    requestCount += 1;
    assert.ok(String(url).includes('/token'));
    return jsonResponse({
      token: 'peer-token',
      rpcUrl: 'https://agent.manyfold.test/rpc',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  });

  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_budget', 'prompt', {
      attempts: 1,
      requestBudget: { remaining: 1 },
    }),
    /Free Workers A2A subrequest budget exhausted before opening a stream/,
  );
  assert.equal(requestCount, 1);
});
