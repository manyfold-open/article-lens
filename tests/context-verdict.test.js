'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let parseContextVerdict;

test.before(async () => {
  ({ normalizeContextVerdict: parseContextVerdict } = await import('../src/crew/verdict.ts'));
});

test('accepts the compact verdict shape requested by the prompt', () => {
  assert.deepEqual(parseContextVerdict({
    worth_reading: 'high',
    why_frontpage: '這篇提出了可實作的新方法。',
    tier: 'deep',
  }).verdict, {
    worth_reading: 'high',
    why_frontpage: { zh: '這篇提出了可實作的新方法。', en: '' },
    tier: 'deep',
  });
});

test('accepts wrapped verdicts and common equivalent field names', () => {
  assert.equal(parseContextVerdict({
    verdict: {
      worthReading: 'medium',
      why: { text: '有趣但需要背景知識。' },
      reading_tier: '1min',
    },
  }).verdict.why_frontpage.zh, '有趣但需要背景知識。');
});

test('reports the contract failure instead of hiding it behind fallback', () => {
  const result = parseContextVerdict({ worth_reading: 'high' });
  assert.equal(result.verdict, null);
  assert.match(result.reason, /why_frontpage/);
});
