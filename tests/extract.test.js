'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let extract;

test.before(async () => {
  extract = await import('../src/extract.ts');
});

function item(overrides = {}) {
  return {
    id: 1,
    title: 'Example',
    author: 'author',
    points: 10,
    created_at: '2026-01-01T00:00:00.000Z',
    children: [],
    type: 'story',
    ...overrides,
  };
}

function mockFetch(t, response) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('detects HN item types and decodes HTML entities', () => {
  assert.equal(extract.detectItemType(item({ title: 'Ask HN: Advice?', url: undefined })), 'ask');
  assert.equal(extract.detectItemType(item({ title: 'Show HN: Tool', url: 'https://example.test' })), 'show');
  assert.equal(extract.detectItemType(item({ url: 'https://example.test/paper.pdf' })), 'pdf');
  assert.equal(extract.detectItemType(item({ url: 'https://example.test/post' })), 'article');
  assert.equal(
    extract.stripHtml('<p>R&amp;D&nbsp;&mdash;&nbsp;&#x4E2D;&#25991;</p>'),
    'R&D — 中文',
  );
});

test('extracts the article body while excluding navigation and page noise', async t => {
  const html = `
    <html>
      <nav>Products Pricing Sign in</nav>
      <article>
        <h1>Core title</h1>
        <p>${'Substantive article content. '.repeat(30)}</p>
        <div class="comments">This comment should not enter the article.</div>
      </article>
      <footer>Newsletter and related links</footer>
    </html>`;
  mockFetch(t, new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }));

  const result = await extract.extractArticle('https://example.test/post', item({
    url: 'https://example.test/post',
  }));
  assert.equal(result.paywalled, false);
  assert.match(result.text, /Substantive article content/);
  assert.doesNotMatch(result.text, /Products Pricing|This comment|Newsletter/);
});

test('uses HN text directly and marks PDFs or paywalls as unavailable', async t => {
  const direct = await extract.extractArticle('', item({
    text: '<p>Ask HN body &amp; details</p>',
  }));
  assert.deepEqual(direct, {
    text: 'Ask HN body & details',
    paywalled: false,
  });

  const pdf = await extract.extractArticle('https://example.test/paper.pdf', item());
  assert.deepEqual(pdf, { text: '', paywalled: true });

  mockFetch(t, new Response('<main>Subscribe to continue reading this article.</main>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }));
  const paywall = await extract.extractFromUrl('https://example.test/paywalled');
  assert.equal(paywall.paywalled, true);
  assert.equal(paywall.text, '');
});
