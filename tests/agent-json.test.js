'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let json;

test.before(async () => {
  json = await import('../src/crew/json.ts');
});

test('extracts JSON from fenced model output and surrounding commentary', () => {
  const fenced = [
    'Here is the result:',
    '```json',
    '{"worth_reading":"high","tier":"deep"}',
    '```',
    'Done.',
  ].join('\n');
  assert.equal(json.extractJSON(fenced), '{"worth_reading":"high","tier":"deep"}');
  assert.deepEqual(json.parseLoose(fenced), {
    worth_reading: 'high',
    tier: 'deep',
  });
});

test('repairs unescaped inner quotes commonly returned in Chinese text', () => {
  const output = '{"tldr":{"zh":"这与"开源"有别"},"key_points":[]}';
  assert.deepEqual(json.parseLoose(output), {
    tldr: { zh: '这与"开源"有别' },
    key_points: [],
  });
});

test('parses arrays and keeps braces that belong to string values', () => {
  const output = 'prefix [{"term":"RAG","explain":{"zh":"检索 {文档} 后生成"}}] suffix';
  assert.deepEqual(json.parseLoose(output), [
    { term: 'RAG', explain: { zh: '检索 {文档} 后生成' } },
  ]);
});

test('returns null for truncated or non-JSON agent output', () => {
  assert.equal(json.parseLoose('{"summary":{"zh":"unfinished'), null);
  assert.equal(json.parseLoose('gemini exited 1: no JSON output'), null);
  assert.equal(json.parseLoose(''), null);
});

// parseLoose collapses every failure to null, but the fixes differ: a cut-off
// response means the role wrote too much for its output cap, while prose means
// the prompt or format is not landing. 小词 has the longest structured output
// of any role, so it is the one that needs the two told apart.
test('classifies a cut-off response as truncated, not as a format failure', () => {
  assert.equal(json.classifyUnparseable('{"summary":{"zh":"unfinished'), 'truncated');
  assert.equal(json.classifyUnparseable('[{"term":"RAG","explain":{"zh":"检索后生'), 'truncated');
  // A fence the model never closed is still a cut-off response.
  assert.equal(json.classifyUnparseable('```json\n[{"term":"RAG"'), 'truncated');
});

test('classifies prose and empty output separately from truncation', () => {
  assert.equal(json.classifyUnparseable('gemini exited 1: no JSON output'), 'not_json');
  assert.equal(json.classifyUnparseable('I could not find any jargon in this article.'), 'not_json');
  assert.equal(json.classifyUnparseable(''), 'empty');
  assert.equal(json.classifyUnparseable('   '), 'empty');
});

test('reports no classification for output that actually parses', () => {
  assert.equal(json.classifyUnparseable('[{"term":"RAG"}]'), null);
  assert.equal(json.classifyUnparseable('```json\n{"jargon":[]}\n```'), null);
});

test('UnparseableOutputError carries the classification and window counts', () => {
  const err = new json.UnparseableOutputError('truncated', { returned: 2, parsed: 0 });
  assert.equal(json.isUnparseableOutputError(err), true);
  assert.equal(err.classification, 'truncated');
  assert.deepEqual(err.windows, { returned: 2, parsed: 0 });
  // The message has to say which of the two it was, because this string is what
  // reaches the reader and the logs.
  assert.match(err.message, /truncated/);
});

test('does not mistake an ordinary error for an unparseable-output failure', () => {
  assert.equal(json.isUnparseableOutputError(new Error('peer timed out')), false);
  assert.equal(json.isUnparseableOutputError(null), false);
});
