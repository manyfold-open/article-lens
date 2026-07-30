'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let createRunBudget;
let stageDeadline;

test.before(async () => {
  ({ createRunBudget, stageDeadline } = await import('../src/crew/budget.ts'));
});

const START = 1_000_000;
const TOTAL = 12 * 60_000;

test('every stage leaves the reserves the later stages need', () => {
  const budget = createRunBudget(START, TOTAL);
  assert.equal(budget.deadlineAt, START + TOTAL);
  // stage 1 stops early enough for one 小導 call plus 統整.
  assert.equal(stageDeadline(budget, 'stage1'), budget.deadlineAt - 150_000 - 90_000);
  // 小導 only has to leave room for 統整.
  assert.equal(stageDeadline(budget, 'ctx'), budget.deadlineAt - 90_000);
  // 統整 is last, so it owns the rest of the run.
  assert.equal(stageDeadline(budget, 'synth'), budget.deadlineAt);
});

test('later stages always get a strictly later deadline', () => {
  const budget = createRunBudget(START, TOTAL);
  const stage1 = stageDeadline(budget, 'stage1');
  const ctx = stageDeadline(budget, 'ctx');
  const synth = stageDeadline(budget, 'synth');
  assert.ok(stage1 < ctx, 'stage 1 must not be able to spend 小導 reserve');
  assert.ok(ctx < synth, '小導 must not be able to spend 統整 reserve');
});

test('辯論裁定 widens the verdict reserve at stage 1 expense', () => {
  const plain = createRunBudget(START, TOTAL);
  const debate = createRunBudget(START, TOTAL, { debate: true });
  assert.ok(debate.ctxReserveMs > plain.ctxReserveMs);
  assert.ok(stageDeadline(debate, 'stage1') < stageDeadline(plain, 'stage1'));
  // Debate needs a second sequential round: pro/con in parallel, then merge.
  assert.ok(debate.ctxReserveMs >= 2 * 150_000 - 1);
  // 統整's floor is untouched by the debate flag.
  assert.equal(stageDeadline(debate, 'ctx'), stageDeadline(plain, 'ctx'));
});

test('a run with less time than its reserves puts stage 1 in the past', () => {
  // Nothing crashes: the transport sees a deadline it cannot meet and reports a
  // budget-exhausted call, which degrades that stage instead of failing the job.
  const budget = createRunBudget(START, 60_000);
  assert.ok(stageDeadline(budget, 'stage1') < START);
});
