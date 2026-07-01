import type { Env, HNItem, ItemType, SSEEvent, HNLensResult, GraphConfig } from './schema'
import { fetchFrontPage, parseHNUrl, ageString, fetchHNItem, searchHNByUrl } from './hn'
import { detectItemType, extractArticle, extractFromUrl } from './extract'
import { orchestrateAnalysis, mockOrchestrate } from './crew/orchestrator'
import { mockDefineTerm } from './crew/mock'
import { callMfAgent } from './crew/mf'
import { parseLoose } from './crew/json'
import { createSSEStream, sseResponse } from './stream'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    if (url.pathname === '/api/frontpage' && request.method === 'GET') {
      return handleFrontPage()
    }

    if (url.pathname === '/api/analyze' && request.method === 'GET') {
      return handleAnalyze(url, env)
    }

    if (url.pathname === '/api/define' && request.method === 'POST') {
      return handleDefine(request, env)
    }

    if (url.pathname === '/api/translate' && request.method === 'POST') {
      return handleTranslate(request, env)
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return handleHealth(url, env)
    }

    return env.ASSETS.fetch(request)
  },

  // Cron: pre-warm the front page so the first view of a top story is instant.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(prewarmFrontPage(env))
    ctx.waitUntil(checkAgentHealth(env))   // refresh the agent health snapshot
  },
}

// Pre-analyse the top few front-page items (empty-KB) into KV.
async function prewarmFrontPage(env: Env): Promise<void> {
  if (!env.MF_API_TOKEN) return                 // only worth caching real-crew output
  let items: Array<Record<string, unknown>>
  try { items = await fetchFrontPage() as unknown as Array<Record<string, unknown>> } catch { return }
  const SPEC = env.SPEC_VERSION
  const kbHash = hashStr('')                     // matches a no-KB client request
  for (const it of items.slice(0, 3)) {
    const id = parseInt(String(it.objectID ?? it.id ?? ''), 10)
    if (!id || isNaN(id)) continue
    const fullKey = `result:${id}:v${SPEC}:${kbHash}`
    try {
      if (await kvGet(env, fullKey)) continue    // already warm
      const item = await fetchHNItem(id)
      const itemType = detectItemType(item)
      const { text } = await extractArticle(item.url ?? '', item)
      const result = await orchestrateAnalysis(item, text, itemType, env, () => {}, { kbTerms: [] })
      result.source = 'hn'
      const shared = { summary: result.summary, comment_digest: result.comment_digest, verdict: result.verdict }
      await Promise.all([
        kvPut(env, `result:${id}:v${SPEC}:shared`, JSON.stringify(shared)),
        kvPut(env, `result:${id}:v${SPEC}:j:${kbHash}`, JSON.stringify(result.jargon)),
        kvPut(env, fullKey, JSON.stringify(result)),
      ])
    } catch { /* skip this item, keep warming the rest */ }
  }
}

// ── /api/frontpage ────────────────────────────────────────────────
async function handleFrontPage(): Promise<Response> {
  try {
    const items = await fetchFrontPage() as unknown as Array<Record<string, unknown>>
    const result = items.slice(0, 10).map(item => ({
      // Algolia's search endpoint keys the id as `objectID` (string).
      id: String(item.objectID ?? item.id ?? ''),
      title: item.title,
      url: item.url,
      points: item.points ?? 0,
      comments: item.num_comments ?? (Array.isArray(item.children) ? item.children.length : 0),
      age: ageString(String(item.created_at ?? '')),
    })).filter(r => r.id && r.title)
    return json(result)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
}

// ── /api/analyze ──────────────────────────────────────────────────
// Accepts ?id= (HN item), ?url= (any article — auto-finds its HN discussion,
// else analyses the article alone), or ?text= (a pasted passage).
interface Resolved {
  item: HNItem
  articleText: string
  itemType: ItemType
  cacheKey: string
  source: 'hn' | 'article' | 'text'
}

async function handleAnalyze(url: URL, env: Env): Promise<Response> {
  const { emit, stream, close } = createSSEStream()

  // The user's saved terms (KB) — so 小詞 skips what they already know.
  const kbTerms = (url.searchParams.get('kb') || '')
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 80)
  const kbHash = hashStr(kbTerms.map(t => t.toLowerCase()).sort().join('|'))

  // Optional client-supplied orchestration graph (v1). Malformed → null, which
  // leaves the no-graph code path byte-for-byte identical to today.
  const graphRaw = url.searchParams.get('graph')
  let graph: GraphConfig | null = null
  if (graphRaw) {
    try {
      const g = JSON.parse(decodeURIComponent(graphRaw))
      if (g && typeof g.v === 'number') graph = g
    } catch { /* ignore malformed graph */ }
  }
  // Fold the graph into the cache key so a custom orchestration doesn't collide
  // with — or get shadowed by — the default-layout cache. No graph → '' → keys
  // are byte-for-byte today's, so existing cached analyses stay valid.
  const graphTag = graph && graphRaw ? `:g${hashStr(graphRaw)}` : ''

  ;(async () => {
    try {
      const r = await resolveInput(url, env)
      if (!r) {
        emit({ event: 'error', message: 'Paste a HN link, an article URL, or some text.' })
        return
      }
      const { item, articleText, itemType, cacheKey, source } = r
      const sharedKey = `${cacheKey}:shared${graphTag}`
      const jargonKey = `${cacheKey}:j:${kbHash}${graphTag}`
      const fullKey   = `${cacheKey}:${kbHash}${graphTag}`

      // Fast path: this exact (item + KB) was analysed before.
      const cachedFull = await kvGet(env, fullKey)
      if (cachedFull) { await replayResult(JSON.parse(cachedFull), emit); return }

      // Otherwise reuse KB-independent sections (summary/comments/verdict) and
      // KB-specific jargon when we have them, computing only what's missing.
      const cachedShared = parseJson(await kvGet(env, sharedKey))
      const cachedJargon = parseJson(await kvGet(env, jargonKey))

      let result
      if (env.MF_API_TOKEN) {
        try {
          result = await orchestrateAnalysis(item, articleText, itemType, env, emit, {
            kbTerms, cachedShared, cachedJargon, graph,
          })
        } catch {
          result = await mockOrchestrate(item, articleText, itemType, emit)
        }
      } else {
        result = await mockOrchestrate(item, articleText, itemType, emit)
      }

      result.source = source
      if (source !== 'hn') result.flags.no_discussion = (item.children?.length ?? 0) === 0

      // Split caches: shared sections by item, jargon by item+KB, full by both.
      const shared = { summary: result.summary, comment_digest: result.comment_digest, verdict: result.verdict }
      await Promise.all([
        kvPut(env, sharedKey, JSON.stringify(shared)),
        kvPut(env, jargonKey, JSON.stringify(result.jargon)),
        kvPut(env, fullKey, JSON.stringify(result)),
      ])
      emit({ event: 'result', data: result })
    } catch (e) {
      emit({ event: 'error', message: String(e) })
    } finally {
      close()
    }
  })()

  return sseResponse(stream)
}

function parseJson(s: string | null): any {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

// Replay a fully-cached result: plan → each section done+populated → result.
async function replayResult(result: HNLensResult, emit: (e: SSEEvent) => void): Promise<void> {
  emit({ event: 'plan', agents: ['sum', 'jargon', 'comments', 'ctx'] })
  await sleep(60)
  const sections: Array<[ 'sum'|'jargon'|'comments'|'ctx', unknown ]> = [
    ['sum', result.summary], ['jargon', result.jargon],
    ['comments', result.comment_digest], ['ctx', result.verdict],
  ]
  for (const [agent, data] of sections) {
    emit({ event: 'status', agent, state: 'done', label: { zh: '已完成 (快取)', en: 'Done (cached)' } })
    emit({ event: 'section', agent, data })
    await sleep(50)
  }
  // Token meter: replay the cached run's usage so the FE meter shows the real
  // cost. Older cached results predate metering and simply have no `usage`.
  if (result.usage) {
    for (const [agent, tokens] of Object.entries(result.usage.byAgent)) {
      emit({ event: 'usage', agent, tokens })
    }
    emit({ event: 'usage', tokens: 0, total: result.usage.total })
  }
  emit({ event: 'result', data: result })
}

async function resolveInput(url: URL, env: Env): Promise<Resolved | null> {
  const SPEC = env.SPEC_VERSION
  const idParam = url.searchParams.get('id')
  const urlParam = url.searchParams.get('url')
  const textParam = url.searchParams.get('text')

  // An HN item id → full thread analysis (shared cache with direct HN access).
  const fromHnId = async (itemId: number, key: string): Promise<Resolved> => {
    const item = await fetchHNItem(itemId)
    const itemType = detectItemType(item)
    const { text } = await extractArticle(item.url ?? '', item)
    return { item, articleText: text, itemType, cacheKey: key, source: 'hn' }
  }

  if (idParam) {
    const itemId = parseHNUrl(idParam) ?? parseInt(idParam, 10)
    if (!itemId || isNaN(itemId)) return null
    return fromHnId(itemId, `result:${itemId}:v${SPEC}`)
  }

  if (urlParam) {
    const u = normalizeUrl(urlParam)
    if (!u) return null
    // A HN item URL is just the id path.
    const hnId = parseHNUrl(u)
    if (hnId) return fromHnId(hnId, `result:${hnId}:v${SPEC}`)
    // Does this article already have a HN discussion? If so, use it.
    const hit = await searchHNByUrl(u)
    if (hit && hit.num_comments > 0) return fromHnId(hit.id, `result:${hit.id}:v${SPEC}`)
    // Otherwise analyse the article on its own.
    const { text, title, paywalled } = await extractFromUrl(u)
    const itemType: ItemType = paywalled ? 'paywalled'
      : (u.toLowerCase().split('?')[0].endsWith('.pdf') ? 'pdf' : 'article')
    const item = synthItem(title || hostOf(u) || 'Article', u, '')
    return { item, articleText: text, itemType, cacheKey: `result:u:${hashStr(u)}:v${SPEC}`, source: 'article' }
  }

  if (textParam) {
    const text = textParam.slice(0, 8000)
    if (!text.trim()) return null
    const title = (text.split('\n').find(l => l.trim()) || 'Pasted text').trim().slice(0, 60)
    const item = synthItem(title, '', text)
    return { item, articleText: text, itemType: 'article', cacheKey: `result:t:${hashStr(text)}:v${SPEC}`, source: 'text' }
  }

  return null
}

// A stand-in HNItem for non-HN inputs (no thread, no metadata).
function synthItem(title: string, urlStr: string, text: string): HNItem {
  return {
    id: 0, title, url: urlStr || undefined, text: text || null,
    author: '', points: 0, created_at: new Date().toISOString(),
    children: [], type: 'story',
  }
}
function normalizeUrl(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return ''
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s
  try { return new URL(withScheme).toString() } catch { return '' }
}
function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' }
}
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// ── /api/define ───────────────────────────────────────────────────
async function handleDefine(request: Request, env: Env): Promise<Response> {
  let term = ''
  let context: string | undefined
  try {
    const body = await request.json() as { term?: string; context?: string }
    term = (body.term ?? '').trim()
    context = body.context
  } catch {
    return json({ error: 'invalid body' }, 400)
  }
  if (!term) return json({ error: 'term required' }, 400)

  // No token configured → answer from the mock glossary.
  if (!env.MF_API_TOKEN) {
    return json(mockDefineTerm(term, context), 200)
  }

  try {
    const prompt = `You are 小詞, a bilingual (Chinese/English) jargon explainer for tech and HN readers.

Explain this term in plain language for a smart generalist who codes but isn't in this niche:

Term: "${term}"
${context ? `Seen in context: "${context}"` : ''}

Rules:
- 1-2 sentences per language
- No circular definitions, no jargon in the explanation
- Use a concrete analogy if it helps
- Find the standard Chinese name if one exists, else provide a descriptive label

Respond with ONLY this JSON (no markdown, no commentary; inside string values never use the " character — use ' or 「」 for quotes):
{"term":"${term}","zh_term":"<standard Chinese name or label>","explain":{"en":"<1-2 sentences>","zh":"<1-2 sentences>"}}`

    const text = await callMfAgent(env, env.AGENT_JARGON, prompt)
    const parsed = parseLoose<{ term: string; zh_term: string; explain: { en: string; zh: string } }>(text)
    // If the agent didn't return usable JSON, fall back to the glossary.
    if (!parsed?.explain?.zh && !parsed?.explain?.en) {
      return json(mockDefineTerm(term, context), 200)
    }
    return json(parsed, 200)
  } catch {
    // On any failure, degrade gracefully to the mock glossary.
    return json(mockDefineTerm(term, context), 200)
  }
}

// ── /api/translate ────────────────────────────────────────────────
// Agents generate Chinese only; the client fetches English on demand here when
// the user switches to EN / 雙語, and caches it client-side.
async function handleTranslate(request: Request, env: Env): Promise<Response> {
  let zh: string[] = []
  try {
    const body = await request.json() as { zh?: string[] }
    zh = (body.zh ?? []).filter(s => typeof s === 'string').slice(0, 80)
  } catch {
    return json({ error: 'invalid body' }, 400)
  }
  if (!zh.length) return json({ en: [] }, 200)

  // Per-string KV cache (shared across all users): same zh → reuse its en, so
  // we only ever pay to translate a given string once.
  const keyFor = (s: string) => `tr:${hashStr(s)}:v${env.SPEC_VERSION}`
  const cached = await Promise.all(zh.map(s => kvGet(env, keyFor(s))))
  const out = zh.map((s, i) => cached[i] ?? s)              // start from cache, fall back to zh
  const missIdx = zh.map((_, i) => i).filter(i => cached[i] == null)

  if (!missIdx.length) return json({ en: out }, 200)        // everything was cached
  if (!env.MF_API_TOKEN) return json({ en: out }, 200)      // no token → zh fallback for misses

  try {
    const miss = missIdx.map(i => zh[i])
    const numbered = miss.map((s, k) => `${k}: ${s}`).join('\n')
    const prompt = `Translate each numbered Chinese line into natural, concise English. Keep technical terms. Return ONLY a JSON array of strings in the SAME order and length (no markdown; inside string values never use the " character — use ' instead):
${numbered}

Format: ["english 0","english 1", ...]`
    const text = await callMfAgent(env, env.AGENT_SUMMARIZER, prompt)
    const arr = parseLoose<string[]>(text)
    if (Array.isArray(arr) && arr.length === miss.length) {
      const puts: Promise<void>[] = []
      missIdx.forEach((origIdx, k) => {
        const en = (typeof arr[k] === 'string' && arr[k].trim()) ? arr[k] : zh[origIdx]
        out[origIdx] = en
        puts.push(kvPut(env, keyFor(zh[origIdx]), en))       // cache for next time
      })
      await Promise.all(puts)
    }
    return json({ en: out }, 200)
  } catch {
    return json({ en: out }, 200)
  }
}

// ── /api/health ───────────────────────────────────────────────────
// Pings each crew agent so you can see which are up and how slow. The cron
// refreshes the snapshot; the endpoint serves it cached (or ?live=1 re-runs).
const HEALTH_KEY = 'health:latest'
function healthAgents(env: Env): Array<{ name: string; id: string }> {
  return [
    { name: '小摘 sum', id: env.AGENT_SUMMARIZER },
    { name: '小詞 jargon', id: env.AGENT_JARGON },
    { name: '小潛-map', id: env.AGENT_COMMENT_MAP },
    { name: '小潛-reduce', id: env.AGENT_COMMENT_REDUCE },
    { name: '小導 ctx', id: env.AGENT_CONTEXT },
    { name: '合成 synth', id: env.AGENT_SYNTHESIZER },
  ]
}
function shortError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 140)
}
async function checkAgentHealth(env: Env): Promise<unknown> {
  if (!env.MF_API_TOKEN) return { checkedAt: new Date().toISOString(), up: 0, total: 0, agents: [], note: 'no MF_API_TOKEN' }
  const agents = await Promise.all(healthAgents(env).map(async ({ name, id }) => {
    const t0 = Date.now()
    try {
      await callMfAgent(env, id, '只回一個字：OK', { timeoutMs: 25_000, attempts: 1 })
      return { name, id, ok: true, ms: Date.now() - t0 }
    } catch (e) {
      return { name, id, ok: false, ms: Date.now() - t0, error: shortError(e) }
    }
  }))
  const snapshot = {
    checkedAt: new Date().toISOString(),
    up: agents.filter(a => a.ok).length, total: agents.length, agents,
  }
  await kvPut(env, HEALTH_KEY, JSON.stringify(snapshot))
  return snapshot
}
async function handleHealth(url: URL, env: Env): Promise<Response> {
  if (url.searchParams.get('live') === '1') return json(await checkAgentHealth(env))
  const cached = await kvGet(env, HEALTH_KEY)
  return json(cached ? JSON.parse(cached) : await checkAgentHealth(env))
}

// ── KV helpers (tolerate a missing/unbound namespace) ─────────────
async function kvGet(env: Env, key: string): Promise<string | null> {
  try { return env.CACHE ? await env.CACHE.get(key) : null } catch { return null }
}
async function kvPut(env: Env, key: string, value: string): Promise<void> {
  try { if (env.CACHE) await env.CACHE.put(key, value, { expirationTtl: 86400 * 7 }) } catch { /* ignore */ }
}
