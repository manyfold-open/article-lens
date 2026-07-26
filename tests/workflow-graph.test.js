'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let graphModule;
test.before(async () => {
  graphModule = await import('../src/crew/graph.ts');
});

function edgeSignatures(plan) {
  return plan.edges
    .map(edge => `${edge.kind}:${edge.from}->${edge.to}`)
    .sort();
}

test('builds the default parallel role DAG', () => {
  const plan = graphModule.buildWorkflowPlan('analysis-1', 1, 2, null);
  assert.deepEqual(plan.nodes.map(node => node.id), ['input', 'sum', 'jargon', 'comments', 'ctx', 'synth', 'report']);
  assert.deepEqual(edgeSignatures(plan), [
    'dependency:comments->ctx',
    'dependency:ctx->synth',
    'dependency:input->comments',
    'dependency:input->jargon',
    'dependency:input->sum',
    'dependency:jargon->ctx',
    'dependency:sum->ctx',
    'dependency:synth->report',
  ]);
  assert.equal(plan.attempt, 1);
  assert.equal(plan.max_attempts, 2);
});

test('normalizes relay order and ignores duplicate group membership', () => {
  const plan = graphModule.buildWorkflowPlan('analysis-1', 1, 2, {
    v: 2,
    groups: [
      { members: ['sum', 'jargon'], mode: 'relay' },
      { members: ['jargon', 'comments'], mode: 'parallel' },
    ],
  });
  assert.ok(plan.edges.some(edge => edge.from === 'sum' && edge.to === 'jargon' && edge.kind === 'relay'));
  assert.deepEqual(plan.groups, [
    { members: ['sum', 'jargon'], mode: 'relay' },
    { members: ['comments'], mode: 'parallel' },
  ]);
});

test('retains effort, replicas, debate, disabled nodes, and audience metadata', () => {
  const plan = graphModule.buildWorkflowPlan('analysis-1', 1, 2, {
    v: 2,
    nodes: {
      sum: { effort: 'high', replicas: 9 },
      jargon: { enabled: false, effort: 'low' },
    },
    debate: true,
    audience: 'expert',
  });
  assert.equal(plan.nodes.find(node => node.id === 'sum').replicas, 3);
  assert.equal(plan.nodes.find(node => node.id === 'sum').effort, 'high');
  assert.equal(plan.nodes.find(node => node.id === 'jargon').enabled, false);
  assert.equal(plan.nodes.find(node => node.id === 'ctx').debate, true);
  assert.equal(plan.audience, 'expert');
});

test('builds explicit conditional edges for escalate go/stop decisions', () => {
  const plan = graphModule.buildWorkflowPlan('analysis-1', 1, 2, { v: 2, escalate: true });
  const conditional = plan.edges.filter(edge => edge.kind === 'conditional');
  assert.deepEqual(conditional.map(edge => `${edge.from}->${edge.to}`).sort(), ['ctx->comments', 'ctx->jargon']);
  assert.ok(plan.edges.some(edge => edge.from === 'sum' && edge.to === 'ctx'));
  assert.equal(plan.escalate, true);
});

test('normalizes untrusted graph values and preserves legacy enabled flags', () => {
  const normalized = graphModule.normalizeGraph({
    v: 2,
    nodes: {
      sum: { effort: 'ultra', replicas: 0 },
      jargon: { effort: null, replicas: 99 },
      comments: { effort: 'high', replicas: 2.9 },
    },
    groups: [
      null,
      { members: ['unknown', 'sum', 'sum'], mode: 'unexpected' },
      { members: 'comments', mode: 'relay' },
    ],
  });
  assert.deepEqual(normalized.effort, {
    sum: 'med',
    jargon: 'med',
    comments: 'high',
  });
  assert.deepEqual(normalized.replicas, {
    sum: 1,
    jargon: 3,
    comments: 2,
  });
  assert.deepEqual(normalized.groups, [
    { members: ['sum'], mode: 'parallel' },
  ]);

  const legacy = graphModule.normalizeGraph({
    v: 1,
    enabled: { jargon: false, ctx: false },
  });
  assert.deepEqual(legacy.enabled, { jargon: false, ctx: false });
});
