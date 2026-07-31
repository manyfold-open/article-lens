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

test('repairs unescaped inner quotes, which roles emit despite being asked not to', () => {
  const output = '{"tldr":"this is "open source" but not as you know it","key_points":[]}';
  assert.deepEqual(json.parseLoose(output), {
    tldr: 'this is "open source" but not as you know it',
    key_points: [],
  });
});

// The repair decides by JSON structure, not by the characters either side, so a
// quote the model leaves in a verbatim excerpt is escaped whatever the source
// article is written in. The earlier rule keyed off letter-to-letter adjacency
// and so only ever fired on the second of these two.
test('repairs an inner quote whether or not it is space-separated', () => {
  assert.deepEqual(json.parseLoose('{"quote":"he said "no" twice"}'), { quote: 'he said "no" twice' });
  assert.deepEqual(json.parseLoose('{"quote":"a"b"c"}'), { quote: 'a"b"c' });
});

test('parses arrays and keeps braces that belong to string values', () => {
  const output = 'prefix [{"term":"RAG","explain":"retrieves {documents} then generates"}] suffix';
  assert.deepEqual(json.parseLoose(output), [
    { term: 'RAG', explain: 'retrieves {documents} then generates' },
  ]);
});

test('returns null for truncated or non-JSON agent output', () => {
  assert.equal(json.parseLoose('{"summary":"unfinished'), null);
  assert.equal(json.parseLoose('gemini exited 1: no JSON output'), null);
  assert.equal(json.parseLoose(''), null);
});

// parseLoose collapses every failure to null, but the fixes differ: a cut-off
// response means the role wrote too much for its output cap, while prose means
// the prompt or format is not landing. Jargon has the longest structured output
// of any role, so it is the one that needs the two told apart.
test('classifies a cut-off response as truncated, not as a format failure', () => {
  assert.equal(json.classifyUnparseable('{"summary":"unfinished'), 'truncated');
  assert.equal(json.classifyUnparseable('[{"term":"RAG","explain":"retrieves then gen'), 'truncated');
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
