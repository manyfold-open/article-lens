'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let selectComments;
let commentsWereSampled;

test.before(async () => {
  ({ selectComments, commentsWereSampled } = await import('../src/crew/comments.ts'));
});

const comment = (id, text, children = []) => ({
  id,
  author: `u${id}`,
  text,
  created_at: '2026-07-01T00:00:00Z',
  children,
});
const story = children => ({ id: 999, title: 'story', children });

test('keeps thread structure so replies stay attached to their parent', () => {
  const item = story([
    comment(1, 'the original claim', [
      comment(2, 'a direct reply', [comment(3, 'a reply to the reply')]),
    ]),
  ]);
  const selection = selectComments(item, 10_000);
  assert.equal(selection.text, [
    '[id:1] u1: the original claim',
    '  ↳ [id:2] u2: a direct reply',
    '    ↳ [id:3] u3: a reply to the reply',
  ].join('\n'));
  assert.deepEqual(
    { included: selection.included, total: selection.total, threads: selection.threads },
    { included: 3, total: 3, threads: 1 },
  );
  assert.equal(commentsWereSampled(item, 10_000), false);
});

test('spends the budget on every thread opener before any replies', () => {
  // Thread A outranks B (longer opener plus a reply), but B's stance must still
  // reach 小潛 — camps come from distinct top-level opinions.
  const item = story([
    comment(1, 'a'.repeat(200), [comment(2, 'b'.repeat(200))]),
    comment(3, 'c'.repeat(50)),
  ]);
  const selection = selectComments(item, 120);
  assert.equal(selection.threads, 2);
  assert.equal(selection.included, 2);
  assert.equal(selection.total, 3);
  assert.match(selection.text, /\[id:1\]/);
  assert.match(selection.text, /\[id:3\]/);
  assert.doesNotMatch(selection.text, /↳/);
  assert.equal(commentsWereSampled(item, 120), true);
});

test('ignores comments with no text and reports the real total', () => {
  const item = story([
    comment(1, 'has text'),
    comment(2, null),
    comment(3, '   '),
  ]);
  const selection = selectComments(item, 10_000);
  assert.equal(selection.total, 1);
  assert.equal(selection.included, 1);
  assert.equal(commentsWereSampled(item, 10_000), false);
});

test('returns the same selection for one item and budget', () => {
  // The prompt, the sampling flag, and the provenance reason each ask for this
  // selection; they must not be able to disagree.
  const item = story([comment(1, 'only comment')]);
  assert.equal(selectComments(item, 2600), selectComments(item, 2600));
});
