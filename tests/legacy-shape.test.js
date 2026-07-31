import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as crew from '../src/crew/legacy.ts';

// Every user-facing field was a `{en, zh}` object before the language collapse.
// Two stores still hand those back for a while: the seven-day result cache and a
// Durable Object's retained result (24 hours). The renderers interpolate these
// fields directly, so an uncoerced object reaches the reader as the literal text
// "[object Object]" — measurably worse than the mixed language the collapse set
// out to remove, and it is what happened before this coercion existed.
function legacyResult() {
  return {
    item_id: 1,
    spec_version: 14,
    type: 'article',
    title: { en: '', zh: '标题' },
    url: 'https://example.com',
    meta: { points: 10, comments: 2, author: 'a', age: '' },
    verdict: { worth_reading: 'high', why_frontpage: { en: '', zh: '值得读' }, tier: '1min' },
    jargon: [
      { term: 'HNSW', zh_term: '索引', explain: { en: '', zh: '一种索引' }, seen_in: 'article', appeared_as: 'using HNSW' },
    ],
    summary: { tldr: { en: '', zh: '摘要' }, key_points: [{ en: '', zh: '重点一' }] },
    comment_digest: {
      overview: { en: '', zh: '轮廓' },
      camps: [{ label: { en: '', zh: '主派' }, stance: { en: '', zh: '立场' }, weight: 'majority', quote: 'verbatim', comment_id: 7 }],
      consensus: { en: '', zh: '共识' },
      disputes: [{ en: '', zh: '争议' }],
      expert_corrections: [{ correction: { en: '', zh: '更正' }, comment_id: 8 }],
      spicy: [{ quote: 'the spicy quote', zh: '辣评注解', comment_id: 9 }],
    },
    flags: {
      low_confidence: false,
      comments_sampled: false,
      agent_sources: { sum: { mode: 'cache', reason: { en: '', zh: '来自缓存' } } },
    },
    briefing: {
      route: { en: '', zh: '路线' },
      assignments: [{ agent: 'sum', action: 'run', reason: { en: '', zh: '理由' } }],
    },
    editor_note: { en: '', zh: '编辑注记' },
  };
}

test('coerces every former BiStr field on a legacy result to a string', () => {
  const r = crew.coerceLegacyResult(legacyResult());
  const strings = [
    r.title,
    r.editor_note,
    r.verdict.why_frontpage,
    r.summary.tldr,
    ...r.summary.key_points,
    ...r.jargon.map(t => t.explain),
    r.comment_digest.overview,
    r.comment_digest.consensus,
    ...r.comment_digest.camps.flatMap(c => [c.label, c.stance]),
    ...r.comment_digest.disputes,
    ...r.comment_digest.expert_corrections.map(e => e.correction),
    ...r.comment_digest.spicy.map(s => s.note),
    r.briefing.route,
    ...r.briefing.assignments.map(a => a.reason),
    r.flags.agent_sources.sum.reason,
  ];
  for (const value of strings) {
    assert.equal(typeof value, 'string', `expected a string, received ${JSON.stringify(value)}`);
    assert.doesNotMatch(String(value), /\[object Object\]/);
  }
  // A zh-only legacy value keeps its text: the reader gets the language it was
  // written in, which beats an empty card.
  assert.equal(r.summary.tldr, '摘要');
});

// The spicy remark was named `zh` while it was written in Chinese, and it was
// never a translation of the quote beside it. A legacy entry has to keep it.
test('carries a legacy spicy `zh` remark over to `note`', () => {
  const r = crew.coerceLegacyResult(legacyResult());
  assert.equal(r.comment_digest.spicy[0].note, '辣评注解');
  assert.equal(r.comment_digest.spicy[0].quote, 'the spicy quote');
});

// Coercion is an explicit field walk rather than a deep traversal, because these
// three are verbatim source data that must survive untouched.
test('leaves quotes, source phrases and comment ids exactly as they were', () => {
  const r = crew.coerceLegacyResult(legacyResult());
  assert.equal(r.comment_digest.camps[0].quote, 'verbatim');
  assert.equal(r.comment_digest.camps[0].comment_id, 7);
  assert.equal(r.jargon[0].appeared_as, 'using HNSW');
  assert.equal(r.comment_digest.expert_corrections[0].comment_id, 8);
});

test('leaves an already-collapsed result alone and tolerates a missing one', () => {
  const modern = {
    title: 'A title',
    summary: { tldr: 'A tldr', key_points: ['One'] },
    jargon: [{ term: 'RAG', explain: 'An explanation' }],
    comment_digest: { overview: 'An overview', camps: [], consensus: '', disputes: [], expert_corrections: [], spicy: [] },
    verdict: { worth_reading: 'high', why_frontpage: 'Because', tier: '1min' },
    flags: {},
  };
  const r = crew.coerceLegacyResult(modern);
  assert.equal(r.title, 'A title');
  assert.equal(r.summary.key_points[0], 'One');
  assert.equal(r.jargon[0].explain, 'An explanation');
  assert.equal(crew.coerceLegacyResult(null), null);
  assert.equal(crew.coerceLegacyResult(undefined), undefined);
});

test('coerces a partial cache hit, which is passed into the crew rather than replayed', () => {
  const legacy = legacyResult();
  const shared = crew.coerceLegacyShared({
    summary: legacy.summary,
    comment_digest: legacy.comment_digest,
    verdict: legacy.verdict,
  });
  assert.equal(typeof shared.summary.tldr, 'string');
  assert.equal(typeof shared.verdict.why_frontpage, 'string');
  assert.equal(typeof shared.comment_digest.camps[0].label, 'string');
  const jargon = crew.coerceLegacyJargon(legacy.jargon);
  assert.equal(typeof jargon[0].explain, 'string');
});

// The Worker coerces what it reads from its own cache, but the browser cannot
// assume the Worker wrote what it is handed: a Durable Object retains a result
// for 24 hours and replays it verbatim on reload, ahead of any cache read.
test('the browser coerces both entry points, not just the result event', () => {
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /currentResult = coerceLegacyResult\(ev\.data\)/);
  assert.match(app, /ev\.data = coerceLegacySection\(ev\.agent, ev\.data\)/);
  assert.match(app, /function coerceLegacyResult\(/);
  assert.match(app, /function coerceLegacySection\(/);
  // Interpolated directly by the renderers, so these must not stay objects.
  assert.match(app, /s\.tldr = textOf\(s\.tldr\)/);
  assert.match(app, /note: textOf\(x\.note \?\? x\.zh\)/);
});
