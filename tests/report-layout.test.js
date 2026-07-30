import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

// The office, the console and the report column are three stacked bands. When
// they carry three different widths the page reads as three unrelated pages, and
// the band with the most text is the narrowest, so it is also the longest.
test('the report column shares the office outer edge instead of its own width', () => {
  const main = page.match(/\n {4}main \{[^}]*\}/s)
  assert.ok(main, 'expected a `main` rule in public/index.html')
  assert.match(main[0], /max-width:\s*calc\(var\(--workspace-width\)/)
  assert.doesNotMatch(main[0], /max-width:\s*\d+px/)
  // An `auto` cross-axis margin opts a flex item out of stretching, so the column
  // needs an explicit width or it shrinks to its content and the cap never applies.
  assert.match(main[0], /width:\s*100%/)
})

// A 1040px column would otherwise stretch a paragraph to a line nobody can track
// back. Widening the card must not widen the prose inside it.
test('prose inside a report card keeps a readable measure', () => {
  assert.match(page, /--prose-measure:\s*\d+ch/)
  assert.match(page, /\.overview\s*\{[^}]*max-width:\s*var\(--prose-measure\)/s)
})

// Four badges plus `min-width: 160px` let the reason survive as a ~200px ribbon
// instead of wrapping, which centred the short chips against a tall column of
// text. The reason owns its own row.
test('the verdict reason owns its own row', () => {
  const bar = page.match(/\.verdict-bar \.vb-why \{[^}]*\}/s)
  assert.ok(bar, 'expected a .verdict-bar .vb-why rule')
  assert.match(bar[0], /flex:\s*1 1 100%/)
  assert.match(page, /\.verdict-bar \{[^}]*align-items:\s*flex-start/s)
})

// 小潜's camps are the section's primary finding, so they stay visible as a deck
// of labelled strips. The four secondary groups collapse behind a count, because
// a collapsed row that says nothing reads as an empty section.
test('the comment digest renders camps as a deck and folds the secondary groups', () => {
  assert.match(app, /class="camp-deck"/)
  assert.match(app, /class="camp-item/)
  assert.match(app, /camp-peek/)
  for (const group of ['disputes', 'expert_corrections', 'spicy']) {
    assert.ok(app.includes(group), `expected the digest to still render ${group}`)
  }
  // Every fold carries its item count, and the three groups share one helper.
  assert.match(app, /function digestFold\(/)
  assert.match(app, /class="digest-fold-n">\$\{filled\.length\}/)
  const calls = app.match(/\$\{digestFold\(/g)
  assert.equal(calls?.length, 3, 'expected disputes, corrections and spicy to share the fold helper')
})

// One camp open at a time keeps the card a predictable height while a reader
// clicks around it.
test('only one camp is open at a time', () => {
  assert.match(app, /bindCampDeck/)
})
