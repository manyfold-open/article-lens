import type {
  Env, HNItem, HNComment, ItemType, SSEEvent, AgentName, HNLensResult,
  JargonTerm, BiStr, GraphConfig, Effort,
} from '../schema'
import { getSubtrees } from '../hn'
import { stripHtml } from '../extract'
import { buildMockResult } from './mock'
import { callMfAgent } from './mf'
import { parseLoose } from './json'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ── zh-first helpers ──────────────────────────────────────────────
// Agents now generate Chinese only (to save tokens); English is fetched lazily
// by the client via /api/translate. Everything is still stored as BiStr so the
// schema and UI are unchanged — the `en` field just starts empty.
const bz = (zh = ''): BiStr => ({ en: '', zh })
function toBi(v: unknown): BiStr {
  if (v == null) return bz('')
  if (typeof v === 'string') return bz(v)
  const o = v as { en?: string; zh?: string }
  return { en: o.en || '', zh: o.zh || o.en || '' }
}

export type SharedSections = Pick<HNLensResult, 'summary' | 'comment_digest' | 'verdict'>

// ── Token meter ────────────────────────────────────────────────────
// Estimate tokens ≈ (promptChars + responseChars) / 2.5 (matches the comment
// pipeline's blended CJK/en heuristic). We measure at each agent call site
// where we hold both the prompt(s) sent and the text returned; an agent may
// call the runtime several times (jargon windows, comment map→reduce) so we
// accumulate chars per agent and convert once when the agent resolves.
const USAGE_CHARS_PER_TOKEN = 2.5
const estTokens = (chars: number) => Math.ceil(chars / USAGE_CHARS_PER_TOKEN)

interface UsageMeter {
  // Accumulate raw prompt+response chars for an agent across its calls.
  add(agent: AgentName, promptChars: number, responseChars: number): void
  // Convert an agent's accumulated chars to tokens, emit a usage SSE, and lock
  // in its byAgent total. Safe to call once per agent after it resolves.
  finish(agent: AgentName): void
  byAgent: Record<string, number>
  total(): number
}

function makeMeter(emit: (e: SSEEvent) => void): UsageMeter {
  const chars: Partial<Record<AgentName, number>> = {}
  const byAgent: Record<string, number> = {}
  return {
    add(agent, promptChars, responseChars) {
      chars[agent] = (chars[agent] ?? 0) + promptChars + responseChars
    },
    finish(agent) {
      const tokens = estTokens(chars[agent] ?? 0)
      byAgent[agent] = tokens
      emit({ event: 'usage', agent, tokens })
    },
    byAgent,
    total() {
      return Object.values(byAgent).reduce((a, b) => a + b, 0)
    },
  }
}

interface OrchestrateOpts {
  kbTerms?: string[]
  cachedShared?: SharedSections | null
  cachedJargon?: JargonTerm[] | null
  // Optional client-supplied orchestration graph (v1). When present & valid it
  // OVERRIDES the captain's run/skip decisions and can group stage-1 workers
  // into sequential "relay" chains. The no-graph path is unaffected.
  graph?: GraphConfig | null
}

type WorkerAgent = Exclude<AgentName, 'synth'>
type RouteAction = 'run' | 'skip' | 'reuse'
interface RouteAssignment {
  agent: WorkerAgent
  action: RouteAction
  reason: BiStr
}
interface CaptainPlan {
  route: BiStr
  assignments: RouteAssignment[]
}

// ── Mock orchestration (SSE-driven, no external deps) ─────────────
export async function mockOrchestrate(
  item: HNItem,
  articleText: string,
  itemType: ItemType,
  emit: (event: SSEEvent) => void
): Promise<HNLensResult> {
  const result = buildMockResult(item, articleText, itemType)
  const order: AgentName[] = ['sum', 'jargon', 'comments', 'ctx']

  emit({ event: 'plan', agents: order })
  for (const a of order) {
    emit({ event: 'status', agent: a, state: 'running', label: LABELS[a].running })
    await sleep(120)
  }
  await sleep(320)
  emit({ event: 'status', agent: 'sum', state: 'done', label: bz('TL;DR 完成!') })
  emit({ event: 'section', agent: 'sum', data: result.summary })
  await sleep(260)
  emit({ event: 'status', agent: 'jargon', state: 'done', label: bz(`找到 ${result.jargon.length} 個詞! 💡`) })
  emit({ event: 'section', agent: 'jargon', data: result.jargon })
  await sleep(260)
  emit({ event: 'status', agent: 'comments', state: 'done', label: bz(`分成 ${result.comment_digest.camps.length} 派!`) })
  emit({ event: 'section', agent: 'comments', data: result.comment_digest })
  await sleep(260)
  emit({ event: 'status', agent: 'ctx', state: 'done', label: bz('裁定完成!') })
  emit({ event: 'section', agent: 'ctx', data: result.verdict })
  await sleep(220)
  return result
}

// ── Main orchestration ────────────────────────────────────────────
// Stage 1 (parallel): 小摘 summary · 小詞 jargon (KB-aware) · 小潛 comments.
// Stage 2: 小導 verdict — runs AFTER, fed the summary + comment overview.
// Then 統整/Synthesizer integrates + QA-prunes and the caller emits the final.
export async function orchestrateAnalysis(
  item: HNItem,
  articleText: string,
  itemType: ItemType,
  env: Env,
  emit: (event: SSEEvent) => void,
  opts: OrchestrateOpts = {}
): Promise<HNLensResult> {
  const mock = buildMockResult(item, articleText, itemType)
  const graph = normalizeGraph(opts.graph)
  const captain = buildCaptainPlan(item, articleText, itemType, opts)
  // Reflect graph.enabled in the emitted plan/briefing so the office shows the
  // right set, but keep no-graph behaviour byte-for-byte identical.
  if (graph) applyGraphToPlan(captain, graph)
  emit({ event: 'plan', agents: ['sum', 'jargon', 'comments', 'ctx'] })
  emit({ event: 'section', agent: 'ctx', data: { briefing: captain } })

  const haveShared = !!opts.cachedShared
  const haveJargon = Array.isArray(opts.cachedJargon)
  const fallbackAgents = new Set<AgentName>()
  const skippedAgents = new Set<AgentName>()
  const agentSources: NonNullable<HNLensResult['flags']['agent_sources']> = {}
  const meter = makeMeter(emit)
  // Effort per agent: from the graph when present, else 'med' (= today).
  const eff: Record<EffortAgent, Effort> = graph
    ? graph.effort
    : { sum: 'med', jargon: 'med', comments: 'med' }

  let summary: HNLensResult['summary']
  let comment_digest: HNLensResult['comment_digest']
  let jargon: JargonTerm[]
  let verdict: HNLensResult['verdict']

  if (graph) {
    // ── Graph-driven stage 1 (enabled override + relay groups) ────
    // Per-agent producers honour cache reuse first, then the enabled override
    // (false → force skip), else run as today (optionally with relay context).
    // vote ×N: run the quiet single-run producer `n` times in parallel (a failed
    // replica doesn't kill the batch), merge per the shared contract, then emit
    // ONE status/section and finish the meter ONCE. n=1 → the plain producer,
    // byte-for-byte today. Composes with effort (each replica uses the node's
    // effort via `single`) and relay (the merged output is threaded downstream).
    const withReplicas = async <T>(
      agent: Stage1Agent, n: number,
      single: (quiet: boolean) => Promise<T>,
      merge: (results: Awaited<T>[]) => Awaited<T>,
      doneLabel: (merged: Awaited<T>) => BiStr,
    ): Promise<Awaited<T>> => {
      if (n <= 1) return await single(false)
      emit({ event: 'status', agent, state: 'running', label: LABELS[agent].running })
      const settled = await Promise.allSettled(Array.from({ length: n }, () => single(true)))
      const ok = settled.filter((s): s is PromiseFulfilledResult<Awaited<T>> => s.status === 'fulfilled').map(s => s.value)
      // All replicas threw (rare — producers already swallow errors into fallback):
      // fall back to a single non-quiet run so the office still gets one section.
      if (!ok.length) return await single(false)
      const merged = merge(ok)
      emit({ event: 'status', agent, state: 'done', label: doneLabel(merged) })
      emit({ event: 'section', agent, data: merged })
      meter.finish(agent)
      return merged
    }

    const runSum = (extra?: string): Promise<HNLensResult['summary']> =>
      haveShared ? replaySection('sum', opts.cachedShared!.summary, emit, agentSources)
        : graph.enabled.sum === false ? skipSummary(mock, emit, skippedAgents, agentSources)
          : withReplicas('sum', graph.replicas.sum,
              q => runSummary(env, item, articleText, itemType, mock, emit, fallbackAgents, agentSources, extra, eff.sum, meter, q),
              bestSummary, () => bz('TL;DR 完成!'))
    const runCom = (extra?: string): Promise<HNLensResult['comment_digest']> =>
      haveShared ? replaySection('comments', opts.cachedShared!.comment_digest, emit, agentSources)
        : graph.enabled.comments === false ? skipComments(mock, emit, skippedAgents, agentSources)
          : withReplicas('comments', graph.replicas.comments,
              q => runComments(env, item, mock, emit, fallbackAgents, agentSources, extra, eff.comments, meter, q),
              bestDigest, () => LABELS.comments.done)
    const runJar = (extra?: string): Promise<JargonTerm[]> =>
      haveJargon ? replaySection('jargon', opts.cachedJargon!, emit, agentSources)
        : graph.enabled.jargon === false ? skipJargon(emit, skippedAgents, agentSources)
          : withReplicas('jargon', graph.replicas.jargon,
              q => runJargon(env, item, articleText, opts.kbTerms ?? [], emit, fallbackAgents, agentSources, extra, eff.jargon, meter, q),
              mergeJargonReplicas, m => bz(`找到 ${m.length} 個詞!`))
    // ctx producer, parameterised by the comment_digest to feed it (cheap phase
    // passes an empty digest — summary-only is fine for a quick worth-reading call).
    const runCtx = (cd: HNLensResult['comment_digest']): Promise<HNLensResult['verdict']> =>
      haveShared ? replaySection('ctx', opts.cachedShared!.verdict, emit, agentSources)
        : graph.enabled.ctx === false ? skipContext(mock, emit, skippedAgents, agentSources)
          : runContext(env, item, summary, cd, mock, emit, fallbackAgents, agentSources, meter)

    if (opts.graph?.escalate) {
      // ── Conditional escalate (省錢漸進): cheap first, escalate if worthy ──
      // Phase 1 (cheap): sum + ctx only. ctx runs on the summary alone (empty
      // comment_digest) — good enough for a quick "is it worth reading" call.
      summary = await runSum()
      const emptyDigest = normalizeDigest({
        overview: bz(''), camps: [], consensus: bz(''), disputes: [], expert_corrections: [], spicy: [],
      })
      verdict = await runCtx(emptyDigest)

      // Decision: read a machine-readable worth-reading boolean from the verdict.
      const go = isWorthReading(verdict)
      emit({ event: 'escalate', decision: go ? 'go' : 'stop', reason: escalateReason(verdict, go) })

      if (go) {
        // Escalate: now run the fuller workers (respecting enabled/effort/replicas
        // /groups). If the user disabled jargon/comments they stay skipped even on
        // 'go' (runJar/runCom honour graph.enabled). Keep phase-1 verdict as-is.
        const stage1 = await runStage1Graph(graph, {
          sum: async () => summary,               // already produced in phase 1
          comments: runCom,
          jargon: runJar,
        })
        comment_digest = stage1.comments
        jargon = stage1.jargon
      } else {
        // Not worth reading: skip jargon + comments via the existing skip path so
        // their sections are empty, then let synth run over what exists.
        comment_digest = await skipComments(mock, emit, skippedAgents, agentSources)
        jargon = await skipJargon(emit, skippedAgents, agentSources)
      }
    } else {
      const stage1 = await runStage1Graph(graph, { sum: runSum, comments: runCom, jargon: runJar })
      summary = stage1.sum
      comment_digest = stage1.comments
      jargon = stage1.jargon

      // ── Stage 2: ctx, unchanged ordering — only enabled/disabled. ──
      verdict = await runCtx(comment_digest)
    }
  } else {
    // ── Stage 1: parallel ──────────────────────────────────────────
    const summaryP: Promise<HNLensResult['summary']> = haveShared
      ? replaySection('sum', opts.cachedShared!.summary, emit, agentSources)
      : runSummary(env, item, articleText, itemType, mock, emit, fallbackAgents, agentSources, undefined, eff.sum, meter)

    const commentsP: Promise<HNLensResult['comment_digest']> = haveShared
      ? replaySection('comments', opts.cachedShared!.comment_digest, emit, agentSources)
      : shouldRun(captain, 'comments')
        ? runComments(env, item, mock, emit, fallbackAgents, agentSources, undefined, eff.comments, meter)
        : skipComments(mock, emit, skippedAgents, agentSources)

    const jargonP: Promise<JargonTerm[]> = haveJargon
      ? replaySection('jargon', opts.cachedJargon!, emit, agentSources)
      : shouldRun(captain, 'jargon')
        ? runJargon(env, item, articleText, opts.kbTerms ?? [], emit, fallbackAgents, agentSources, undefined, eff.jargon, meter)
        : skipJargon(emit, skippedAgents, agentSources)

    const [summaryR, comment_digestR] = await Promise.all([summaryP, commentsP])
    summary = summaryR
    comment_digest = comment_digestR

    // ── Stage 2: verdict, now that it can see real content ──────────
    verdict = haveShared
      ? await replaySection('ctx', opts.cachedShared!.verdict, emit, agentSources)
      : await runContext(env, item, summary, comment_digest, mock, emit, fallbackAgents, agentSources, meter)

    jargon = await jargonP
  }

  // ── Assemble ────────────────────────────────────────────────────
  const result: HNLensResult = {
    item_id: item.id,
    spec_version: Number(env.SPEC_VERSION) || 1,
    type: itemType,
    title: { en: '', zh: item.title },
    url: item.url ?? '',
    meta: { points: item.points, comments: item.children?.length ?? 0, author: item.author, age: '' },
    verdict,
    jargon,
    summary,
    comment_digest,
    flags: {
      low_confidence: !articleText,
      comments_sampled: commentsWereSampled(item),
      fallback_agents: [...fallbackAgents],
      skipped_agents: [...skippedAgents],
      agent_sources: agentSources,
    },
    briefing: captain,
  }

  // ── Synthesizer: integration + QA prune ─────────────────────────
  await curate(env, item, result, emit, agentSources, meter)

  // ── Token meter: finalise total + per-agent, emit a closing usage. ──
  result.usage = { total: meter.total(), byAgent: meter.byAgent }
  emit({ event: 'usage', tokens: 0, total: result.usage.total })
  return result
}

// Replay a cached/known section: flash the worker done + emit the section.
async function replaySection<T>(
  agent: AgentName,
  data: T,
  emit: (e: SSEEvent) => void,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<T> {
  if (agentSources) agentSources[agent] = { mode: 'cache', reason: bz('這段直接使用上一輪快取，沒有重新呼叫 agent。') }
  emit({ event: 'status', agent, state: 'done', label: LABELS[agent].done })
  emit({ event: 'section', agent, data })
  return data
}

function buildCaptainPlan(
  item: HNItem,
  articleText: string,
  itemType: ItemType,
  opts: OrchestrateOpts
): CaptainPlan {
  const comments = item.children?.length ?? 0
  const textLen = (articleText || item.text || '').trim().length
  const title = item.title || ''
  const cachedShared = !!opts.cachedShared
  const cachedJargon = Array.isArray(opts.cachedJargon)
  const looksTechnical = isLikelyTechnical(title, articleText)
  const assignments: RouteAssignment[] = [
    {
      agent: 'sum',
      action: cachedShared ? 'reuse' : 'run',
      reason: cachedShared ? bz('摘要已在快取裡，直接拿來用。') : bz('先讀文章，抓出一句話和重點。'),
    },
    {
      agent: 'jargon',
      action: cachedJargon ? 'reuse' : (looksTechnical && textLen >= 220 ? 'run' : 'skip'),
      reason: cachedJargon
        ? bz('術語清單已依你的生詞本快取。')
        : looksTechnical && textLen >= 220
          ? bz('內容看起來有技術密度，請小詞挑真正會卡住的詞。')
          : bz('內容太短或不像技術文，先不硬找術語。'),
    },
    {
      agent: 'comments',
      action: cachedShared ? 'reuse' : (comments >= 3 ? 'run' : 'skip'),
      reason: cachedShared
        ? bz('留言摘要已在快取裡，直接拿來用。')
        : comments >= 3
          ? bz(commentsWereSampled(item) ? '留言很多，挑高訊號串分析。' : '留言量足夠，請小潛整理派別。')
          : bz('留言太少，沒有必要做派別分析。'),
    },
    {
      agent: 'ctx',
      action: cachedShared ? 'reuse' : 'run',
      reason: cachedShared ? bz('裁定已在快取裡。') : bz('等摘要和留言輪廓出來後，再判斷值不值得讀。'),
    },
  ]
  const route = assignments
    .map(a => `${agentZh(a.agent)}:${a.action === 'run' ? '開工' : a.action === 'reuse' ? '拿快取' : '略過'}`)
    .join(' · ')
  return { route: bz(route), assignments }
}

function shouldRun(plan: CaptainPlan, agent: WorkerAgent): boolean {
  return (plan.assignments.find(a => a.agent === agent)?.action || 'run') === 'run'
}

// ── Graph (v1) helpers ─────────────────────────────────────────────
type Stage1Agent = 'sum' | 'jargon' | 'comments'
// Agents whose effort knob changes concrete params. ctx/synth are effort-less.
type EffortAgent = 'sum' | 'jargon' | 'comments'
interface NormalizedGraph {
  enabled: Partial<Record<'sum' | 'jargon' | 'comments' | 'ctx', boolean>>
  // Per-agent effort (defaults 'med' = today). Only sum/jargon/comments matter.
  effort: Record<EffortAgent, Effort>
  // Per-agent replicas / vote ×N (defaults 1 = today). Only sum/jargon/comments.
  replicas: Record<EffortAgent, number>
  groups: { members: Stage1Agent[]; mode: 'parallel' | 'relay' }[]
}

const STAGE1: Stage1Agent[] = ['sum', 'jargon', 'comments']
function isStage1(s: string): s is Stage1Agent {
  return s === 'sum' || s === 'jargon' || s === 'comments'
}

function normEffort(e: unknown): Effort {
  return e === 'low' || e === 'high' ? e : 'med'
}

// Clamp a per-node replicas value into a sane range. Absent/invalid/≤1 → 1
// (= today's single run). Capped at 3 to bound fan-out (and cost).
function normReplicas(r: unknown): number {
  const n = typeof r === 'number' && Number.isFinite(r) ? Math.floor(r) : 1
  return Math.min(3, Math.max(1, n))
}

// Validate + normalise a client graph into something safe to execute. Returns
// null if it isn't a usable v1/v2 object, so callers fall back to today's path.
// v2: derive enabled+effort from `nodes`. v1: fall back to the legacy `enabled`
// map with effort 'med' throughout (so v1 graphs keep today's params).
function normalizeGraph(g: GraphConfig | null | undefined): NormalizedGraph | null {
  if (!g || typeof g.v !== 'number') return null
  const effort: Record<EffortAgent, Effort> = { sum: 'med', jargon: 'med', comments: 'med' }
  const replicas: Record<EffortAgent, number> = { sum: 1, jargon: 1, comments: 1 }
  let enabled: NormalizedGraph['enabled']
  if (g.nodes && typeof g.nodes === 'object') {
    // ── v2: nodes carry per-agent enabled + effort + replicas ───────
    enabled = {}
    for (const a of ['sum', 'jargon', 'comments', 'ctx'] as const) {
      const n = g.nodes[a]
      if (n && typeof n === 'object' && n.enabled === false) enabled[a] = false
    }
    for (const a of ['sum', 'jargon', 'comments'] as const) {
      const n = g.nodes[a]
      if (n && typeof n === 'object') { effort[a] = normEffort(n.effort); replicas[a] = normReplicas(n.replicas) }
    }
  } else {
    // ── v1: legacy skip map, all agents at 'med' (= today's params) ──
    enabled = (g.enabled && typeof g.enabled === 'object') ? g.enabled : {}
  }
  const rawGroups = Array.isArray(g.groups) ? g.groups : []
  const groups: NormalizedGraph['groups'] = []
  for (const grp of rawGroups) {
    if (!grp || !Array.isArray(grp.members)) continue
    // Keep only stage-1 workers (sum/jargon/comments); ctx is never grouped.
    const members = grp.members.filter(isStage1)
    if (!members.length) continue
    groups.push({ members, mode: grp.mode === 'relay' ? 'relay' : 'parallel' })
  }
  return { enabled, effort, replicas, groups }
}

// Mirror graph.enabled into the captain plan so the office shows the right set.
function applyGraphToPlan(plan: CaptainPlan, graph: NormalizedGraph): void {
  for (const a of plan.assignments) {
    if (graph.enabled[a.agent] === false) {
      a.action = 'skip'
      a.reason = bz('你在編輯面板把這位關掉了，這輪直接略過。')
    }
  }
  plan.route = bz(plan.assignments
    .map(a => `${agentZh(a.agent)}:${a.action === 'run' ? '開工' : a.action === 'reuse' ? '拿快取' : '略過'}`)
    .join(' · '))
}

// Build a substantive digest of a stage-1 agent's output to thread into the
// next relay member's prompt. Richer than a TL;DR: enough for the downstream
// agent to genuinely anchor on the upstream result. Each section is capped so
// the prompt stays sane (key points ≤ 10, camps ≤ 6, terms ≤ 12).
function relayDigest(agent: Stage1Agent, value: unknown): string {
  if (agent === 'sum') {
    const s = value as HNLensResult['summary']
    const kp = (s.key_points ?? []).slice(0, 10).map(k => `- ${k.zh}`).join('\n')
    return [`TL;DR：${s.tldr?.zh || ''}`, kp && `重點：\n${kp}`].filter(Boolean).join('\n')
  }
  if (agent === 'comments') {
    const cd = value as HNLensResult['comment_digest']
    const camps = (cd.camps ?? []).slice(0, 6)
      .map(c => `- ${c.label?.zh || ''}${c.stance?.zh ? `：${c.stance.zh}` : ''}`)
      .join('\n')
    return [`留言輪廓：${cd.overview?.zh || ''}`, camps && `派別：\n${camps}`].filter(Boolean).join('\n')
  }
  // jargon
  const terms = value as JargonTerm[]
  return (terms ?? []).slice(0, 12).map(t => `- ${t.term}：${t.explain?.zh || ''}`).join('\n')
}

// Per-pair directive telling the downstream agent HOW to use the upstream
// output, so relay makes a real, explainable difference from parallel.
function relayDirective(upstream: Stage1Agent, downstream: Stage1Agent): string {
  if (downstream === 'jargon' && upstream === 'sum')
    return '請優先解釋上面摘要強調的核心概念（先把這些講清楚），再補上其他術語，讓術語清單貼合文章真正的主旨。'
  if (downstream === 'jargon' && upstream === 'comments')
    return '除了文章術語，也要收錄上面討論在爭辯／反覆提到的詞（社群特有的行話），不要只看文章。'
  if (downstream === 'comments' && upstream === 'sum')
    return '請依照上面摘要點出的主要主張／段落，來組織留言的派別與爭論（讓派別對應到文章的核心論點）。'
  if (downstream === 'comments' && upstream === 'jargon')
    return '若某個派別的分歧其實卡在上面某個技術術語上，請明確點出是哪個詞。'
  if (downstream === 'sum')
    return '請特別加重上一步強調的重點。'
  return '參考上一步的產出，聚焦在它強調的重點。'
}

// Compose the full relay context block injected into a downstream member's
// prompt: a clearly-labelled upstream digest + the per-pair directive.
function relayContext(upstream: Stage1Agent, downstream: Stage1Agent, value: unknown): string {
  const digest = relayDigest(upstream, value)
  const directive = relayDirective(upstream, downstream)
  return `【接力脈絡 ← 上一步(${agentZh(upstream)})】\n${digest}\n→ ${directive}`
}

interface Stage1Producers {
  sum: (extra?: string) => Promise<HNLensResult['summary']>
  comments: (extra?: string) => Promise<HNLensResult['comment_digest']>
  jargon: (extra?: string) => Promise<JargonTerm[]>
}
interface Stage1Result {
  sum: HNLensResult['summary']
  comments: HNLensResult['comment_digest']
  jargon: JargonTerm[]
}

// Execute stage-1 {sum,jargon,comments} per the graph: parallel groups +
// ungrouped singletons run concurrently (as today); relay groups run their
// members sequentially, threading the previous member's digest forward.
async function runStage1Graph(graph: NormalizedGraph, prod: Stage1Producers): Promise<Stage1Result> {
  const out: Partial<Record<Stage1Agent, unknown>> = {}
  const runOne = (agent: Stage1Agent, extra?: string): Promise<unknown> => {
    const p = (prod[agent] as (e?: string) => Promise<unknown>)(extra)
    return p.then(v => { out[agent] = v; return v })
  }

  // Figure out which stage-1 agents the graph already partitions.
  const grouped = new Set<Stage1Agent>()
  for (const grp of graph.groups) for (const m of grp.members) grouped.add(m)
  // Anything not placed in a group runs concurrently as a singleton (as today).
  const singletons = STAGE1.filter(a => !grouped.has(a))

  const concurrent: Promise<unknown>[] = []
  for (const a of singletons) concurrent.push(runOne(a))

  for (const grp of graph.groups) {
    // Dedup members within a group, preserving listed order.
    const seen = new Set<Stage1Agent>()
    const members = grp.members.filter(m => (seen.has(m) ? false : (seen.add(m), true)))
    if (grp.mode === 'relay') {
      // Sequential chain: each later member gets a digest of the previous one.
      concurrent.push((async () => {
        let prev: { agent: Stage1Agent; value: unknown } | null = null
        for (const m of members) {
          const extra = prev
            ? relayContext(prev.agent, m, prev.value)
            : undefined
          const v = await runOne(m, extra)
          prev = { agent: m, value: v }
        }
      })())
    } else {
      // Parallel group behaves like ungrouped singletons.
      for (const m of members) concurrent.push(runOne(m))
    }
  }

  await Promise.all(concurrent)
  return {
    sum: out.sum as HNLensResult['summary'],
    comments: out.comments as HNLensResult['comment_digest'],
    jargon: out.jargon as JargonTerm[],
  }
}

function agentZh(agent: WorkerAgent): string {
  return ({ sum: '小摘', jargon: '小詞', comments: '小潛', ctx: '小導' } as Record<WorkerAgent, string>)[agent]
}

function isLikelyTechnical(title: string, articleText: string): boolean {
  const text = `${title}\n${articleText}`.toLowerCase()
  if (!text.trim()) return false
  const techTerms = [
    'api', 'database', 'postgres', 'linux', 'kernel', 'compiler', 'runtime', 'javascript', 'typescript',
    'python', 'rust', 'golang', 'llm', 'ai', 'model', 'gpu', 'server', 'cloud', 'security', 'crypto',
    'protocol', 'algorithm', 'vector', 'embedding', 'distributed', 'cache', 'browser', 'webassembly',
    'open source', 'github', 'framework', 'library', 'deployment', 'kubernetes',
  ]
  return techTerms.some(t => text.includes(t)) || /[a-z][a-z0-9_]*(\(\)|::|\/api|\.js|\.ts|\.py)/i.test(text)
}

function commentsWereSampled(item: HNItem): boolean {
  const comments = item.children?.length ?? 0
  return comments >= 10 && topSubtrees(item, 8).length < comments
}

// ── 小摘 summary ───────────────────────────────────────────────────
async function runSummary(
  env: Env, item: HNItem, articleText: string, itemType: ItemType,
  mock: HNLensResult, emit: (e: SSEEvent) => void, fallbackAgents?: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>,
  extraContext?: string, effort: Effort = 'med', meter?: UsageMeter, quiet = false
): Promise<HNLensResult['summary']> {
  if (!quiet) emit({ event: 'status', agent: 'sum', state: 'running', label: LABELS.sum.running })
  try {
    const prompt = buildSummarizerPrompt(item, articleText, itemType, extraContext, effort)
    const text = await callMfAgent(env, env.AGENT_SUMMARIZER, prompt)
    meter?.add('sum', prompt.length, text.length)
    const p = parseLoose<{ tldr?: unknown; key_points?: unknown[] }>(text)
    const summary: HNLensResult['summary'] = (p && p.tldr)
      ? { tldr: toBi(p.tldr), key_points: (Array.isArray(p.key_points) ? p.key_points : []).map(toBi).filter(k => k.zh) }
      : mock.summary
    if (!quiet) {
      emit({ event: 'status', agent: 'sum', state: 'done', label: bz('TL;DR 完成!') })
      emit({ event: 'section', agent: 'sum', data: summary })
    }
    if (agentSources) agentSources.sum = { mode: 'real', reason: bz('小摘實際讀取文章內容後產出。') }
    return summary
  } catch (e) {
    fallbackAgents?.add('sum')
    const sandboxReason = emitSandboxUnavailable('sum', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'sum', state: 'done', label: bz('摘要用備援內容') })
      emit({ event: 'section', agent: 'sum', data: mock.summary })
    }
    if (agentSources) agentSources.sum = { mode: 'fallback', reason: fallbackReason('小摘', e, sandboxReason, '改用本地備援摘要') }
    return mock.summary
  } finally {
    if (!quiet) meter?.finish('sum')
  }
}

// Graph-only: force-skip 小摘 (no captain skip path exists). Mirrors the other
// skip helpers — empty/placeholder section + a done status + skipped source.
async function skipSummary(
  mock: HNLensResult,
  emit: (e: SSEEvent) => void,
  skippedAgents: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<HNLensResult['summary']> {
  skippedAgents.add('sum')
  const empty: HNLensResult['summary'] = { tldr: bz('你在編輯面板把小摘關掉了，這輪沒有產生摘要。'), key_points: [] }
  emit({ event: 'status', agent: 'sum', state: 'done', label: bz('已關閉，略過摘要') })
  emit({ event: 'section', agent: 'sum', data: empty })
  if (agentSources) agentSources.sum = { mode: 'skipped', reason: bz('你在編輯面板關掉小摘，沒有呼叫摘要 agent。') }
  return empty
}

// ── 小導 verdict (depends on summary + comments) ───────────────────
async function runContext(
  env: Env, item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'],
  mock: HNLensResult, emit: (e: SSEEvent) => void, fallbackAgents?: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>, meter?: UsageMeter
): Promise<HNLensResult['verdict']> {
  emit({ event: 'status', agent: 'ctx', state: 'running', label: LABELS.ctx.running })
  try {
    const prompt = buildContextPrompt(item, summary, cd)
    const text = await callMfAgent(env, env.AGENT_CONTEXT, prompt)
    meter?.add('ctx', prompt.length, text.length)
    const p = parseLoose<{ worth_reading?: string; why_frontpage?: unknown; tier?: string }>(text)
    const verdict: HNLensResult['verdict'] = (p && p.worth_reading)
      ? { worth_reading: p.worth_reading as HNLensResult['verdict']['worth_reading'],
          why_frontpage: toBi(p.why_frontpage),
          tier: (p.tier as HNLensResult['verdict']['tier']) || '1min' }
      : mock.verdict
    emit({ event: 'status', agent: 'ctx', state: 'done', label: bz('裁定完成!') })
    emit({ event: 'section', agent: 'ctx', data: verdict })
    if (agentSources) agentSources.ctx = { mode: 'real', reason: bz('小導根據摘要和留言輪廓重新判斷。') }
    return verdict
  } catch (e) {
    fallbackAgents?.add('ctx')
    const sandboxReason = emitSandboxUnavailable('ctx', e, emit)
    emit({ event: 'status', agent: 'ctx', state: 'done', label: bz('裁定用備援內容') })
    emit({ event: 'section', agent: 'ctx', data: mock.verdict })
    if (agentSources) agentSources.ctx = { mode: 'fallback', reason: fallbackReason('小導', e, sandboxReason, '改用本地裁定') }
    return mock.verdict
  } finally {
    meter?.finish('ctx')
  }
}

// ── Escalate decision: read "worth reading" from the verdict ───────
// Primary signal is the machine-readable `verdict.worth_reading`
// ('high'|'medium'|'low'): 'high'/'medium' → worth reading (go), 'low' → stop.
// This is the real recommendation field in the schema, so no heuristic/text
// parsing is needed in the normal case. If it's missing/unrecognised (e.g. the
// agent fell back and produced garbage), default to 'go' — over-delivering is
// safer than silently dropping content. Never throws.
function isWorthReading(verdict: HNLensResult['verdict'] | null | undefined): boolean {
  try {
    const wr = String(verdict?.worth_reading ?? '').trim().toLowerCase()
    if (wr === 'low') return false
    if (wr === 'high' || wr === 'medium') return true
    return true   // unknown / missing → over-deliver
  } catch {
    return true
  }
}

function escalateReason(verdict: HNLensResult['verdict'] | null | undefined, go: boolean): string {
  const wr = String(verdict?.worth_reading ?? '').trim().toLowerCase()
  const known = wr === 'high' || wr === 'medium' || wr === 'low'
  if (go) return known ? `worth_reading=${wr}` : 'worth_reading unknown — over-delivering'
  return `worth_reading=${wr || 'low'}`
}

// Graph-only: force-skip 小導. Mirrors the other skip helpers.
async function skipContext(
  mock: HNLensResult,
  emit: (e: SSEEvent) => void,
  skippedAgents: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<HNLensResult['verdict']> {
  skippedAgents.add('ctx')
  const empty: HNLensResult['verdict'] = {
    worth_reading: mock.verdict.worth_reading,
    why_frontpage: bz('你在編輯面板把小導關掉了，這輪沒有重新裁定。'),
    tier: mock.verdict.tier,
  }
  emit({ event: 'status', agent: 'ctx', state: 'done', label: bz('已關閉，略過裁定') })
  emit({ event: 'section', agent: 'ctx', data: empty })
  if (agentSources) agentSources.ctx = { mode: 'skipped', reason: bz('你在編輯面板關掉小導，沒有呼叫裁定 agent。') }
  return empty
}

// Comment pipeline knobs per effort. 'med' reproduces today's numbers exactly:
// single-thread ranked budget 2600, up to 8 subtrees, ~550-token map budget,
// reduce summaries capped at 8000 chars, standard camps ask.
interface CommentParams {
  rankedBudget: number
  maxSubtrees: number
  mapBudget: number
  reduceCap: number
  campsHint: string
}
function commentParams(effort: Effort): CommentParams {
  if (effort === 'low')
    return { rankedBudget: 1400, maxSubtrees: 4, mapBudget: 350, reduceCap: 4000, campsHint: '只挑最主要的 2-3 個派別（寧缺勿濫）。' }
  if (effort === 'high')
    return { rankedBudget: 3600, maxSubtrees: 12, mapBudget: 750, reduceCap: 12000, campsHint: '盡量涵蓋更多派別（含 vocal-minority／fringe），最多 6 個。' }
  return { rankedBudget: 2600, maxSubtrees: 8, mapBudget: 550, reduceCap: 8000, campsHint: '' }
}

// ── 小潛 comments (token-budgeted, high-signal first) ──────────────
async function runComments(
  env: Env, item: HNItem, mock: HNLensResult, emit: (e: SSEEvent) => void, fallbackAgents?: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>,
  extraContext?: string, effort: Effort = 'med', meter?: UsageMeter, quiet = false
): Promise<HNLensResult['comment_digest']> {
  const commentCount = item.children?.length ?? 0
  if (commentCount === 0) {
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'running', label: bz('這篇沒有 HN 討論') })
      emit({ event: 'status', agent: 'comments', state: 'done', label: bz('無留言') })
      emit({ event: 'section', agent: 'comments', data: mock.comment_digest })
    }
    return mock.comment_digest
  }
  if (!quiet) emit({ event: 'status', agent: 'comments', state: 'running', label: bz(`潛進 ${commentCount} 樓…`) })
  const params = commentParams(effort)
  try {
    const text = await runCommentPipeline(item, env, emit, extraContext, params, meter, quiet)
    const p = parseLoose<HNLensResult['comment_digest']>(text)
    const cd = (p?.overview || p?.camps) ? normalizeDigest(p!) : mock.comment_digest
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'done', label: LABELS.comments.done })
      emit({ event: 'section', agent: 'comments', data: cd })
    }
    if (agentSources) agentSources.comments = { mode: 'real', reason: bz(commentsWereSampled(item) ? '小潛實際分析高訊號留言串。' : '小潛實際分析留言。') }
    return cd
  } catch (e) {
    fallbackAgents?.add('comments')
    const sandboxReason = emitSandboxUnavailable('comments', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'done', label: bz('留言用備援內容') })
      emit({ event: 'section', agent: 'comments', data: mock.comment_digest })
    }
    if (agentSources) agentSources.comments = { mode: 'fallback', reason: fallbackReason('小潛', e, sandboxReason, '改用本地留言摘要') }
    return mock.comment_digest
  } finally {
    if (!quiet) meter?.finish('comments')
  }
}

async function skipComments(
  mock: HNLensResult,
  emit: (e: SSEEvent) => void,
  skippedAgents: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<HNLensResult['comment_digest']> {
  skippedAgents.add('comments')
  const empty = normalizeDigest({
    overview: bz('留言太少，隊長略過小潛的派別分析。'),
    camps: [],
    consensus: bz('尚無足夠討論形成共識。'),
    disputes: [],
    expert_corrections: [],
    spicy: [],
  })
  emit({ event: 'status', agent: 'comments', state: 'done', label: bz('留言太少，略過') })
  emit({ event: 'section', agent: 'comments', data: empty.overview.zh ? empty : mock.comment_digest })
  if (agentSources) agentSources.comments = { mode: 'skipped', reason: bz('留言太少，隊長判斷不用呼叫小潛。') }
  return empty.overview.zh ? empty : mock.comment_digest
}

function normalizeDigest(d: HNLensResult['comment_digest']): HNLensResult['comment_digest'] {
  return {
    overview: toBi(d.overview),
    camps: (d.camps ?? []).map(c => ({
      label: toBi(c.label), stance: toBi(c.stance),
      weight: c.weight || 'majority', quote: c.quote || '', comment_id: c.comment_id || 0,
    })),
    consensus: toBi(d.consensus),
    disputes: (d.disputes ?? []).map(toBi),
    expert_corrections: (d.expert_corrections ?? []).map(ec => ({ correction: toBi(ec.correction), comment_id: ec.comment_id || 0 })),
    spicy: (d.spicy ?? []).map(s => ({ quote: s.quote || '', zh: s.zh || '', comment_id: s.comment_id || 0 })),
  }
}

interface CuratorDecision {
  jargon_keep?: number[]
  key_points_keep?: number[]
  camps_keep?: number[]
  summary_ok?: boolean
  note?: BiStr
}

async function curate(
  env: Env,
  item: HNItem,
  result: HNLensResult,
  emit: (e: SSEEvent) => void,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>,
  meter?: UsageMeter
): Promise<void> {
  if (!result.jargon.length && !result.summary.key_points.length && !result.comment_digest.camps.length) return
  emit({ event: 'status', agent: 'synth', state: 'running', label: bz('整合中…') })
  try {
    const prompt = buildCuratorPrompt(item, result)
    const text = await callMfAgent(env, env.AGENT_SYNTHESIZER, prompt, { timeoutMs: 25_000, attempts: 1 })
    meter?.add('synth', prompt.length, text.length)
    const d = parseLoose<CuratorDecision>(text)
    if (d) applyCuration(result, d)
    emit({ event: 'status', agent: 'synth', state: 'done', label: bz('整合完成!') })
    if (agentSources) agentSources.synth = { mode: 'real', reason: bz('合成實際檢查並修剪各段輸出。') }
  } catch (e) {
    const sandboxReason = emitSandboxUnavailable('synth', e, emit)
    emit({ event: 'status', agent: 'synth', state: 'done', label: bz('整合略過') })
    if (agentSources) agentSources.synth = {
      mode: 'fallback',
      reason: sandboxReason
        ? bz(`合成的 sandbox/runtime 不在線，保留各組原始結果，不再等 QA 修剪。原因：${sandboxReason}`)
        : bz(`合成超過 25 秒或 runtime 失敗；保留各組原始結果，不再等 QA 修剪。原因：${shortErr(e)}`),
    }
  } finally {
    meter?.finish('synth')
  }
}

function keepByIndex<T>(arr: T[], keep?: number[]): T[] {
  if (!Array.isArray(keep) || !keep.length) return arr
  const picked = keep.filter(i => Number.isInteger(i) && i >= 0 && i < arr.length).map(i => arr[i])
  return picked.length ? picked : arr
}

function applyCuration(result: HNLensResult, d: CuratorDecision): void {
  result.jargon = keepByIndex(result.jargon, d.jargon_keep)
  result.summary.key_points = keepByIndex(result.summary.key_points, d.key_points_keep)
  result.comment_digest.camps = keepByIndex(result.comment_digest.camps, d.camps_keep)
  if (d.note && (d.note.en || d.note.zh)) result.editor_note = toBi(d.note)
  if (d.summary_ok === false) result.flags.low_confidence = true
}

function buildCuratorPrompt(item: HNItem, r: HNLensResult): string {
  const jl = r.jargon.map((t, i) => `${i}: ${t.term} — ${t.zh_term} — ${t.explain.zh}`).join('\n')
  const kp = r.summary.key_points.map((k, i) => `${i}: ${k.zh}`).join('\n')
  const camps = r.comment_digest.camps.map((c, i) => `${i}: [${c.weight}] ${c.label.zh} — ${(c.quote || '').slice(0, 80)}`).join('\n')

  return `你是 統整，負責整合與品管。讀者是「會寫程式但不是這個領域的專家」。檢視四個 agent 的產出，決定要保留哪些，並修掉跨段落的不一致。

術語（JARGON）— 先認出本文的核心技術領域，只保留 4-8 個【屬於該技術領域、且對理解本文真正會卡住】的詞；務必刪掉：重複、太顯而易見、循環定義，以及任何離題或非技術的詞（一般英文字、無關專有名詞）：
${jl || '(none)'}

重點（KEY POINTS）— 刪掉冗餘、薄弱、重複的，留下實質的：
${kp || '(none)'}

留言派別（CAMPS）— 刪掉幾乎重複或瑣碎的，留下真正不同的觀點：
${camps || '(none)'}

摘要 TL;DR：${r.summary.tldr.zh || '(none)'}

回傳每個清單「要保留」的 0-based index（子集合，順序不限）、摘要是否合格，以及一句中文編輯註記。
只回傳這個 JSON（不要 markdown；字串值裡不要用 " 字元，用 ' 或「」）：
{"jargon_keep":[0,1,2],"key_points_keep":[0,1],"camps_keep":[0,1],"summary_ok":true,"note":{"zh":"..."}}`
}

// ── Agent caller labels ────────────────────────────────────────────
const LABELS: Record<AgentName, { running: BiStr; done: BiStr }> = {
  sum:      { running: bz('讀文章中…'),   done: bz('TL;DR 完成!') },
  jargon:   { running: bz('找術語中…'),   done: bz('術語解釋完成!') },
  comments: { running: bz('潛進留言區…'), done: bz('留言分析完成!') },
  ctx:      { running: bz('評估文章價值…'), done: bz('裁定完成!') },
  synth:    { running: bz('整合中…'),     done: bz('整合完成!') },
}

// ── Comment pipeline (map → reduce), high-signal first + token budget ──
async function runCommentPipeline(
  item: HNItem, env: Env, emit: (e: SSEEvent) => void, extraContext?: string,
  params: CommentParams = commentParams('med'), meter?: UsageMeter, quiet = false
): Promise<string> {
  const commentCount = item.children?.length ?? 0

  // Small thread: a single call over the (ranked) comments.
  if (commentCount < 10) {
    const allText = rankedCommentsText(item.children ?? [], params.rankedBudget)
    return singleCommentCall(env, allText, item, extraContext, params, meter)
  }

  // Large thread: map-reduce over the highest-signal top-level subtrees.
  const subtrees = topSubtrees(item, params.maxSubtrees)
  const sampled = subtrees.length < commentCount
  if (!quiet) emit({ event: 'step', agent: 'comments',
    label: bz(`挑出 ${subtrees.length} 串高關注留言${sampled ? '（採樣）' : ''}`) })

  const mapResults: string[] = []
  for (let i = 0; i < subtrees.length; i += 5) {
    const batch = subtrees.slice(i, i + 5)
    const results = await Promise.all(batch.map(sub => mapSubtree(env, sub, item.id, params.mapBudget, meter)))
    mapResults.push(...results.filter(Boolean))
    if (!quiet) emit({ event: 'step', agent: 'comments', label: bz(`已摘要 ${Math.min(i + 5, subtrees.length)}/${subtrees.length} 串`) })
  }

  if (!quiet) emit({ event: 'step', agent: 'comments', label: bz('聚類派別分析中…') })
  const reducePrompt = buildCommentReducePrompt(mapResults, item, extraContext, params)
  const reduceText = await callMfAgent(env, env.AGENT_COMMENT_REDUCE, reducePrompt)
  meter?.add('comments', reducePrompt.length, reduceText.length)
  return reduceText
}

async function singleCommentCall(
  env: Env, text: string, item: HNItem, extraContext?: string,
  params: CommentParams = commentParams('med'), meter?: UsageMeter
): Promise<string> {
  const prompt = buildCommentReducePrompt([text], item, extraContext, params)
  const out = await callMfAgent(env, env.AGENT_COMMENT_REDUCE, prompt)
  meter?.add('comments', prompt.length, out.length)
  return out
}

// Rough token estimate: ~4 chars/token for mixed en, ~1.7 for CJK. Use a
// conservative blended 2.5 chars/token so we budget by tokens, not raw chars.
const CHARS_PER_TOKEN = 2.5
const tokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN)

// Score a top-level comment subtree by signal: depth of discussion it spawned
// (replies) + its own substance (length), with earlier (higher-ranked by HN)
// comments favoured via their original position.
function topSubtrees(item: HNItem, max: number): HNComment[][] {
  const subtrees = getSubtrees(item)
  const scored = subtrees.map((sub, idx) => {
    const own = stripHtml(sub[0]?.text ?? '').length
    const replies = sub.length - 1
    // position bonus: earlier top-level comments rank higher on HN
    const posBonus = Math.max(0, 30 - idx) * 4
    return { sub, score: own + replies * 60 + posBonus }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, max).map(s => s.sub)
}

async function mapSubtree(env: Env, subtree: HNComment[], itemId: number, budget = 550, meter?: UsageMeter): Promise<string> {
  // Budget ~`budget` tokens of thread text, highest-signal comments first.
  let used = 0
  const lines: string[] = []
  for (const c of subtree) {
    const t = stripHtml(c.text ?? '')
    if (!t) continue
    const line = `[id:${c.id}] ${c.author ?? 'anon'}: ${t.slice(0, 500)}`
    const tk = tokens(line)
    if (used + tk > budget && lines.length) break
    lines.push(line); used += tk
  }
  const text = lines.join('\n')
  const prompt = `用一個 JSON 物件總結這串 HN 留言（只用中文）。

Thread (item ${itemId}):
${text}

只回傳這個 JSON：
{"stance":{"zh":"..."},"key_claims":[{"zh":"..."}],"is_correction_of_article":false,"sentiment":"agree","top_comment_id":${subtree[0]?.id ?? 0}}`
  try {
    const out = await callMfAgent(env, env.AGENT_COMMENT_MAP, prompt)
    meter?.add('comments', prompt.length, out.length)
    return out
  } catch {
    return ''
  }
}

// Flatten the highest-signal comments (by length) within a token budget.
function rankedCommentsText(comments: HNComment[], budgetTokens: number): string {
  const flat: { c: HNComment; t: string }[] = []
  const walk = (c: HNComment) => {
    const t = stripHtml(c.text ?? '')
    if (t) flat.push({ c, t })
    for (const k of c.children ?? []) walk(k)
  }
  comments.forEach(walk)
  flat.sort((a, b) => b.t.length - a.t.length)
  const lines: string[] = []
  let used = 0
  for (const { c, t } of flat) {
    const line = `[id:${c.id}] ${c.author ?? 'anon'}: ${t.slice(0, 400)}`
    const tk = tokens(line)
    if (used + tk > budgetTokens && lines.length) break
    lines.push(line); used += tk
  }
  return lines.join('\n')
}

// ── Prompt builders (zh-only output) ──────────────────────────────
function buildSummarizerPrompt(item: HNItem, articleText: string, itemType: ItemType, extraContext?: string, effort: Effort = 'med'): string {
  const content = (articleText || item.text || '(no article text available)').slice(0, 6000)
  // effort → how much the summary says. 'med' reproduces today's ask exactly.
  const ask = effort === 'low'
    ? '產出一句精簡的 TL;DR + 最多 3 個最關鍵的重點（寧缺勿濫）。'
    : effort === 'high'
      ? '產出一句 TL;DR + 5-7 個重點，涵蓋更多面向與細節。'
      : '產出一句 TL;DR + 3-4 個重點。'
  return `你是 小摘，精簡的中文摘要員。
${relayBlock(extraContext)}
標題：${item.title}
類型：${itemType}
內容：
${content}

${ask}若內容不足，從標題推測並註明不確定。全部只用中文。

只回傳這個 JSON（不要 markdown；字串值裡不要用 " 字元，用 ' 或「」）：
{"tldr":{"zh":"..."},"key_points":[{"zh":"..."}]}`
}

// A short relay-context block to prepend to a prompt when a previous relay
// member produced output. Empty string when there's nothing to thread.
function relayBlock(extraContext?: string): string {
  return extraContext ? `\n${extraContext}\n` : ''
}

function buildJargonPrompt(
  item: HNItem, articleChunk: string, commentSample: string,
  part: { i: number; n: number }, known: string[], candidates: string[] = [],
  extraContext?: string, effort: Effort = 'med'
): string {
  const where = part.n > 1 ? `（文章第 ${part.i + 1}/${part.n} 段）` : ''
  // effort → per-window term target. 'med' keeps today's "10-16" ask verbatim.
  const target = effort === 'low' ? '4-6' : effort === 'high' ? '12-16' : '10-16'
  const knownLine = known.length
    ? `\n讀者「已經會」這些詞，請務必【跳過】，把預算花在真正新的/較不顯而易見的詞上：\n${known.join('、')}\n`
    : ''
  const candLine = candidates.length
    ? `\n以下是程式從全文掃出的候選詞（可能有雜訊）。請逐一檢視、把屬於本文技術領域且讀者可能不懂的收進來，其餘忽略；也要補上你自己掃到、清單漏掉的詞：\n${candidates.join('、')}\n`
    : ''
  return `你是 小詞，給 HN 讀者的中文術語白話解說員。
${relayBlock(extraContext)}
文章標題：${item.title}

文章內文${where}（仔細讀，從整段挑詞，不要只挑開頭）：
${articleChunk || '(no article text available)'}
${commentSample ? `\nHN 留言取樣（這裡出現的詞 seen_in 標 "comments"）：\n${commentSample}` : ''}
${candLine}${knownLine}
第一步：先判定「這篇文章的核心技術領域」（例如 AI/機器學習、Agent/LLM、資料庫、分散式系統、前端、密碼學…）。
第二步：把【屬於這個技術領域、且一個「會寫程式但非此子領域」的人不會馬上懂】的術語都挑出來 — 這段盡量挑 ${target} 個，寧可多收也不要漏。
※ 務必涵蓋【文章標題點名的核心概念／方法】，以及反覆出現的自創術語，即使是多字詞（例如 'loop engineering'、'context engineering'、'reward model'、'agent loop'）。
目標：縮寫、函式庫/產品/演算法/模型名稱、領域行話與方法（例如 RLHF、PPO、reward model、eval、rubric、grader、rollout、distillation 這類）、不直觀的技術指標、非正式技術新造詞。掃過中段與結尾。

【判斷收錄的標準】：只要「出了這個子領域的人不會馬上懂」就收。
【只在這些情況才跳過】：
- 真正人人都懂的通用詞（如 HTTP、JSON、API、CPU、URL）
- 跟核心技術主題無關的專有名詞（人名、地名、與技術無關的公司名）
- 內文已自我清楚定義的詞，以及上面「已經會」清單裡的詞

每個詞要自評：
- on_topic：true=屬於本文技術領域且相關；false=離題或非技術（會被丟掉）
- difficulty：1-5，「會寫程式但非此領域」的人理解難度
- blocking：true=不懂這個詞就會卡住對本文的理解

解說風格（只用中文）：1-2 句、不要循環定義、不要用行話解釋行話、適時用具體比喻。
zh_term：標準中文名稱或描述性中文標籤；seen_in："article"/"comments"/"both"；appeared_as：出現的原句片段。

只回傳這個 JSON 陣列（不要 markdown；字串值裡不要用 " 字元，用 ' 或「」）：
[{"term":"...","zh_term":"...","explain":{"zh":"..."},"seen_in":"article","appeared_as":"source phrase","on_topic":true,"difficulty":3,"blocking":true}]`
}

async function runJargon(
  env: Env, item: HNItem, articleText: string, kbTerms: string[], emit: (e: SSEEvent) => void,
  fallbackAgents?: Set<AgentName>, agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>,
  extraContext?: string, effort: Effort = 'med', meter?: UsageMeter, quiet = false
): Promise<JargonTerm[]> {
  if (!quiet) emit({ event: 'status', agent: 'jargon', state: 'running', label: LABELS.jargon.running })
  const full = (articleText || item.text || '').trim()
  // Cover more of the article (not just the opening) without over-loading each
  // call. Window count is the effort knob: low→1 / med→2 (today) / high→3, run
  // independently (see allSettled below).
  const maxWindows = effort === 'low' ? 1 : effort === 'high' ? 3 : 2
  const windows = chunkText(full, 7000, maxWindows)
  const timeoutMs = jargonTimeoutMs(full)
  const commentSample = sampleCommentsText(item, 1600)
  const known = (kbTerms || []).filter(Boolean).slice(0, 80)
  // Surface-form candidates extracted by rule → grounds the model so it doesn't
  // just recall a few obvious terms from memory. Capped to keep the prompt light.
  const candidates = extractCandidates(item.title + '\n' + full + '\n' + commentSample, known).slice(0, 25)
  try {
    const prompts = windows.length === 0
      ? [buildJargonPrompt(item, '', commentSample, { i: 0, n: 1 }, known, candidates, extraContext, effort)]
      : windows.map((w, i) => buildJargonPrompt(item, w, i === 0 ? commentSample : '', { i, n: windows.length }, known, candidates, i === 0 ? extraContext : undefined, effort))
    if (prompts.length > 1 && !quiet) emit({ event: 'step', agent: 'jargon', label: bz(`通讀全文 ${prompts.length} 段…`) })
    // Run windows independently — a slow/failed window must NOT zero the rest.
    const settled = await Promise.allSettled(prompts.map(p =>
      callMfAgent(env, env.AGENT_JARGON, p, { timeoutMs, attempts: 1 })))
    // Meter each window that returned: sum its prompt + response chars.
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') meter?.add('jargon', prompts[i].length, s.value.length)
    })
    const outputs = settled.filter((s): s is PromiseFulfilledResult<string> => s.status === 'fulfilled').map(s => s.value)
    if (!outputs.length) {
      const rej = settled.find(s => s.status === 'rejected') as PromiseRejectedResult | undefined
      throw rej ? rej.reason : new Error('jargon: no windows returned')
    }
    let merged = mergeJargon(outputs)
    // Hard filter: never show a term the user already knows (case-insensitive).
    const knownSet = new Set(known.map(k => k.trim().toLowerCase()))
    merged = merged.filter(t => !knownSet.has((t.term || '').trim().toLowerCase()))
    if (!quiet) {
      emit({ event: 'status', agent: 'jargon', state: 'done', label: bz(`找到 ${merged.length} 個詞!`) })
      emit({ event: 'section', agent: 'jargon', data: merged })
    }
    if (agentSources) agentSources.jargon = { mode: 'real', reason: bz(`小詞實際分析文章術語；本次最多等待 ${Math.round(timeoutMs / 1000)} 秒。`) }
    return merged
  } catch (e) {
    fallbackAgents?.add('jargon')
    const sandboxReason = emitSandboxUnavailable('jargon', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'jargon', state: 'done', label: bz('術語用備援內容') })
      emit({ event: 'section', agent: 'jargon', data: [] })
    }
    if (agentSources) agentSources.jargon = {
      mode: 'fallback',
      reason: sandboxReason
        ? bz(`小詞的 sandbox/runtime 不在線，為避免整篇卡住，先不顯示術語。原因：${sandboxReason}`)
        : bz(`小詞最多等待 ${Math.round(timeoutMs / 1000)} 秒；這次沒有及時回覆，為避免整篇卡住，先不顯示術語。原因：${shortErr(e)}`),
    }
    return []
  } finally {
    if (!quiet) meter?.finish('jargon')
  }
}

async function skipJargon(
  emit: (e: SSEEvent) => void,
  skippedAgents: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<JargonTerm[]> {
  skippedAgents.add('jargon')
  emit({ event: 'status', agent: 'jargon', state: 'done', label: bz('非技術文，略過術語') })
  emit({ event: 'section', agent: 'jargon', data: [] })
  if (agentSources) agentSources.jargon = { mode: 'skipped', reason: bz('隊長判斷內容太短或不像技術文，沒有呼叫小詞。') }
  return []
}

function jargonTimeoutMs(text: string): number {
  // The bottleneck is generating 10-16 explanations, not reading the input —
  // so even short articles need a generous budget. (Empirically the agent does
  // ~5 terms in ~12s; a full pass with the candidate list can take 40-70s.)
  return text.length > 9000 ? 100_000 : 80_000
}

function shortErr(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  return s.replace(/\s+/g, ' ').slice(0, 120)
}

function sandboxUnavailableReason(e: unknown): string | null {
  const msg = shortErr(e)
  const s = msg.toLowerCase()
  const hasDownWord = /(not\s+alive|not\s+running|unavailable|stopped|terminated|dead|no\s+live|offline|502|503)/.test(s)
  const mentionsRuntime = /(sandbox|runtime|container|worker|workerd)/.test(s)
  const explicit = /(sandbox.*not.*alive|not.*alive.*sandbox|runtime.*502|sandbox.*502)/.test(s)
  return (explicit || (mentionsRuntime && hasDownWord)) ? msg : null
}

function emitSandboxUnavailable(agent: AgentName, e: unknown, emit: (event: SSEEvent) => void): string | null {
  const reason = sandboxUnavailableReason(e)
  if (reason) emit({ event: 'error', agent, kind: 'sandbox_unavailable', message: reason })
  return reason
}

function fallbackReason(agentZh: string, e: unknown, sandboxReason: string | null, fallbackText: string): BiStr {
  if (sandboxReason) return bz(`${agentZh} 的 sandbox/runtime 不在線，${fallbackText}。原因：${sandboxReason}`)
  return bz(`${agentZh}未能順利回覆，${fallbackText}。原因：${shortErr(e)}`)
}

function chunkText(text: string, size: number, maxWindows: number): string[] {
  if (!text) return []
  const capped = text.slice(0, size * maxWindows)
  const n = Math.min(maxWindows, Math.max(1, Math.ceil(capped.length / size)))
  const win = Math.ceil(capped.length / n)
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(capped.slice(i * win, (i + 1) * win))
  return out
}

function sampleCommentsText(item: HNItem, maxLen: number): string {
  const lines: string[] = []
  let total = 0
  for (const c of item.children ?? []) {
    const t = stripHtml(c.text ?? '').slice(0, 220)
    if (!t) continue
    lines.push(`- ${t}`)
    total += t.length
    if (total >= maxLen) break
  }
  return lines.join('\n')
}

function mergeJargon(outputs: string[]): JargonTerm[] {
  const byTerm = new Map<string, JargonTerm>()
  for (const out of outputs) {
    const parsed = parseLoose<unknown>(out)
    const list: JargonTerm[] = Array.isArray(parsed)
      ? parsed as JargonTerm[]
      : (parsed && Array.isArray((parsed as { jargon?: unknown }).jargon))
        ? (parsed as { jargon: JargonTerm[] }).jargon
        : []
    for (const t of list) {
      if (!t || typeof t.term !== 'string' || !t.term.trim()) continue
      // Domain gate: drop off-topic / non-technical terms the agent flagged.
      if (t.on_topic === false) continue
      t.explain = toBi(t.explain)
      const key = normTerm(t.term)                 // merge case / spacing / singular-plural
      const prev = byTerm.get(key)
      if (!prev) { byTerm.set(key, t); continue }
      if (prev.seen_in !== t.seen_in) prev.seen_in = 'both'
      const prevLen = (prev.explain?.zh?.length ?? 0)
      const curLen = (t.explain?.zh?.length ?? 0)
      if (curLen > prevLen) { t.seen_in = prev.seen_in; byTerm.set(key, t) }
    }
  }
  // Rank by signal: blocking first, then difficulty, then appears in both
  // article+comments (more salient), then explanation richness. Keep the top 10.
  const score = (t: JargonTerm) =>
    (t.blocking ? 100 : 0) +
    (typeof t.difficulty === 'number' ? t.difficulty * 10 : 20) +
    (t.seen_in === 'both' ? 8 : 0) +
    Math.min(6, (t.explain?.zh?.length ?? 0) / 20)
  const sorted = [...byTerm.values()].sort((a, b) => score(b) - score(a))
  // Second pass: drop near-duplicates (e.g. "hill climbing" vs "hill climbing
  // loop"). Keep the higher-scored one already in `kept`.
  const kept: JargonTerm[] = []
  for (const t of sorted) {
    const n = normTerm(t.term)
    const dup = kept.some(k => {
      const kn = normTerm(k.term)
      const [short, long] = kn.length <= n.length ? [kn, n] : [n, kn]
      return long.includes(short) && short.length / long.length >= 0.6
    })
    if (!dup) kept.push(t)
    if (kept.length >= 16) break
  }
  return kept
}

// ── Replica merge (vote ×N) ────────────────────────────────────────
// Each stage-1 agent may run N times; these merge the N results per the
// shared contract. replicas=1 never reaches here (the caller runs the plain
// producer), so single-run behaviour is untouched.

// jargon: UNION all N term lists then dedup/rank/cap via the existing pipeline.
// Empty replicas contribute nothing, so any non-empty replica yields a
// non-empty merged list — this is the jargon-returns-0 fix.
function mergeJargonReplicas(lists: JargonTerm[][]): JargonTerm[] {
  // Re-encode each replica's already-parsed list as JSON so we can reuse
  // mergeJargon (which parses strings), keeping the dedup/normTerm/cap identical.
  return mergeJargon(lists.filter(l => Array.isArray(l) && l.length).map(l => JSON.stringify(l)))
}

// summary: pick the BEST non-empty result — most key_points, tie → longest
// tldr. If every replica is empty, return the first (keeps empty as today).
function bestSummary(cands: HNLensResult['summary'][]): HNLensResult['summary'] {
  const nonEmpty = cands.filter(s => s && (s.key_points?.length || s.tldr?.zh))
  if (!nonEmpty.length) return cands[0]
  return nonEmpty.reduce((best, s) => {
    const bk = best.key_points?.length ?? 0, sk = s.key_points?.length ?? 0
    if (sk !== bk) return sk > bk ? s : best
    return (s.tldr?.zh?.length ?? 0) > (best.tldr?.zh?.length ?? 0) ? s : best
  })
}

// comments: pick the BEST non-empty digest — most camps, tie → longest
// overview. If every replica is empty, return the first (keeps empty as today).
function bestDigest(cands: HNLensResult['comment_digest'][]): HNLensResult['comment_digest'] {
  const nonEmpty = cands.filter(c => c && (c.camps?.length || c.overview?.zh))
  if (!nonEmpty.length) return cands[0]
  return nonEmpty.reduce((best, c) => {
    const bc = best.camps?.length ?? 0, cc = c.camps?.length ?? 0
    if (cc !== bc) return cc > bc ? c : best
    return (c.overview?.zh?.length ?? 0) > (best.overview?.zh?.length ?? 0) ? c : best
  })
}

// Normalise a term for dedup: lowercase, collapse spaces, strip a trailing
// plural "s" (so "trace"/"traces" and "model"/"models" merge).
function normTerm(s: string): string {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '')
}

// Rule-based candidate terms from the raw text, to ground the model (improves
// recall vs relying on the model to recall terms from memory). Noisy on purpose
// — the model + on_topic filter trim it down.
const CAND_STOP = new Set(['the','a','an','of','in','on','to','for','and','or','with','this','that','these','those','our','your','their','we','you','it','is','are','be','as','at','by','from','how','why','what','when'])
function extractCandidates(text: string, known: string[]): string[] {
  if (!text) return []
  const counts = new Map<string, number>()
  const add = (raw: string) => {
    const t = raw.trim()
    if (t.length < 2 || t.length > 40) return
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  const addPhrase = (raw: string) => {
    const w = raw.trim().replace(/\s+/g, ' ').split(' ')
    while (w.length && CAND_STOP.has(w[0].toLowerCase())) w.shift()   // drop leading "The/Of/…"
    if (w.length >= 2 && w.length <= 3) add(w.join(' '))
  }
  // acronyms / all-caps (RLHF, PPO, SFT, GRPO, RAG, KV, RLVR…)
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]{1,6}\b/g)) add(m[0])
  // CamelCase / product & model names (LangChain, OpenAI, GPT-4o, LlamaIndex…)
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z0-9]+(?:[A-Z][a-zA-Z0-9]+)+\b/g)) add(m[0])
  // hyphenated technical terms (open-weight, fine-tuning, context-window…)
  for (const m of text.matchAll(/\b[a-zA-Z]+(?:-[a-zA-Z]+){1,3}\b/g)) add(m[0])
  // Title-Case multi-word concepts ("Loop Engineering", "Context Window", "Reward Model")
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}\b/g)) addPhrase(m[0])
  // coined "X <tech-noun>" phrases (loop engineering, reward model, agent loop, context window…)
  for (const m of text.matchAll(/\b[a-z][a-z-]+ (?:engineering|loop|model|models|cache|window|tuning|prompt|prompts|agent|agents|eval|evals|reward|distillation|sampling|inference|harness|rollout|trajectory|fine-tuning)\b/gi)) add(m[0].toLowerCase())
  const knownSet = new Set((known || []).map(k => k.trim().toLowerCase()))
  return [...counts.entries()]
    .filter(([t]) => !knownSet.has(t.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 30)
}

function buildContextPrompt(item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest']): string {
  const kp = (summary.key_points ?? []).map(k => `- ${k.zh}`).join('\n')
  // Source-aware: only an actual HN thread gets the "front page / points" framing.
  const isHN = (item.points ?? 0) > 0 || (item.children?.length ?? 0) > 0
  const subject = isHN ? '一篇 Hacker News 貼文' : '一篇文章／一段內容'
  const metaLine = isHN ? `分數：${item.points} · 留言數：${item.children?.length ?? 0}\n` : ''
  const discussion = isHN ? `\n留言整體輪廓：${cd.overview?.zh || '(無討論)'}\n` : ''
  const whyQ = isHN
    ? 'why_frontpage：為什麼值得讀 / 為何會上 HN 首頁？1-2 句，反映上面的實際內容'
    : 'why_frontpage：這篇為什麼值得讀、重點價值是什麼？1-2 句，反映實際內容（不要提「首頁」或分數）'
  return `你是 小導，評估${subject}。請根據「實際內容」判斷${isHN ? '，不要只看分數' : ''}。

標題：${item.title}
${metaLine}文章摘要 TL;DR：${summary.tldr?.zh || '(無)'}
重點：
${kp || '(無)'}
${discussion}
回答三件事（只用中文）：
1. worth_reading："high"（必讀）、"medium"（有趣）或 "low"（可略過）
2. ${whyQ}
3. tier："10s"、"1min" 或 "deep"

只回傳這個 JSON（不要 markdown；字串值裡不要用 " 字元，用 ' 或「」）：
{"worth_reading":"high","why_frontpage":{"zh":"..."},"tier":"deep"}`
}

function buildCommentReducePrompt(
  subtreeSummaries: string[], item: HNItem, extraContext?: string,
  params: CommentParams = commentParams('med')
): string {
  const summaries = subtreeSummaries.filter(Boolean).join('\n\n---\n\n').slice(0, params.reduceCap)
  // effort's camps directive (empty at 'med' → prompt stays byte-for-byte today's).
  const campsLine = params.campsHint ? `${params.campsHint}\n` : ''
  return `你是 小潛，分析「${item.title}」的 Hacker News 討論。
${relayBlock(extraContext)}
總留言數：${item.children?.length ?? 0}

各串摘要：
${summaries}

找出討論的結構：主要派別（majority/vocal-minority/fringe）、共識、主要爭論、對文章的專家糾錯（若有）、最精彩/最辣的一則。
${campsLine}盡量帶上 comment_id 讓讀者能找到原留言。只用中文。

只回傳這個 JSON（不要 markdown；字串值裡不要用 " 字元，用 ' 或「」）：
{"overview":{"zh":"..."},"camps":[{"label":{"zh":"..."},"stance":{"zh":"..."},"weight":"majority","quote":"verbatim excerpt","comment_id":0}],"consensus":{"zh":"..."},"disputes":[{"zh":"..."}],"expert_corrections":[{"correction":{"zh":"..."},"comment_id":0}],"spicy":[{"quote":"...","zh":"...","comment_id":0}]}`
}
