import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDirectory = join(root, 'public')
const docsDirectory = join(root, 'docs')
const publicFiles = readdirSync(publicDirectory)
const htmlFiles = publicFiles.filter(file => file.endsWith('.html'))
const jsFiles = publicFiles.filter(file => file.endsWith('.js'))
const errors = []

const htmlSources = htmlFiles.map(file => ({
  file,
  source: readFileSync(join(publicDirectory, file), 'utf8'),
}))
const jsSource = jsFiles
  .map(file => readFileSync(join(publicDirectory, file), 'utf8'))
  .join('\n')

for (const { file, source } of htmlSources) {
  const ids = [...source.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1])
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  if (duplicateIds.length) {
    errors.push(`${file}: duplicate ids: ${duplicateIds.join(', ')}`)
  }

  for (const match of source.matchAll(/\b(?:src|href)=["']([^"'#]+)["']/g)) {
    const reference = match[1]
    if (/^(?:[a-z]+:|\/\/)/i.test(reference)) continue
    const relativePath = reference.replace(/^\/+/, '').split(/[?#]/, 1)[0]
    if (!relativePath || !/\.[a-z0-9]+$/i.test(relativePath)) continue
    if (!existsSync(join(publicDirectory, relativePath))) {
      errors.push(`${file}: missing local asset ${reference}`)
    }
  }
}

const declaredIds = new Set([
  ...htmlSources.flatMap(({ source }) =>
    [...source.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1])),
  ...[...jsSource.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]),
])
const referencedIds = new Set([
  ...[...jsSource.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]),
  ...[...jsSource.matchAll(/querySelector(?:All)?\(["']#([A-Za-z0-9_-]+)/g)].map(match => match[1]),
])
const missingIds = [...referencedIds].filter(id => !declaredIds.has(id)).sort()
if (missingIds.length) {
  errors.push(`JavaScript references missing DOM ids: ${missingIds.join(', ')}`)
}

const markdownFiles = [
  join(root, 'README.md'),
  ...readdirSync(docsDirectory)
    .filter(file => file.endsWith('.md'))
    .map(file => join(docsDirectory, file)),
]

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '')
    if (!rawTarget || /^(?:[a-z]+:|#)/i.test(rawTarget)) continue
    const target = rawTarget.split('#', 1)[0]
    if (!target) continue
    const resolvedTarget = resolve(dirname(file), decodeURIComponent(target))
    if (!existsSync(resolvedTarget)) {
      errors.push(`${relative(root, file)}: missing Markdown target ${rawTarget}`)
    }
  }
}

// ── One language ──────────────────────────────────────────────────
// The service is English throughout: the roles are prompted in English and answer
// in English, so nothing has to pick a side and no section can render blank while
// a translation is in flight. A stray Chinese string is how that regresses — one
// prompt asking for Chinese output puts mixed-language text back on the report —
// so fail the check rather than let it reach a reader.
//
// `tests/` is exempt: a non-Latin fixture there proves the extractor and the JSON
// repair survive an article that is not in English, which is still a real input.
// A single line that genuinely needs non-Latin characters — a sentence splitter
// has to know what a CJK full stop is — opts out with an `allow-non-english`
// marker on that line or the line above it.
//
// Built from code points rather than written out, so this file does not trip its
// own check. Covers CJK ideographs, kana, and full-width forms and punctuation.
const CJK = new RegExp(
  '[\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF'
  + '\\uF900-\\uFAFF\\uFF01-\\uFF60]',
)
const ALLOW_MARKER = 'allow-non-english'
const sourceRoots = ['src', 'public', 'scripts', 'docs']
const sourceExtensions = /\.(?:ts|js|mjs|html|css|md|sh|toml)$/

function walkFiles(directory) {
  const out = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (sourceExtensions.test(entry.name)) out.push(full)
  }
  return out
}

const sourceFiles = [
  join(root, 'README.md'),
  join(root, 'wrangler.toml'),
  ...sourceRoots.filter(d => existsSync(join(root, d))).flatMap(d => walkFiles(join(root, d))),
]
for (const file of sourceFiles) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const hits = lines
    .map((line, index) => [index + 1, line])
    .filter(([lineNumber, line]) =>
      CJK.test(line)
      && !line.includes(ALLOW_MARKER)
      && !(lines[lineNumber - 2] ?? '').includes(ALLOW_MARKER))
  for (const [lineNumber, line] of hits.slice(0, 3)) {
    errors.push(`${relative(root, file)}:${lineNumber}: non-English text: ${line.trim().slice(0, 60)}`)
  }
  if (hits.length > 3) {
    errors.push(`${relative(root, file)}: ${hits.length - 3} further lines with non-English text`)
  }
}

if (errors.length) {
  for (const error of errors) console.error(`repository check: ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `repository check: ${markdownFiles.length} docs, ${htmlFiles.length} pages, `
    + `${jsFiles.length} browser scripts, and ${sourceFiles.length} source files `
    + 'are internally consistent and English throughout',
  )
}
