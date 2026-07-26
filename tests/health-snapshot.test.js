'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let healthSnapshot;

test.before(async () => {
  healthSnapshot = await import('../src/routes/health-snapshot.ts');
});

test('accepts a recent health snapshot within the two-hour window', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  const snapshot = {
    checkedAt: '2026-07-26T10:00:00.000Z',
    up: 6,
    total: 6,
  };
  assert.deepEqual(
    healthSnapshot.parseFreshHealthSnapshot(JSON.stringify(snapshot), now),
    snapshot,
  );
});

test('rejects stale, malformed, and implausibly future health snapshots', () => {
  const now = Date.parse('2026-07-26T12:00:00.000Z');
  assert.equal(healthSnapshot.parseFreshHealthSnapshot(JSON.stringify({
    checkedAt: '2026-07-26T09:59:59.999Z',
  }), now), null);
  assert.equal(healthSnapshot.parseFreshHealthSnapshot('{"checkedAt":', now), null);
  assert.equal(healthSnapshot.parseFreshHealthSnapshot(JSON.stringify({
    checkedAt: 'not-a-date',
  }), now), null);
  assert.equal(healthSnapshot.parseFreshHealthSnapshot(JSON.stringify({
    checkedAt: '2026-07-26T12:05:00.001Z',
  }), now), null);
  assert.equal(healthSnapshot.parseFreshHealthSnapshot('[]', now), null);
});
