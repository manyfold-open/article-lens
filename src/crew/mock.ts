// ── Mock analysis adapter ─────────────────────────────────────────
// A clean, dependency-free fallback that keeps the UI and Worker fully
// functional when no Manyfold token is configured (or a real agent call
// fails). It works from the REAL fetched HN data — title, article text,
// and the actual comment thread — so every section renders meaningfully
// and links back to real HN comments.
//
// The hero feature (jargon) is powered by an authored, genuinely bilingual
// plain-language glossary, so explanations are correct and non-circular for
// the most common HN/tech terms, with a graceful template for unknown ones.

import type {
  HNItem, HNComment, ItemType, HNLensResult, JargonTerm, Camp,
} from '../schema'
import { stripHtml } from '../extract'

// ── Authored glossary ─────────────────────────────────────────────
interface GlossaryEntry {
  term: string
  en: string
  /** extra spellings/aliases to match in text (besides `term`) */
  aliases?: string[]
  /** match case-insensitively (names) vs exact word (acronyms) */
  ci?: boolean
}

const GLOSSARY: GlossaryEntry[] = [
  // ── Vectors / search / AI ──
  { term: 'pgvector', ci: true,
    en: 'A free add-on for the PostgreSQL database that lets it store and search lists of numbers (the kind AI models use to represent meaning) without running a separate service.' },
  { term: 'Pinecone', ci: true,
    en: 'A hosted cloud service built only for storing and searching vectors. Convenient, but you pay a fixed monthly fee to keep it running whether you use it or not.' },
  { term: 'vector database', ci: true, aliases: ['vector db', 'vector store'],
    en: 'A database tuned to find items whose meaning is "closest" to a query, rather than matching exact keywords — the backbone of AI search and recommendations.' },
  { term: 'embedding', ci: true, aliases: ['embeddings'],
    en: 'A list of numbers an AI model produces to capture the meaning of a piece of text or an image, so a computer can compare meanings mathematically.' },
  { term: 'HNSW',
    en: 'A way of organising vectors into a layered map so search can jump to the right neighbourhood fast, instead of comparing against every single item.' },
  { term: 'ANN', aliases: ['approximate nearest neighbor', 'approximate nearest neighbour'],
    en: 'Search that returns results that are "close enough" instead of guaranteed-perfect, trading a tiny bit of accuracy for a huge speed-up.' },
  { term: 'RAG', aliases: ['retrieval augmented generation', 'retrieval-augmented generation'],
    en: 'A trick where an AI first looks up relevant documents and then writes its answer using them, so it can cite real facts instead of guessing.' },
  { term: 'LLM', aliases: ['large language model'],
    en: 'A program trained on huge amounts of text that predicts the next words, which lets it answer questions, write, and summarise.' },
  { term: 'recall', ci: true, aliases: ['recall@10', 'recall@k'],
    en: 'A score for search quality: of all the truly best matches, what fraction did the system actually return? 0.95 means it found 95% of them.' },
  { term: 'token', ci: true, aliases: ['tokens'],
    en: 'The small chunk of text (roughly a word piece) that language models read and count one at a time — pricing and limits are usually measured in tokens.' },
  { term: 'fine-tuning', ci: true, aliases: ['fine tuning', 'finetune', 'fine-tune'],
    en: 'Taking an already-trained AI model and training it a bit more on your own examples so it behaves the way you want.' },
  { term: 'quantization', ci: true, aliases: ['quantized', 'quantisation'],
    en: 'Shrinking an AI model by storing its numbers with less precision, so it runs on cheaper hardware with only a small quality drop.' },

  // ── Infra / devops ──
  { term: 'Kubernetes', ci: true, aliases: ['k8s'],
    en: 'A system that automatically runs, restarts, and spreads your app across many servers so it stays up under load.' },
  { term: 'Docker', ci: true,
    en: 'A tool that packages an app with everything it needs into a "container" that runs the same way on any machine.' },
  { term: 'serverless', ci: true,
    en: 'Running code without managing servers yourself — the platform spins it up on demand and you pay only for what runs.' },
  { term: 'Redis', ci: true,
    en: 'A very fast database that keeps data in memory, commonly used as a cache to avoid repeating slow work.' },
  { term: 'Postgres', ci: true, aliases: ['PostgreSQL'],
    en: 'A popular free database for storing structured data in tables, known for being reliable and feature-rich.' },
  { term: 'RDS',
    en: 'Amazon\'s service that runs and maintains a database for you, handling backups and updates so you don\'t have to.' },
  { term: 'p99', aliases: ['p95', 'p50', 'tail latency'],
    en: 'A "worst realistic case" speed measure: the response time that 99% of requests beat. It shows how slow your unluckiest users feel.' },
  { term: 'latency', ci: true,
    en: 'How long you wait between asking for something and getting a response — lower is faster.' },
  { term: 'throughput', ci: true,
    en: 'How much work a system handles per second — higher means it can serve more requests at once.' },
  { term: 'CDN',
    en: 'A network of servers spread around the world that keeps copies of your files close to users so pages load faster.' },

  // ── Languages / runtimes ──
  { term: 'Rust', ci: true,
    en: 'A programming language designed for speed and safety: it catches whole classes of memory bugs before the program ever runs.' },
  { term: 'Go', aliases: ['Golang'],
    en: 'A programming language from Google built for simple, fast server software and easy handling of many tasks at once.' },
  { term: 'WASM', aliases: ['WebAssembly'],
    en: 'A compact format that lets code written in languages like Rust or C run inside the browser at near-native speed.' },
  { term: 'borrow checker', ci: true,
    en: 'The part of the Rust compiler that enforces who is allowed to read or change each piece of data, preventing memory bugs.' },
  { term: 'garbage collection', ci: true, aliases: ['garbage collector', 'GC'],
    en: 'An automatic cleanup system that frees memory the program no longer needs, so developers don\'t have to track it by hand.' },

  // ── Web / data ──
  { term: 'BM25',
    en: 'A classic formula for ranking text search results by keyword relevance — the proven workhorse behind traditional full-text search.' },
  { term: 'GraphQL', ci: true,
    en: 'A way to ask a server for exactly the data fields you want in one request, instead of calling many fixed endpoints.' },
  { term: 'SSE', aliases: ['server-sent events'],
    en: 'A simple way for a server to keep pushing live updates to the browser over one long-lived connection.' },
  { term: 'WebSocket', ci: true, aliases: ['websockets'],
    en: 'A two-way live connection between browser and server, used for chat, games, and anything needing instant back-and-forth.' },
  { term: 'JWT',
    en: 'A signed, tamper-evident token a server hands a user to prove who they are on later requests, without re-checking a database each time.' },
  { term: 'CRDT',
    en: 'A data structure that lets many people edit the same document offline and merges everyone\'s changes automatically without conflicts.' },
  { term: 'SQLite', ci: true,
    en: 'A tiny database that lives in a single file inside your app — no server to run, great for local or embedded use.' },

  // ── Security / general ──
  { term: 'zero-day', ci: true, aliases: ['0-day', 'zero day'],
    en: 'A security hole that attackers know about before the vendor does, so there is no fix available yet when it\'s first exploited.' },
  { term: 'end-to-end encryption', ci: true, aliases: ['e2ee', 'end to end encryption'],
    en: 'Scrambling messages so only the sender and receiver can read them — not even the company running the service can.' },
  { term: 'open source', ci: true, aliases: ['open-source', 'FOSS', 'OSS'],
    en: 'Software whose source code is published for anyone to read, use, and modify, usually for free.' },
  { term: 'self-hosted', ci: true, aliases: ['self host', 'selfhost', 'self hosting'],
    en: 'Running software on your own servers instead of paying a company to host it for you — more control, more maintenance.' },
  { term: 'YAGNI',
    en: '"You Aren\'t Gonna Need It" — advice not to build features for imagined future needs until they\'re actually required.' },
  { term: 'technical debt', ci: true, aliases: ['tech debt'],
    en: 'The future cost of taking shortcuts in code today — like a loan you repay later with slower, harder changes.' },
  { term: 'idempotent', ci: true,
    en: 'An operation you can safely repeat and get the same result — running it twice does no extra harm.' },
  { term: 'eventual consistency', ci: true,
    en: 'A design where different copies of data may briefly disagree but are guaranteed to match up shortly after.' },
  { term: 'rate limit', ci: true, aliases: ['rate-limiting', 'rate limiting'],
    en: 'A cap on how many requests you can make in a time window, used to stop abuse and keep a service stable.' },
  { term: 'benchmark', ci: true, aliases: ['benchmarks'],
    en: 'A standardised test that measures how fast or efficient something is, so different options can be compared fairly.' },
  { term: 'API',
    en: 'A defined set of requests one program can send to another to ask for data or actions — the contract between software pieces.' },
  { term: 'cache', ci: true, aliases: ['caching'],
    en: 'A stash of already-computed answers kept close at hand so repeated work can be skipped and things load faster.' },
]

// ── Acronym stoplist (too common / not jargon) ───────────────────
const ACRONYM_STOP = new Set([
  'HN', 'US', 'UK', 'EU', 'OK', 'FAQ', 'CEO', 'CTO', 'USA', 'PM', 'AM',
  'TV', 'PC', 'OS', 'IT', 'ID', 'URL', 'HTML', 'CSS', 'PDF', 'FYI',
  'TLDR', 'TLDR;', 'IMO', 'IMHO', 'AKA', 'ETC', 'VS', 'AI', 'ML',
  'AD', 'BC', 'BCE', 'CE', 'NO', 'SO', 'IF', 'OR', 'AND', 'THE', 'A',
  'I', 'A.D', 'B.C', 'GDP', 'CPU', 'GPU', 'RAM', 'USD', 'EUR', 'GBP',
])

// ── Public: build a full mock result ──────────────────────────────
export function buildMockResult(
  item: HNItem,
  articleText: string,
  itemType: ItemType
): HNLensResult {
  const comments = (item.children ?? []).filter(c => c.text && c.text.trim())
  const commentText = comments
    .map(c => stripHtml(c.text ?? ''))
    .join('\n')
  const articleCorpus = `${item.title}\n${articleText || item.text || ''}`
  const hasText = !!(articleText || item.text)

  const jargon = extractJargon(articleCorpus, commentText)
  const summary = buildSummary(item, articleText, itemType, hasText)
  const verdict = buildVerdict(item, itemType)
  const comment_digest = buildCommentDigest(item, comments)

  return {
    item_id: item.id,
    spec_version: 1,
    type: itemType,
    title: item.title,
    url: item.url ?? '',
    meta: {
      points: item.points ?? 0,
      comments: comments.length,
      author: item.author ?? '',
      age: '',
    },
    verdict,
    jargon,
    summary,
    comment_digest,
    flags: { low_confidence: !hasText, comments_sampled: false },
  }
}

// ── Public: define a single term (Ask the Jargon agent) ───────────
export function mockDefineTerm(
  term: string,
  context?: string
): { term: string; explain: string } {
  const hit = lookupGlossary(term)
  if (hit) return { term: hit.term, explain: hit.en }
  return {
    term,
    explain: `'${term}' is a specialised term used in this area.${context ? ` It appears here in: '${truncate(context, 120)}'.` : ''} A general definition isn't in this demo glossary — connect a Manyfold agent for a full explanation.`,
  }
}

// ── Jargon extraction ─────────────────────────────────────────────
function extractJargon(articleCorpus: string, commentText: string): JargonTerm[] {
  const out: JargonTerm[] = []
  const seenTerms = new Set<string>()
  const combined = `${articleCorpus}\n${commentText}`

  // 1) Glossary matches (high quality, bilingual)
  for (const entry of GLOSSARY) {
    const variants = [entry.term, ...(entry.aliases ?? [])]
    let matched = false
    let inArticle = false
    let inComments = false
    let appeared: string | undefined
    for (const v of variants) {
      const re = wordRegex(v, entry.ci ?? false)
      if (re.test(articleCorpus)) { matched = true; inArticle = true }
      if (re.test(commentText))   { matched = true; inComments = true }
      if (matched && !appeared) appeared = findSentence(combined, v, entry.ci ?? false)
      if (matched && inArticle && inComments) break
    }
    if (!matched) continue
    const key = entry.term.toLowerCase()
    if (seenTerms.has(key)) continue
    seenTerms.add(key)
    out.push({
      term: entry.term,
      explain: entry.en,
      seen_in: inArticle && inComments ? 'both' : inArticle ? 'article' : 'comments',
      ...(appeared ? { appeared_as: appeared } : {}),
    })
    if (out.length >= 8) break
  }

  // 2) Top up with unknown acronyms if we have < 4 confident terms.
  // Keep only ones that look like real jargon: length ≥ 3 (or contain a
  // digit) and that recur, so dates/roman-numerals/one-offs don't leak in.
  if (out.length < 4) {
    const acronyms = findAcronyms(combined)
    for (const [ac, count] of acronyms) {
      if (out.length >= 6) break
      const looksJargon = (ac.length >= 3 || /\d/.test(ac)) && count >= 2
      if (!looksJargon) continue
      const key = ac.toLowerCase()
      if (seenTerms.has(key) || lookupGlossary(ac)) continue
      seenTerms.add(key)
      const inArticle = wordRegex(ac, false).test(articleCorpus)
      const inComments = wordRegex(ac, false).test(commentText)
      out.push({
        term: ac,
        explain: `An acronym specific to this topic. The thread uses it as established shorthand; see the quote for how it appears in context.`,
        seen_in: inArticle && inComments ? 'both' : inArticle ? 'article' : 'comments',
        appeared_as: findSentence(combined, ac, false),
      })
    }
  }

  // 3) Absolute fallback so the hero section is never empty
  if (out.length === 0) {
    out.push({
      term: 'Hacker News',
      explain: 'A community news site where programmers and founders share and debate technology, startups, and science.',
      seen_in: 'article',
    })
  }

  return out
}

function findAcronyms(text: string): Array<[string, number]> {
  const counts = new Map<string, number>()
  const re = /\b[A-Z][A-Z0-9]{1,5}\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const a = m[0]
    if (ACRONYM_STOP.has(a)) continue
    if (/^[IVXLCDM]+$/.test(a)) continue // roman numerals (III, XIV, …)
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// ── Summary ───────────────────────────────────────────────────────
function buildSummary(
  item: HNItem,
  articleText: string,
  itemType: ItemType,
  hasText: boolean
): HNLensResult['summary'] {
  const typeEn = { article: 'article', ask: 'Ask HN question', show: 'Show HN project', pdf: 'PDF', paywalled: 'article' }[itemType]
  const body = articleText || item.text || ''
  const sentences = cleanSentences(splitSentences(stripHtml(body)))

  if (!hasText || sentences.length === 0) {
    return {
      tldr: `This ${typeEn} ("${item.title}") reached the HN front page with ${item.points ?? 0} points, but its full text couldn't be extracted (paywall, PDF, or self-post). Open it on HN to read the source.`,
      key_points: [
        `Title: ${item.title}`,
        `${item.points ?? 0} points · ${(item.children ?? []).length} top-level comments`,
        'Full text unavailable — the discussion below is the best signal.',
      ],
    }
  }

  const lead = sentences.slice(0, 2).join(' ')
  const points = pickKeySentences(sentences, 3)
  return {
    tldr: truncate(lead, 320),
    key_points: points.map(s => (truncate(s, 220))),
  }
}

function pickKeySentences(sentences: string[], n: number): string[] {
  // Prefer sentences with numbers/percentages (often the substantive claims),
  // then fall back to the earliest reasonably long sentences.
  const scored = sentences
    .map((s, i) => ({ s, i, score: (/[0-9]%|\d{2,}|\bx\b|faster|cheaper|better|because/i.test(s) ? 10 : 0) - i * 0.1 }))
    .filter(x => x.s.length > 40)
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, n).sort((a, b) => a.i - b.i).map(x => x.s)
  if (top.length) return top
  return sentences.filter(s => s.length > 30).slice(0, n)
}

// ── Verdict ───────────────────────────────────────────────────────
function buildVerdict(item: HNItem, itemType: ItemType): HNLensResult['verdict'] {
  const points = item.points ?? 0
  const nComments = (item.children ?? []).length
  const worth = points >= 300 ? 'high' : points >= 80 ? 'medium' : 'low'
  const tier = nComments >= 150 ? 'deep' : nComments >= 40 ? '1min' : '10s'

  const reasonEn =
    itemType === 'ask' ? `An Ask HN thread the community engaged with heavily (${nComments} comments) — the value is in the collective answers.`
    : itemType === 'show' ? `A Show HN project that drew ${points} points — people found it worth trying or discussing.`
    : `It climbed to ${points} points with ${nComments} comments, signalling the community sees it as ${worth === 'high' ? 'important' : worth === 'medium' ? 'interesting' : 'niche'}.`

  return {
    worth_reading: worth,
    why_frontpage: reasonEn,
    tier,
  }
}

// ── Comment digest ────────────────────────────────────────────────
function buildCommentDigest(item: HNItem, comments: HNComment[]): HNLensResult['comment_digest'] {
  const n = comments.length
  if (n === 0) {
    return {
      overview: 'No comments yet on this post.',
      camps: [], consensus: '', disputes: [],
      expert_corrections: [], spicy: [],
    }
  }

  // Rank top-level comments by substance (length of own text).
  const ranked = [...comments]
    .map(c => ({ c, text: stripHtml(c.text ?? '') }))
    .filter(x => x.text.length > 0)
    .sort((a, b) => b.text.length - a.text.length)

  // Camps: take the most substantial distinct top-level comments.
  const camps: Camp[] = []
  const campLabels: string[] = [
    'Main thread of discussion',
    'A different angle',
    'Pushback & caveats',
  ]
  const weights: Camp['weight'][] = ['majority', 'vocal-minority', 'fringe']
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const { c, text } = ranked[i]
    camps.push({
      label: campLabels[i],
      stance: `Raised by ${c.author ?? 'a commenter'}.`,
      weight: weights[i],
      quote: truncate(text, 160),
      comment_id: c.id,
    })
  }

  // Corrections / caveats: comments that read like a correction.
  const correctionHit = ranked.find(x =>
    /\b(actually|incorrect|not true|to be clear|that'?s wrong|misleading|correction|in fact|nitpick)\b/i.test(x.text))
  const expert_corrections = correctionHit ? [{
    correction: `${correctionHit.c.author ?? 'A commenter'} pushes back on a claim: "${truncate(correctionHit.text, 160)}"`,
    comment_id: correctionHit.c.id,
  }] : []

  // Spicy: strongest-sentiment comment (punctuation / opinion markers).
  const spicyHit = ranked
    .map(x => ({ ...x, heat: heatScore(x.text) }))
    .sort((a, b) => b.heat - a.heat)[0]
  const spicy = spicyHit && spicyHit.heat > 0 ? [{
    quote: truncate(spicyHit.text, 200),
    note: `The most heated comment in the thread, from ${spicyHit.c.author ?? 'an anonymous commenter'}.`,
    comment_id: spicyHit.c.id,
  }] : []

  const topAuthor = ranked[0]?.c.author ?? 'commenters'
  return {
    overview: `${n} top-level comments. The most-developed threads are led by ${topAuthor} and others; below are the main strands, a likely correction, and the spiciest take — each links to the original comment.`,
    camps,
    consensus: camps.length
      ? `Most engagement clusters around: '${truncate(camps[0].quote, 120)}'`
      : 'No clear consensus.',
    disputes: camps.length >= 2 ? [`Tension between "${truncate(camps[0].quote, 90)}" and "${truncate(camps[1].quote, 90)}".`] : [],
    expert_corrections,
    spicy,
  }
}

function heatScore(text: string): number {
  let s = 0
  if (/[!?]{1,}/.test(text)) s += (text.match(/[!?]/g) ?? []).length
  if (/\b(never|always|terrible|awful|nonsense|ridiculous|wrong|hate|love|amazing|garbage|hype|overrated|underrated)\b/i.test(text)) s += 5
  if (/\b(disagree|honestly|frankly|unpopular|controversial)\b/i.test(text)) s += 3
  return s
}

// ── Text helpers ──────────────────────────────────────────────────
function wordRegex(term: string, ci: boolean): RegExp {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // For multi-word or symbol-containing terms, use loose boundaries.
  const pattern = /^[\w]+$/.test(term) ? `\\b${esc}\\b` : esc.replace(/\s+/g, '\\s+')
  return new RegExp(pattern, ci ? 'i' : '')
}

function findSentence(text: string, term: string, ci: boolean): string | undefined {
  const sentences = splitSentences(stripHtml(text))
  const re = wordRegex(term, ci)
  const hit = sentences.find(s => re.test(s))
  return hit ? truncate(hit.trim(), 180) : undefined
}

// Drop nav/boilerplate sentences that survive naive HTML extraction so the
// TL;DR starts on real prose, not site chrome.
function cleanSentences(sentences: string[]): string[] {
  const BOILER = /table of contents|skip to|main content|subscribe|newsletter|cookie|sign in|log in|menu|copyright|all rights reserved|privacy policy|terms of service|share this|read more/i
  const clean = sentences.filter(s => {
    if (s.length < 30) return false
    if (s.includes('|')) return false
    if (BOILER.test(s)) return false
    const letters = (s.match(/[a-z]/g) ?? []).length
    if (letters < s.length * 0.4) return false // mostly symbols/caps → chrome
    return true
  })
  return clean.length ? clean : sentences
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    // Article text is not always English, and a CJK full stop has to end a
    // sentence here or a whole body reads as one sentence. allow-non-english
    .split(/(?<=[.!?。！？])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

function truncate(s: string, max: number): string {
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1).trim() + '…' : s
}

function lookupGlossary(term: string): GlossaryEntry | undefined {
  const t = term.trim().toLowerCase()
  return GLOSSARY.find(e =>
    e.term.toLowerCase() === t ||
    (e.aliases ?? []).some(a => a.toLowerCase() === t))
}
