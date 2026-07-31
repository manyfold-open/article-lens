import { cacheGet, cachePut } from '../cache'
import { CriticalAgentFallbackError, mockOrchestrate, orchestrateAnalysis } from '../crew/orchestrator'
import { coerceLegacyJargon, coerceLegacyResult, coerceLegacyShared } from '../crew/legacy'
import { buildWorkflowPlan } from '../crew/graph'
import { detectItemType, extractArticle, extractFromUrl } from '../extract'
import { hashString } from '../hash'
import { fetchHNItem, parseHNUrl, searchHNByUrl } from '../hn'
import type { Env, GraphConfig, HNItem, HNLensResult, ItemType, SSEEvent } from '../schema'
import { createSSEStream, sseResponse } from '../stream'
import type { AnalysisJobParams } from '../workflow/analysis-job'

interface ResolvedInput {
  item: HNItem
  articleText: string
  itemType: ItemType
  cacheKey: string
  source: 'hn' | 'article' | 'text'
}

// Agent bindings changed from Gemini CLI to Codex. Do not replay results
// produced by the previous backend after the routing migration.
const CACHE_QUALITY_TAG = ':stable-v2'
const REQUIRED_RESULT_AGENTS = ['sum', 'jargon', 'comments', 'ctx'] as const
const CRITICAL_RESULT_AGENTS = new Set(['sum', 'ctx'])

interface RunAnalysisPolicy {
  allowCriticalFallback?: boolean
  analysisId?: string
  attempt?: number
  maxAttempts?: number
}

function isReusableResult(result: HNLensResult | null | undefined): result is HNLensResult {
  if (!result?.flags || (result.flags.fallback_agents?.length ?? 0) > 0) return false
  const sources = result.flags.agent_sources
  if (!sources) return false
  return REQUIRED_RESULT_AGENTS.every(agent => {
    const mode = sources[agent]?.mode
    return mode === 'real' || mode === 'cache' || mode === 'skipped'
  })
}

function markLocalFallback(result: HNLensResult, reason: string): void {
  const agents = ['sum', 'jargon', 'comments', 'ctx', 'synth'] as const
  result.flags.fallback_agents = [...agents]
  result.flags.agent_sources = Object.fromEntries(agents.map(agent => [
    agent,
    {
      mode: 'fallback' as const,
      reason: `Manyfold orchestration did not complete; using the local fallback result. Reason: ${reason}`,
    },
  ]))
}

export async function handleAnalyze(url: URL, env: Env): Promise<Response> {
  const { emit, stream, close } = createSSEStream()
  const job = await startAnalysisJob(env, url.search, 'sse')
  ;(async () => {
    let cursor = 0
    try {
      while (true) {
        const snapshot = await job.stub.getSnapshot(cursor) as {
          phase: 'queued' | 'running' | 'done' | 'error'
          cursor: number
          events: Array<{ seq: number; data: SSEEvent }>
          error?: string | null
        } | null
        if (!snapshot) {
          emit({ event: 'error', message: 'Analysis job disappeared before it completed.' })
          return
        }
        for (const entry of snapshot.events) emit(entry.data)
        cursor = snapshot.cursor
        if (snapshot.phase === 'done' || snapshot.phase === 'error') {
          if (snapshot.phase === 'error' && !snapshot.events.some(entry => entry.data.event === 'error')) {
            emit({ event: 'error', message: snapshot.error ?? 'Analysis failed.' })
          }
          return
        }
        await sleep(500)
      }
    } catch (error) {
      emit({ event: 'error', message: String(error) })
    } finally {
      close()
    }
  })()

  return sseResponse(stream)
}

export async function handleCreateAnalysis(request: Request, env: Env): Promise<Response> {
  let body: { id?: string | number; url?: string; text?: string; kb?: string[]; graph?: GraphConfig }
  try {
    body = await request.json() as typeof body
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const supplied = [body.id !== undefined, !!body.url, !!body.text].filter(Boolean).length
  if (supplied !== 1) {
    return Response.json({ error: 'exactly one of id, url, or text is required' }, { status: 400 })
  }
  const query = new URLSearchParams()
  if (body.id !== undefined) query.set('id', String(body.id))
  if (body.url) query.set('url', body.url)
  if (body.text) query.set('text', body.text.slice(0, 8000))
  if (Array.isArray(body.kb)) query.set('kb', body.kb.filter(value => typeof value === 'string').slice(0, 80).join(','))
  if (body.graph) query.set('graph', JSON.stringify(body.graph))
  const job = await startAnalysisJob(env, `?${query.toString()}`, 'api')
  return Response.json({
    analysis_id: job.id,
    phase: 'queued',
    status_url: `/api/analyses/${encodeURIComponent(job.id)}/status`,
  }, { status: 202 })
}

export async function handleAnalysisStatus(env: Env, analysisId: string, after = 0): Promise<Response> {
  const stub = env.ANALYSIS_JOBS.get(env.ANALYSIS_JOBS.idFromName(analysisId))
  const snapshot = await stub.getSnapshot(Math.max(0, Math.floor(after)))
  if (!snapshot) return Response.json({ error: 'unknown analysis_id' }, { status: 404 })
  return Response.json(snapshot)
}

export async function runAnalysisRequest(
  url: URL,
  env: Env,
  emit: (event: SSEEvent) => void,
  policy: RunAnalysisPolicy = {},
): Promise<HNLensResult> {
  const knownTerms = (url.searchParams.get('kb') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 80)
  const knownTermsHash = hashString(knownTerms.map(term => term.toLowerCase()).sort().join('|'))
  const { graph, cacheTag } = parseGraph(url.searchParams.get('graph'))
  if (policy.analysisId) {
    emit(buildWorkflowPlan(
      policy.analysisId,
      policy.attempt ?? 1,
      policy.maxAttempts ?? 1,
      graph,
    ))
  }
  const resolved = await resolveInput(url, env)
  if (!resolved) throw new Error('Invalid input: paste a HN link, an article URL, or some text.')

  const { item, articleText, itemType, cacheKey, source } = resolved
  // The quality suffix keeps older seven-day cache entries—some of which were
  // local fallback results—from being replayed as if real agents had succeeded.
  const sharedKey = `${cacheKey}:shared${cacheTag}${CACHE_QUALITY_TAG}`
  const jargonKey = `${cacheKey}:j:${knownTermsHash}${cacheTag}${CACHE_QUALITY_TAG}`
  const fullKey = `${cacheKey}:${knownTermsHash}${cacheTag}${CACHE_QUALITY_TAG}`
  const cachedFull = coerceLegacyResult(
    parseCachedJson(await cacheGet(env, fullKey)) as HNLensResult | null,
  )
  if (isReusableResult(cachedFull)) {
    await replayResult(cachedFull, emit)
    return cachedFull
  }

  const cachedShared = coerceLegacyShared(parseCachedJson(await cacheGet(env, sharedKey)))
  const cachedJargon = coerceLegacyJargon(parseCachedJson(await cacheGet(env, jargonKey)))
  let result: HNLensResult
  if (env.MF_API_TOKEN) {
    try {
      result = await orchestrateAnalysis(item, articleText, itemType, env, emit, {
        kbTerms: knownTerms,
        cachedShared,
        cachedJargon,
        graph,
        requireCriticalAgents: !policy.allowCriticalFallback,
      })
    } catch (error) {
      if (error instanceof CriticalAgentFallbackError) throw error
      const reason = shortError(error)
      emit({
        event: 'error',
        kind: 'orchestration_error',
        message: `Manyfold orchestration failed; using the local fallback result. ${reason}`,
      })
      result = await mockOrchestrate(item, articleText, itemType, emit)
      markLocalFallback(result, reason)
    }
  } else {
    result = await mockOrchestrate(item, articleText, itemType, emit)
    markLocalFallback(result, 'MF_API_TOKEN is not configured.')
  }

  // A fallback the run's own time budget caused is excluded: a second attempt
  // gets the same 12 minutes and would exhaust them the same way, so the reader
  // would wait twice for the same degraded report. It stays uncached either way.
  const criticalFallbacks = (result.flags.fallback_agents ?? []).filter(agent =>
    CRITICAL_RESULT_AGENTS.has(agent) && !result.flags.agent_sources?.[agent]?.budget_limited)
  if (env.MF_API_TOKEN && criticalFallbacks.length && !policy.allowCriticalFallback) {
    // Escape to the queue worker so AnalysisJob can schedule the second durable
    // attempt. Non-critical sections may degrade without restarting the run.
    throw new Error(`Critical agents used fallback output: ${criticalFallbacks.join(', ')}.`)
  }

  result.spec_version = Number(env.SPEC_VERSION) || result.spec_version || 1
  result.source = source
  if (source !== 'hn') result.flags.no_discussion = (item.children?.length ?? 0) === 0
  const shared = {
    summary: result.summary,
    comment_digest: result.comment_digest,
    verdict: result.verdict,
  }
  // Never poison the seven-day cache with local/degraded output. A subsequent
  // request should get a fresh chance after a transient peer/runtime failure.
  if (isReusableResult(result)) {
    await Promise.all([
      cachePut(env, sharedKey, JSON.stringify(shared)),
      cachePut(env, jargonKey, JSON.stringify(result.jargon)),
      cachePut(env, fullKey, JSON.stringify(result)),
    ])
  }
  emit({ event: 'result', data: result })
  return result
}

async function startAnalysisJob(
  env: Env,
  query: string,
  source: AnalysisJobParams['source'],
): Promise<{ id: string; stub: DurableObjectStub<import('../workflow/analysis-job').AnalysisJob> }> {
  const id = crypto.randomUUID()
  const stub = env.ANALYSIS_JOBS.get(env.ANALYSIS_JOBS.idFromName(id))
  await stub.initialize({ jobId: id, query, createdAt: Date.now(), source })
  return { id, stub }
}

function parseGraph(raw: string | null): { graph: GraphConfig | null; cacheTag: string } {
  if (!raw) return { graph: null, cacheTag: '' }
  try {
    const candidate = JSON.parse(decodeURIComponent(raw))
    const graph = candidate && typeof candidate.v === 'number' ? candidate as GraphConfig : null
    return { graph, cacheTag: graph ? `:g${hashString(raw)}` : '' }
  } catch {
    return { graph: null, cacheTag: '' }
  }
}

function parseCachedJson(value: string | null): any {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500)
}

async function replayResult(result: HNLensResult, emit: (event: SSEEvent) => void): Promise<void> {
  emit({ event: 'plan', agents: ['sum', 'jargon', 'comments', 'ctx'] })
  await sleep(60)
  const sections: Array<['sum' | 'jargon' | 'comments' | 'ctx', unknown]> = [
    ['sum', result.summary],
    ['jargon', result.jargon],
    ['comments', result.comment_digest],
    ['ctx', result.verdict],
  ]
  for (const [agent, data] of sections) {
    emit({ event: 'status', agent, state: 'done', mode: 'cache', label: 'Done (cached)' })
    emit({ event: 'section', agent, data })
    await sleep(50)
  }
  emit({ event: 'status', agent: 'synth', state: 'done', mode: 'cache', label: 'Done (cached)' })
  if (result.usage) {
    for (const [agent, tokens] of Object.entries(result.usage.byAgent)) {
      emit({ event: 'usage', agent, tokens })
    }
    emit({ event: 'usage', tokens: 0, total: result.usage.total })
  }
  emit({ event: 'result', data: result })
}

async function resolveInput(url: URL, env: Env): Promise<ResolvedInput | null> {
  const itemIdParam = url.searchParams.get('id')
  const urlParam = url.searchParams.get('url')
  const textParam = url.searchParams.get('text')

  const fromHnId = async (itemId: number, cacheKey: string): Promise<ResolvedInput> => {
    const item = await fetchHNItem(itemId)
    const itemType = detectItemType(item)
    const { text } = await extractArticle(item.url ?? '', item)
    return { item, articleText: text, itemType, cacheKey, source: 'hn' }
  }

  if (itemIdParam) {
    const itemId = parseHNUrl(itemIdParam) ?? parseInt(itemIdParam, 10)
    if (!itemId || isNaN(itemId)) return null
    return fromHnId(itemId, `result:${itemId}:v${env.SPEC_VERSION}`)
  }

  if (urlParam) {
    const normalizedUrl = normalizeUrl(urlParam)
    if (!normalizedUrl) return null
    const hnItemId = parseHNUrl(normalizedUrl)
    if (hnItemId) return fromHnId(hnItemId, `result:${hnItemId}:v${env.SPEC_VERSION}`)

    const hnResult = await searchHNByUrl(normalizedUrl)
    if (hnResult && hnResult.num_comments > 0) {
      return fromHnId(hnResult.id, `result:${hnResult.id}:v${env.SPEC_VERSION}`)
    }

    const { text, title, paywalled } = await extractFromUrl(normalizedUrl)
    const itemType: ItemType = paywalled
      ? 'paywalled'
      : normalizedUrl.toLowerCase().split('?')[0].endsWith('.pdf') ? 'pdf' : 'article'
    const item = syntheticItem(title || hostname(normalizedUrl) || 'Article', normalizedUrl, '')
    return {
      item,
      articleText: text,
      itemType,
      cacheKey: `result:u:${hashString(normalizedUrl)}:v${env.SPEC_VERSION}`,
      source: 'article',
    }
  }

  if (textParam) {
    const text = textParam.slice(0, 8000)
    if (!text.trim()) return null
    const title = (text.split('\n').find(line => line.trim()) || 'Pasted text').trim().slice(0, 60)
    return {
      item: syntheticItem(title, '', text),
      articleText: text,
      itemType: 'article',
      cacheKey: `result:t:${hashString(text)}:v${env.SPEC_VERSION}`,
      source: 'text',
    }
  }

  return null
}

function syntheticItem(title: string, url: string, text: string): HNItem {
  return {
    id: 0,
    title,
    url: url || undefined,
    text: text || null,
    author: '',
    points: 0,
    created_at: new Date().toISOString(),
    children: [],
    type: 'story',
  }
}

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    return new URL(withScheme).toString()
  } catch {
    return ''
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
