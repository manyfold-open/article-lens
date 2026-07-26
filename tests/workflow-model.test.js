'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WorkflowModel = require('../public/workflow-model.js');

const labels = id => ({ zh: id, en: id });
const baseNodes = [
  { id: 'input', kind: 'source', label: labels('Input'), enabled: true },
  { id: 'sum', kind: 'agent', label: labels('Summary'), enabled: true, effort: 'med', replicas: 1 },
  { id: 'jargon', kind: 'agent', label: labels('Jargon'), enabled: true, effort: 'med', replicas: 1 },
  { id: 'comments', kind: 'agent', label: labels('Comments'), enabled: true, effort: 'med', replicas: 1 },
  { id: 'ctx', kind: 'agent', label: labels('Context'), enabled: true },
  { id: 'synth', kind: 'agent', label: labels('Synth'), enabled: true },
  { id: 'report', kind: 'sink', label: labels('Report'), enabled: true },
];

function plan(overrides = {}) {
  return {
    event: 'workflow_plan',
    analysis_id: 'analysis-1',
    attempt: 1,
    max_attempts: 2,
    nodes: baseNodes.map(node => ({
      ...node,
      label: { ...node.label },
    })),
    edges: [
      { id: 'input-sum', from: 'input', to: 'sum', kind: 'dependency' },
      { id: 'sum-ctx', from: 'sum', to: 'ctx', kind: 'dependency' },
      { id: 'ctx-synth', from: 'ctx', to: 'synth', kind: 'dependency' },
      { id: 'synth-report', from: 'synth', to: 'report', kind: 'dependency' },
    ],
    groups: [],
    escalate: false,
    debate: false,
    ...overrides,
  };
}

function envelope(seq, data) {
  return { seq, data: { at: `2026-07-25T12:00:${String(seq).padStart(2, '0')}.000Z`, ...data } };
}

test('stores the backend default DAG without guessing its topology', () => {
  const state = WorkflowModel.createState('analysis-1');
  WorkflowModel.applyEnvelope(state, envelope(1, plan()));
  const attempt = WorkflowModel.currentAttempt(state);
  assert.equal(attempt.plan.edges.length, 4);
  assert.equal(attempt.nodes.input.state, 'success');
  assert.equal(attempt.nodes.sum.config.effort, 'med');
});

test('keeps relay, replicas, debate, and conditional escalation metadata', () => {
  const state = WorkflowModel.createState('analysis-1');
  const nodes = baseNodes.map(node => node.id === 'sum' ? { ...node, replicas: 3 } : node.id === 'ctx' ? { ...node, debate: true } : node);
  WorkflowModel.applyEnvelope(state, envelope(1, plan({
    nodes,
    groups: [{ members: ['sum', 'jargon'], mode: 'relay' }],
    edges: [{ id: 'relay', from: 'sum', to: 'jargon', kind: 'relay' }],
    debate: true,
  })));
  const attempt = WorkflowModel.currentAttempt(state);
  assert.equal(attempt.plan.groups[0].mode, 'relay');
  assert.equal(attempt.nodes.sum.config.replicas, 3);
  assert.equal(attempt.nodes.ctx.config.debate, true);

  WorkflowModel.applyEnvelope(state, envelope(2, { event: 'escalate', decision: 'stop', reason: 'worth_reading=low' }));
  assert.equal(attempt.escalateDecision.decision, 'stop');
});

test('maps cache, skipped, fallback, error, and successful node states from machine modes', () => {
  const state = WorkflowModel.createState('analysis-1');
  WorkflowModel.applyEnvelope(state, envelope(1, plan()));
  WorkflowModel.applyEnvelope(state, envelope(2, { event: 'status', agent: 'sum', state: 'done', mode: 'cache', label: labels('cached') }));
  WorkflowModel.applyEnvelope(state, envelope(3, { event: 'status', agent: 'jargon', state: 'done', mode: 'skipped', label: labels('skipped') }));
  WorkflowModel.applyEnvelope(state, envelope(4, { event: 'status', agent: 'comments', state: 'done', mode: 'fallback', label: labels('fallback') }));
  WorkflowModel.applyEnvelope(state, envelope(5, { event: 'status', agent: 'ctx', state: 'done', mode: 'real', label: labels('done') }));
  WorkflowModel.applyEnvelope(state, envelope(6, { event: 'error', agent: 'synth', message: 'runtime unavailable' }));
  WorkflowModel.applyEnvelope(state, envelope(7, {
    event: 'result',
    data: {
      flags: {
        agent_sources: {
          sum: { mode: 'real' },
          jargon: { mode: 'skipped' },
          comments: { mode: 'fallback' },
          ctx: { mode: 'real' },
        },
      },
    },
  }));
  const nodes = WorkflowModel.currentAttempt(state).nodes;
  assert.deepEqual(
    ['sum', 'jargon', 'comments', 'ctx', 'synth'].map(id => nodes[id].state),
    ['cache', 'skipped', 'fallback', 'success', 'error'],
  );
});

test('isolates whole-workflow attempts while retaining A2A retries within a call', () => {
  const state = WorkflowModel.createState('analysis-1');
  WorkflowModel.applyEnvelope(state, envelope(1, { event: 'workflow_state', analysis_id: 'analysis-1', attempt: 1, max_attempts: 2, state: 'running' }));
  WorkflowModel.applyEnvelope(state, envelope(2, plan()));
  WorkflowModel.applyEnvelope(state, envelope(3, {
    event: 'agent_trace', agent: 'sum', call_id: 'call-a', phase: 'input', attempt: 1, label: labels('input'), content: 'prompt',
  }));
  WorkflowModel.applyEnvelope(state, envelope(4, {
    event: 'agent_trace', agent: 'sum', call_id: 'call-a', phase: 'error', attempt: 1, will_retry: true, label: labels('retry'), content: 'timeout',
  }));
  WorkflowModel.applyEnvelope(state, envelope(5, {
    event: 'agent_trace', agent: 'sum', call_id: 'call-a', phase: 'output', attempt: 2, label: labels('output'), content: '{}',
  }));
  WorkflowModel.applyEnvelope(state, envelope(6, { event: 'retry', attempt: 2, max_attempts: 2, delay_seconds: 10, reason: 'critical fallback' }));
  WorkflowModel.applyEnvelope(state, envelope(7, { event: 'workflow_state', analysis_id: 'analysis-1', attempt: 2, max_attempts: 2, state: 'running' }));
  WorkflowModel.applyEnvelope(state, envelope(8, plan({ attempt: 2 })));

  assert.equal(state.attempts[1].calls['sum:call-a'].transportAttempts, 2);
  assert.equal(state.attempts[1].state, 'retry_wait');
  assert.equal(state.attempts[2].state, 'running');
  assert.notEqual(state.attempts[1].nodes, state.attempts[2].nodes);
});

test('deduplicates cursors, sorts out-of-order recovery, and tolerates old missing timestamps', () => {
  const state = WorkflowModel.createState('analysis-1');
  WorkflowModel.applySnapshot(state, {
    analysis_id: 'analysis-1',
    phase: 'running',
    cursor: 4,
    events: [
      { seq: 4, data: { event: 'usage', agent: 'sum', tokens: 20 } },
      { seq: 2, data: plan() },
      { seq: 3, data: { event: 'usage', agent: 'sum', tokens: 10 } },
      { seq: 3, data: { event: 'usage', agent: 'sum', tokens: 10 } },
    ],
    updated_at: '2026-07-25T12:01:00.000Z',
  }, '2026-07-25T12:02:00.000Z');
  const attempt = WorkflowModel.currentAttempt(state);
  assert.equal(state.cursor, 4);
  assert.equal(attempt.usage.total, 30);
  assert.equal(attempt.nodes.sum.tokens, 30);
  assert.ok(state.updatedAt);
});

test('restores a terminal snapshot even when the result event was compacted away', () => {
  const state = WorkflowModel.createState('analysis-1');
  const result = {
    flags: {
      fallback_agents: ['comments'],
      skipped_agents: ['jargon'],
      agent_sources: {
        sum: { mode: 'real' },
        ctx: { mode: 'cache' },
      },
    },
  };
  WorkflowModel.applySnapshot(state, {
    analysis_id: 'analysis-1',
    phase: 'done',
    cursor: 2,
    events: [
      envelope(1, plan()),
      envelope(2, {
        event: 'workflow_state',
        analysis_id: 'analysis-1',
        attempt: 1,
        max_attempts: 2,
        state: 'done',
      }),
    ],
    result,
    updated_at: '2026-07-25T12:01:00.000Z',
  });

  const attempt = WorkflowModel.currentAttempt(state);
  assert.equal(state.phase, 'done');
  assert.equal(state.result, result);
  assert.equal(attempt.nodes.sum.state, 'success');
  assert.equal(attempt.nodes.jargon.state, 'skipped');
  assert.equal(attempt.nodes.comments.state, 'fallback');
  assert.equal(attempt.nodes.ctx.state, 'cache');
  assert.equal(attempt.nodes.report.state, 'success');
});

test('keeps terminal workflow failures separate from per-agent errors', () => {
  const state = WorkflowModel.createState('analysis-1');
  WorkflowModel.applyEnvelope(state, envelope(1, {
    event: 'workflow_state',
    analysis_id: 'analysis-1',
    attempt: 1,
    max_attempts: 2,
    state: 'running',
  }));
  WorkflowModel.applyEnvelope(state, envelope(2, {
    event: 'error',
    agent: 'sum',
    message: 'summarizer failed',
  }));
  assert.equal(state.error, '');
  assert.equal(state.attempts[1].nodes.sum.error, 'summarizer failed');

  WorkflowModel.applyEnvelope(state, envelope(3, {
    event: 'workflow_state',
    analysis_id: 'analysis-1',
    attempt: 1,
    max_attempts: 2,
    state: 'error',
    reason: 'workflow exhausted retries',
  }));
  assert.equal(state.phase, 'error');
  assert.equal(state.error, 'workflow exhausted retries');
  assert.equal(state.attempts[1].state, 'error');
  assert.ok(state.attempts[1].endedAt);
});

test('returns timeline calls in chronological order across workflow attempts', () => {
  const state = WorkflowModel.createState('analysis-1');
  WorkflowModel.applyEvent(state, {
    event: 'workflow_state',
    attempt: 1,
    state: 'running',
    at: '2026-07-25T12:00:00.000Z',
  });
  WorkflowModel.applyEvent(state, {
    event: 'agent_trace',
    agent: 'sum',
    call_id: 'later',
    phase: 'input',
    content: 'attempt one',
    at: '2026-07-25T12:00:05.000Z',
  });
  WorkflowModel.applyEvent(state, {
    event: 'workflow_state',
    attempt: 2,
    state: 'running',
    at: '2026-07-25T12:00:10.000Z',
  });
  WorkflowModel.applyEvent(state, {
    event: 'agent_trace',
    agent: 'ctx',
    call_id: 'latest',
    phase: 'input',
    content: 'attempt two',
    at: '2026-07-25T12:00:11.000Z',
  });

  assert.deepEqual(
    WorkflowModel.calls(state).map(call => [call.callId, call.workflowAttempt]),
    [['later', 1], ['latest', 2]],
  );
});
