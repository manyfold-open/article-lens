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
