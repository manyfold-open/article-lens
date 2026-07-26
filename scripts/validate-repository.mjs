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

if (errors.length) {
  for (const error of errors) console.error(`repository check: ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `repository check: ${markdownFiles.length} docs, ${htmlFiles.length} pages, and ${jsFiles.length} browser scripts are internally consistent`,
  )
}
