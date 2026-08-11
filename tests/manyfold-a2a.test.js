'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeRuntime } = require('./helpers.js');

let manyfold;

test.before(async () => {
  manyfold = await import('../src/crew/mf.ts');
});

const RPC_URL = 'https://agent.manyfold.test/rpc';

/**
 * Under the connect model a credential is already in hand, so a happy-path
 * call makes exactly ONE external subrequest. The peer-mint era spent a second
 * one on /agent-self/a2a/peers/{id}/token before every stream.
 */
function environment(agents = [{ agentId: 'agt_success', name: 'Test agent', rpcUrl: RPC_URL, token: 'connected-agent-token' }]) {
  return { A2A: fakeRuntime(agents) };
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
    return sseResponse([
      { kind: 'status-update', taskId: 'task-success', status: { state: 'working' }, final: false },
      {
        kind: 'artifact-update',
        taskId: 'task-success',
        artifact: { artifactId: 'answer', parts: [{ kind: 'text', text: '{"ok":' }] },
        append: false,
        lastChunk: false,
      },
      {
        kind: 'artifact-update',
        taskId: 'task-success',
        artifact: { artifactId: 'answer', parts: [{ kind: 'text', text: 'true}' }] },
        append: true,
        lastChunk: true,
      },
      { kind: 'status-update', taskId: 'task-success', status: { state: 'completed' }, final: true },
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
  assert.equal(requests.length, 1, 'connect credentials cost no extra subrequest');
  assert.equal(requests[0].url, RPC_URL);
  assert.equal(requests[0].init.headers.authorization, 'Bearer connected-agent-token');
  // A redirect would replay the bearer against a host that was never validated.
  assert.equal(requests[0].init.redirect, 'manual');
  const rpcBody = JSON.parse(requests[0].init.body);
  assert.equal(rpcBody.method, 'message/stream');
  assert.deepEqual(rpcBody.params.configuration, { acceptedOutputModes: ['text/plain'] });
  assert.equal(rpcBody.params.message.parts[0].text, 'real prompt');
  assert.equal(requests[0].init.headers.Accept, 'text/event-stream');
  assert.deepEqual(
    traces.map(trace => trace.phase),
    ['input', 'progress', 'progress', 'progress', 'progress', 'output'],
  );
  assert.equal(traces[0].content, 'real prompt');
  assert.equal(traces.at(-1).content, '{"ok":true}');
  assert.ok(traces.every(trace => !JSON.stringify(trace).includes('connected-agent-token')));
});

test('reuses one messageId across attempts so a retry cannot bill a second turn', async t => {
  const messageIds = [];
  let calls = 0;
  mockFetch(t, async (url, init = {}) => {
    messageIds.push(JSON.parse(init.body).params.message.messageId);
    calls += 1;
    if (calls === 1) return new Response('upstream busy', { status: 503 });
    // Artifacts first, then the terminal status: the reader stops at a
    // terminal state, so anything after it would never be read.
    return sseResponse([
      { kind: 'artifact-update', taskId: 'task-retry', artifact: { artifactId: 'a', parts: [{ text: 'second try' }] } },
      { kind: 'status-update', taskId: 'task-retry', status: { state: 'completed' }, final: true },
    ]);
  });

  const output = await manyfold.callMfAgent(environment(), 'agt_success', 'prompt', { attempts: 2 });
  assert.equal(output, 'second try');
  assert.equal(messageIds.length, 2);
  assert.equal(messageIds[0], messageIds[1], 'a retry must reuse the idempotency key');
});

test('recovers an accepted task after stream interruption without resubmitting the prompt', async t => {
  const methods = [];
  const traces = [];
  mockFetch(t, async (url, init = {}) => {
    const body = JSON.parse(init.body);
    methods.push(body.method);
    if (body.method === 'message/stream') {
      return sseResponse([{ kind: 'status-update', taskId: 'task-1', status: { state: 'working' }, final: false }]);
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

  const output = await manyfold.callMfAgent(environment(), 'agt_success', 'prompt', {
    attempts: 1,
    timeoutMs: 5_000,
    trace: {
      agent: 'sum',
      emit(event) { traces.push(event); },
    },
  });
  assert.equal(output, 'completed asynchronously');
  // The whole point: one send, then follow the task that send accepted.
  assert.deepEqual(methods, ['message/stream', 'tasks/get']);
  assert.ok(traces.some(trace => trace.content?.includes('stream ended before')));
});

test('surfaces the remote task failure reason without hiding it', async t => {
  mockFetch(t, async () => sseResponse([{
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
  }]));

  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_success', 'prompt', { attempts: 1 }),
    /task failed: gemini exited 1: SyntaxError: Unexpected end of JSON input/,
  );
});

test('refuses to start a call once the stage budget is gone', async t => {
  let requestCount = 0;
  mockFetch(t, async () => {
    requestCount += 1;
    return jsonResponse({});
  });

  const error = await manyfold
    .callMfAgent(environment(), 'agt_success', 'prompt', {
      attempts: 2,
      deadlineAt: Date.now() - 1_000,
    })
    .then(() => null, e => e);

  assert.match(error.message, /time budget was exhausted/);
  assert.equal(manyfold.isBudgetExhaustedError(error), true);
  assert.equal(requestCount, 0, 'an agent must not be called with no budget left');
});

test('blames the budget, not the agent, when the deadline shortened the attempt', async t => {
  // The deadline is closer than the 240s timeout, so this failure happened
  // inside a window the orchestrator itself cut short. Reporting it as an agent
  // failure would send the whole workflow into a second 12-minute attempt.
  mockFetch(t, async () => new Response('upstream busy', { status: 503 }));

  const error = await manyfold
    .callMfAgent(environment(), 'agt_success', 'prompt', {
      attempts: 1,
      deadlineAt: Date.now() + 6_000,
    })
    .then(() => null, e => e);

  assert.equal(manyfold.isBudgetExhaustedError(error), true);
  assert.match(error.message, /ran out of this stage's time budget/);
});

test('an agent failure with budget to spare stays an agent failure', async t => {
  mockFetch(t, async () => new Response('upstream busy', { status: 503 }));

  const error = await manyfold
    .callMfAgent(environment(), 'agt_success', 'prompt', {
      attempts: 1,
      timeoutMs: 10_000,
      deadlineAt: Date.now() + 600_000,
    })
    .then(() => null, e => e);

  assert.equal(manyfold.isBudgetExhaustedError(error), false);
});

test('reports invalid RPC JSON responses precisely', async t => {
  let requestCount = 0;
  mockFetch(t, async () => {
    requestCount += 1;
    return new Response('{"result":', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_success', 'prompt', { attempts: 1 }),
    /returned invalid JSON/,
  );
  assert.equal(requestCount, 1);
});

test('stops before exceeding the shared Free Workers A2A request budget', async t => {
  let requestCount = 0;
  mockFetch(t, async () => {
    requestCount += 1;
    return jsonResponse({});
  });

  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_success', 'prompt', {
      attempts: 1,
      requestBudget: { remaining: 0 },
    }),
    /Free Workers A2A subrequest budget exhausted before opening a stream/,
  );
  assert.equal(requestCount, 0);
});

test('stops recovering an accepted task once the subrequest budget runs out', async t => {
  const methods = [];
  mockFetch(t, async (url, init = {}) => {
    methods.push(JSON.parse(init.body).method);
    return sseResponse([{ kind: 'status-update', taskId: 'task-2', status: { state: 'working' }, final: false }]);
  });

  const budget = { remaining: 1 };
  await assert.rejects(
    manyfold.callMfAgent(environment(), 'agt_success', 'prompt', {
      attempts: 1,
      timeoutMs: 5_000,
      requestBudget: budget,
    }),
    /exhausted before recovering accepted task/,
  );
  // The stream spent the last subrequest, so recovery could not even start.
  assert.deepEqual(methods, ['message/stream']);
});

/* ───────── credential failures are terminal under the connect model ───────── */

test('a role with no assigned agent fails immediately and is not a budget problem', async t => {
  let requestCount = 0;
  mockFetch(t, async () => {
    requestCount += 1;
    return jsonResponse({});
  });

  const error = await manyfold
    .callMfAgent(environment(), '', 'prompt', { attempts: 3 })
    .then(() => null, e => e);

  assert.match(error.message, /no Manyfold agent assigned/);
  assert.equal(manyfold.isReconnectRequiredError(error), true);
  assert.equal(manyfold.isBudgetExhaustedError(error), false);
  assert.equal(requestCount, 0);
});

test('an expired authorization fails before any request is made', async t => {
  let requestCount = 0;
  mockFetch(t, async () => {
    requestCount += 1;
    return jsonResponse({});
  });

  const env = environment([{
    agentId: 'agt_stale',
    name: 'Stale agent',
    rpcUrl: RPC_URL,
    token: 'expired-token',
    expiresAt: Date.now() - 1_000,
  }]);
  const error = await manyfold
    .callMfAgent(env, 'agt_stale', 'prompt', { attempts: 3 })
    .then(() => null, e => e);

  assert.match(error.message, /expired/);
  assert.equal(manyfold.isReconnectRequiredError(error), true);
  assert.equal(requestCount, 0);
});

test('a rejected token ends the call instead of retrying a credential nothing can refresh', async t => {
  let requestCount = 0;
  mockFetch(t, async () => {
    requestCount += 1;
    return new Response('token rejected', { status: 401 });
  });

  const error = await manyfold
    .callMfAgent(environment(), 'agt_success', 'prompt', { attempts: 3 })
    .then(() => null, e => e);

  // The peer-mint model re-minted on 401. There is nothing to re-mint now, so
  // retrying would only burn the run's budget against a dead credential.
  assert.equal(requestCount, 1);
  assert.equal(manyfold.isReconnectRequiredError(error), true);
  assert.match(error.message, /Reconnect it on \/settings/);
});
