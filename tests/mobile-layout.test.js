import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const mobileStart = page.indexOf('@media (max-width: 640px)')
const narrowStart = page.indexOf('@media (max-width: 380px)')
const mobileCss = page.slice(mobileStart, narrowStart)

test('keeps the timeline viewport responsive and stacks each call on mobile', () => {
  assert.ok(mobileStart > 0 && narrowStart > mobileStart)
  assert.match(
    page,
    /\.workflow-timeline\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*\}/s,
  )
  assert.match(
    mobileCss,
    /\.workflow-attempt\s*\{[^}]*min-width:\s*0;[^}]*\}/s,
  )
  assert.match(
    mobileCss,
    /\.workflow-timeline-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*\}/s,
  )
  assert.match(
    mobileCss,
    /\.workflow-timeline-track\s*\{[^}]*width:\s*100%;[^}]*\}/s,
  )
})
