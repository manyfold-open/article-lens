import type {
  Env, HNItem, HNComment, ItemType, SSEEvent, AgentName, HNLensResult,
  JargonTerm, BiStr, GraphConfig, Effort,
} from '../schema'
import { getSubtrees } from '../hn'
import { stripHtml } from '../extract'
import { buildMockResult } from './mock'
import { callMfAgent, isBudgetExhaustedError } from './mf'
import { createRunBudget, stageDeadline, type RunBudget, type Stage } from './budget'
import {
  normalizeGraph,
  type EffortAgent,
  type NormalizedGraph,
  type Stage1Agent,
  STAGE1,
} from './graph'
import {
  parseLoose,
  classifyUnparseable,
  isUnparseableOutputError,
  UnparseableOutputError,
} from './json'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
// Cloudflare Queue consumers have a 15-minute wall-clock ceiling. Reserve
// three minutes for input extraction, final persistence, and runtime jitter;
// every A2A call in one orchestration shares this absolute deadline.
const ORCHESTRATION_BUDGET_MS = 12 * 60_000
// Free Workers allow 50 external subrequests per invocation. A2A gets a shared
// hard budget of 30, leaving 20 for article resolution and other upstream work.
// The normal SSE path uses roughly one token mint plus one stream per peer.
const FREE_WORKERS_A2A_SUBREQUEST_BUDGET = 30
const runRequestBudgets = new WeakMap<(event: SSEEvent) => void, { remaining: number }>()

// Per-run time budget state, keyed by the run's emit function like the request
// budget above, so the stage does not have to be threaded through every worker.
interface RunState {
  budget: RunBudget
  stage: Stage
  // Agents whose fallback was caused by the time budget rather than by the
  // peer. A whole-workflow retry would hit the same wall, so these must not
  // trigger one.
  budgetLimited: Set<AgentName>
}
const runStates = new WeakMap<(event: SSEEvent) => void, RunState>()

// Run `body` with calls charged to `stage`, then restore the previous stage.
// 省钱渐进 runs ctx between two halves of stage 1, so this cannot be monotonic.
async function inStage<T>(
  emit: (event: SSEEvent) => void,
  stage: Stage,
  body: () => Promise<T>,
): Promise<T> {
  const state = runStates.get(emit)
  if (!state) return body()
  const previous = state.stage
  state.stage = stage
  try {
    return await body()
  } finally {
    state.stage = previous
  }
}

function noteBudgetLimit(emit: (event: SSEEvent) => void, agent: AgentName, e: unknown): void {
  if (isBudgetExhaustedError(e)) runStates.get(emit)?.budgetLimited.add(agent)
}

function callAgent(
  env: Env,
  peerId: string,
  prompt: string,
  agent: AgentName,
  emit: (event: SSEEvent) => void,
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<string> {
  const state = runStates.get(emit)
  return callMfAgent(env, peerId, prompt, {
    ...opts,
    deadlineAt: state && stageDeadline(state.budget, state.stage),
    requestBudget: runRequestBudgets.get(emit),
    trace: { agent, emit },
  })
}

// ── zh-first helpers ──────────────────────────────────────────────
// Agents now generate Chinese only (to save tokens); English is fetched lazily
// by the client via /api/translate. Everything is still stored as BiStr so the
// schema and UI are unchanged — the `en` field just starts empty.
const bz = (zh = ''): BiStr => ({ en: '', zh })
// Orchestrator-authored strings (SSE labels, briefing route/reason, agent_sources
// reason) are NOT covered by the client's lazy /api/translate pass (it only
// walks title/summary/jargon/comment_digest/why_frontpage/editor_note) — so
// these need a real `en` baked in at the source, via `bi(zh, en)` below.
const bi = (zh: string, en: string): BiStr => ({ zh, en })
function toBi(v: unknown): BiStr {
  if (v == null) return bz('')
  if (typeof v === 'string') return bz(v)
  const o = v as { en?: string; zh?: string }
  return { en: o.en || '', zh: o.zh || o.en || '' }
}

export type SharedSections = Pick<HNLensResult, 'summary' | 'comment_digest' | 'verdict'>

// ── 受众语气 (reader level) ─────────────────────────────────────────
// A single graph flag shifts the TONE/DEPTH of 小摘/小词/小导/统整 without
// changing which agents run. Absent → today's default (an intermediate dev),
// byte-for-byte.
type Audience = 'beginner' | 'expert'
function normAudience(a: unknown): Audience | undefined {
  return a === 'beginner' || a === 'expert' ? a : undefined
}
// The "读者是…" descriptor shared across prompts.
function readerDesc(a?: Audience): string {
  if (a === 'beginner') return '读者是「刚接触程序／这个领域的新手」'
  if (a === 'expert') return '读者是「该领域的资深专家」'
  return '读者是「会写程序但不是这个领域的专家」'
}
// Per-agent tone directive (leading \n so it slots into a prompt). Empty for the
// default audience so those prompts stay byte-for-byte identical to today.
function audienceDirective(a: Audience | undefined, who: 'sum' | 'jargon' | 'ctx'): string {
  if (!a) return ''
  if (who === 'sum') return a === 'beginner'
    ? '\n受众语气：读者是新手，请用更白话、少术语，必要时补一句背景。'
    : '\n受众语气：读者是专家，可假设他懂基础，直接讲重点与深入细节，不必解释常识。'
  if (who === 'jargon') return a === 'beginner'
    ? '\n受众语气：读者是新手，收录门槛放宽（连中阶常见词也值得解释），解说更浅白、多用比喻。'
    : '\n受众语气：读者是专家，只收真正进阶／冷门／细微的术语，基础与中阶词一律跳过；解说可精简、可用专业语汇。'
  return a === 'beginner'   // ctx
    ? '\n受众语气：读者是新手，判断阅读门槛时标准更严（新手更容易卡）。'
    : '\n受众语气：读者是专家，基础内容对他们门槛低，tier 只在真正有深度时才给 deep。'
}

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
  // First durable job attempt: stop before spending on downstream agents when
  // a critical dependency already degraded. The final attempt may continue and
  // return an explicit fallback result.
  requireCriticalAgents?: boolean
  // Optional client-supplied orchestration graph (v1). When present & valid it
  // OVERRIDES the captain's run/skip decisions and can group stage-1 workers
  // into sequential "relay" chains. The no-graph path is unaffected.
  graph?: GraphConfig | null
}

export class CriticalAgentFallbackError extends Error {
  constructor(readonly agents: AgentName[]) {
    super(`Critical agents used fallback output: ${agents.join(', ')}.`)
    this.name = 'CriticalAgentFallbackError'
  }
}

// A critical agent's fallback normally stops the run so AnalysisJob can take
// its second attempt. A fallback caused by the time budget is excluded: the
// retry would spend another 12 minutes reaching the same wall, so the run
// finishes degraded (and uncached) instead of making the reader wait twice.
function assertCriticalAgents(
  fallbacks: Set<AgentName>,
  required: boolean | undefined,
  agents: AgentName[],
  budgetLimited: Set<AgentName>,
): void {
  if (!required) return
  const failed = agents.filter(agent => fallbacks.has(agent) && !budgetLimited.has(agent))
  if (failed.length) throw new CriticalAgentFallbackError(failed)
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
    emit({ event: 'status', agent: a, state: 'running', mode: 'fallback', label: LABELS[a].running })
    await sleep(120)
  }
  await sleep(320)
  emit({ event: 'status', agent: 'sum', state: 'done', mode: 'fallback', label: bi('TL;DR 完成!', 'TL;DR done!') })
  emit({ event: 'section', agent: 'sum', data: result.summary })
  await sleep(260)
  emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'fallback', label: bi(`找到 ${result.jargon.length} 个词! 💡`, `Found ${result.jargon.length} terms! 💡`) })
  emit({ event: 'section', agent: 'jargon', data: result.jargon })
  await sleep(260)
  emit({ event: 'status', agent: 'comments', state: 'done', mode: 'fallback', label: bi(`分成 ${result.comment_digest.camps.length} 派!`, `Split into ${result.comment_digest.camps.length} camps!`) })
  emit({ event: 'section', agent: 'comments', data: result.comment_digest })
  await sleep(260)
  emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'fallback', label: bi('裁定完成!', 'Verdict is in!') })
  emit({ event: 'section', agent: 'ctx', data: result.verdict })
  await sleep(220)
  return result
}

// ── Main orchestration ────────────────────────────────────────────
// Stage 1 (parallel): 小摘 summary · 小词 jargon (KB-aware) · 小潜 comments.
// Stage 2: 小导 verdict — runs AFTER, fed the summary + comment overview.
// Then 统整/Synthesizer integrates + QA-prunes and the caller emits the final.
export async function orchestrateAnalysis(
  item: HNItem,
  articleText: string,
  itemType: ItemType,
  env: Env,
  emit: (event: SSEEvent) => void,
  opts: OrchestrateOpts = {}
): Promise<HNLensResult> {
  runRequestBudgets.set(emit, { remaining: FREE_WORKERS_A2A_SUBREQUEST_BUDGET })
  const mock = buildMockResult(item, articleText, itemType)
  const graph = normalizeGraph(opts.graph)
  // 辩论裁定 flag rides on the raw graph (like escalate). Applies wherever 小导 runs.
  const debate = !!opts.graph?.debate
  const budgetLimited = new Set<AgentName>()
  runStates.set(emit, {
    budget: createRunBudget(Date.now(), ORCHESTRATION_BUDGET_MS, { debate }),
    stage: 'stage1',
    budgetLimited,
  })
  // 受众语气: reader level shifts tone/depth of sum/jargon/ctx/curator prompts.
  const audience = normAudience(opts.graph?.audience)
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
      single: (
        quiet: boolean,
        replicaFallbacks: Set<AgentName>,
        replicaSources: NonNullable<HNLensResult['flags']['agent_sources']>,
      ) => Promise<T>,
      merge: (results: Awaited<T>[]) => Awaited<T>,
      doneLabel: (merged: Awaited<T>) => BiStr,
    ): Promise<Awaited<T>> => {
      if (n <= 1) return await single(false, fallbackAgents, agentSources)
      emit({ event: 'status', agent, state: 'running', label: LABELS[agent].running })
      const replicaState = Array.from({ length: n }, () => ({
        fallbacks: new Set<AgentName>(),
        sources: {} as NonNullable<HNLensResult['flags']['agent_sources']>,
      }))
      const settled = await Promise.allSettled(replicaState.map(state =>
        single(true, state.fallbacks, state.sources)))
      const fulfilled = settled
        .map((result, index) => ({ result, state: replicaState[index] }))
        .filter((entry): entry is {
          result: PromiseFulfilledResult<Awaited<T>>
          state: typeof replicaState[number]
        } => entry.result.status === 'fulfilled')
      // A successful replica wins over another replica's local fallback. Only
      // mark the whole agent degraded when every completed replica degraded.
      const real = fulfilled.filter(entry => !entry.state.fallbacks.has(agent))
      const usable = real.length ? real : fulfilled
      if (!usable.length) return await single(false, fallbackAgents, agentSources)
      if (!real.length) {
        fallbackAgents.add(agent)
        agentSources[agent] = usable[0].state.sources[agent] ?? {
          mode: 'fallback',
          reason: bi('所有投票副本都使用备援结果。', 'Every voting replica used fallback output.'),
        }
      } else {
        agentSources[agent] = {
          mode: 'real',
          reason: bi(
            `${real.length}/${n} 个投票副本成功，已合并有效结果。`,
            `${real.length}/${n} voting replicas succeeded; merged the valid results.`,
          ),
        }
      }
      const merged = merge(usable.map(entry => entry.result.value))
      emit({ event: 'status', agent, state: 'done', mode: real.length ? 'real' : 'fallback', label: doneLabel(merged) })
      emit({ event: 'section', agent, data: merged })
      meter.finish(agent)
      return merged
    }

    const runSum = (extra?: string): Promise<HNLensResult['summary']> =>
      haveShared ? replaySection('sum', opts.cachedShared!.summary, emit, agentSources)
        : graph.enabled.sum === false ? skipSummary(mock, emit, skippedAgents, agentSources)
          : withReplicas('sum', graph.replicas.sum,
              (q, fallbacks, sources) => runSummary(env, item, articleText, itemType, mock, emit, fallbacks, sources, extra, eff.sum, meter, q, audience),
              bestSummary, () => bi('TL;DR 完成!', 'TL;DR done!'))
    const runCom = (extra?: string): Promise<HNLensResult['comment_digest']> =>
      haveShared ? replaySection('comments', opts.cachedShared!.comment_digest, emit, agentSources)
        : graph.enabled.comments === false ? skipComments(mock, emit, skippedAgents, agentSources)
          : withReplicas('comments', graph.replicas.comments,
              (q, fallbacks, sources) => runComments(env, item, mock, emit, fallbacks, sources, extra, eff.comments, meter, q),
              bestDigest, () => LABELS.comments.done)
    const runJar = (extra?: string): Promise<JargonTerm[]> =>
      haveJargon ? replaySection('jargon', opts.cachedJargon!, emit, agentSources)
        : graph.enabled.jargon === false ? skipJargon(emit, skippedAgents, agentSources)
          : withReplicas('jargon', graph.replicas.jargon,
              (q, fallbacks, sources) => runJargon(env, item, articleText, opts.kbTerms ?? [], emit, fallbacks, sources, extra, eff.jargon, meter, q, audience),
              mergeJargonReplicas, m => bi(`找到 ${m.length} 个词!`, `Found ${m.length} terms!`))
    // ctx producer, parameterised by the comment_digest to feed it (cheap phase
    // passes an empty digest — summary-only is fine for a quick worth-reading call).
    const runCtx = (cd: HNLensResult['comment_digest'], jrg: JargonTerm[] = []): Promise<HNLensResult['verdict']> =>
      haveShared ? replaySection('ctx', opts.cachedShared!.verdict, emit, agentSources)
        : graph.enabled.ctx === false ? skipContext(mock, emit, skippedAgents, agentSources)
          : runContext(env, item, summary, cd, jrg, mock, emit, fallbackAgents, agentSources, meter, debate, audience)

    if (opts.graph?.escalate) {
      // ── Conditional escalate (省钱渐进): cheap first, escalate if worthy ──
      // Phase 1 (cheap): sum + ctx only. ctx runs on the summary alone (empty
      // comment_digest) — good enough for a quick "is it worth reading" call.
      summary = await runSum()
      assertCriticalAgents(fallbackAgents, opts.requireCriticalAgents, ['sum'], budgetLimited)
      const emptyDigest = normalizeDigest({
        overview: bz(''), camps: [], consensus: bz(''), disputes: [], expert_corrections: [], spicy: [],
      })
      verdict = await runCtx(emptyDigest)
      assertCriticalAgents(fallbackAgents, opts.requireCriticalAgents, ['ctx'], budgetLimited)

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
      assertCriticalAgents(fallbackAgents, opts.requireCriticalAgents, ['sum'], budgetLimited)

      // ── Stage 2: ctx — now also fed 小词's jargon density (dep edge). ──
      verdict = await runCtx(comment_digest, jargon)
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
    // 小词 runs in parallel with 小摘/小潜; await it BEFORE 小导 so the verdict can
    // weigh jargon density (the 小词→小导 dependency edge). It's usually already
    // resolved by now, so this rarely adds latency.
    jargon = await jargonP
    assertCriticalAgents(fallbackAgents, opts.requireCriticalAgents, ['sum'], budgetLimited)

    // ── Stage 2: verdict, now that it can see real content + jargon ──
    verdict = haveShared
      ? await replaySection('ctx', opts.cachedShared!.verdict, emit, agentSources)
      : await runContext(env, item, summary, comment_digest, jargon, mock, emit, fallbackAgents, agentSources, meter, debate, audience)
  }
  assertCriticalAgents(fallbackAgents, opts.requireCriticalAgents, ['ctx'], budgetLimited)

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
  if (graph?.enabled.synth === false) {
    skippedAgents.add('synth')
    agentSources.synth = {
      mode: 'skipped',
      reason: bi('你在编辑面板关掉合成，保留各角色的原始结果。', 'You turned Synthesiser off in the editor, so the original role outputs were kept.'),
    }
    emit({ event: 'status', agent: 'synth', state: 'done', mode: 'skipped', label: bi('已关闭，略过整合', 'Turned off, skipping synthesis') })
  } else {
    await curate(env, item, result, emit, agentSources, meter, audience, fallbackAgents)
  }
  // `fallback_agents` was initially copied before Synth ran. Refresh it so a
  // Synth fallback reaches cache policy and downstream clients.
  result.flags.fallback_agents = [...fallbackAgents]
  result.flags.skipped_agents = [...skippedAgents]

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
  if (agentSources) agentSources[agent] = { mode: 'cache', reason: bi('这段直接使用上一轮缓存，没有重新调用 agent。', 'Reused this section from the previous cache, the agent was not called again.') }
  emit({ event: 'status', agent, state: 'done', mode: 'cache', label: LABELS[agent].done })
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
      reason: cachedShared
        ? bi('摘要已在缓存里，直接拿来用。', 'The summary is already cached, reusing it as-is.')
        : bi('先读文章，抓出一句话和重点。', 'Read the article first to pull out a one-liner and the key points.'),
    },
    {
      agent: 'jargon',
      action: cachedJargon ? 'reuse' : (looksTechnical && textLen >= 220 ? 'run' : 'skip'),
      reason: cachedJargon
        ? bi('术语清单已依你的生词本缓存。', 'The jargon list is already cached against your known-terms list.')
        : looksTechnical && textLen >= 220
          ? bi('内容看起来有技术密度，请小词挑真正会卡住的词。', 'The content looks technically dense, so let Jargon pick out the terms that would actually trip readers up.')
          : bi('内容太短或不像技术文，先不硬找术语。', 'The content is too short or not technical, so skipping the jargon hunt for now.'),
    },
    {
      agent: 'comments',
      action: cachedShared ? 'reuse' : (comments >= 3 ? 'run' : 'skip'),
      reason: cachedShared
        ? bi('留言摘要已在缓存里，直接拿来用。', 'The comment digest is already cached, reusing it as-is.')
        : comments >= 3
          ? bi(
              commentsWereSampled(item) ? '留言很多，挑高信号串分析。' : '留言量足够，请小潜整理派别。',
              commentsWereSampled(item) ? 'There are a lot of comments, so sampling the highest-signal threads to analyse.' : 'There are enough comments, so let Comments sort out the camps.'
            )
          : bi('留言太少，没有必要做派别分析。', 'Too few comments to bother with camp analysis.'),
    },
    {
      agent: 'ctx',
      action: cachedShared ? 'reuse' : 'run',
      reason: cachedShared
        ? bi('裁定已在缓存里。', 'The verdict is already cached.')
        : bi('等摘要和留言轮廓出来后，再判断值不值得读。', 'Wait for the summary and comment overview, then judge whether it is worth reading.'),
    },
  ]
  const route = assignments
    .map(a => `${agentZh(a.agent)}:${actionZh(a.action)}`)
    .join(' · ')
  const routeEn = assignments
    .map(a => `${agentEn(a.agent)}: ${actionEn(a.action)}`)
    .join(' · ')
  return { route: bi(route, routeEn), assignments }
}

function actionZh(action: RouteAction): string {
  return action === 'run' ? '开工' : action === 'reuse' ? '拿缓存' : '略过'
}
function actionEn(action: RouteAction): string {
  return action === 'run' ? 'running' : action === 'reuse' ? 'from cache' : 'skipped'
}

function shouldRun(plan: CaptainPlan, agent: WorkerAgent): boolean {
  return (plan.assignments.find(a => a.agent === agent)?.action || 'run') === 'run'
}

// Mirror graph.enabled into the captain plan so the office shows the right set.
function applyGraphToPlan(plan: CaptainPlan, graph: NormalizedGraph): void {
  for (const a of plan.assignments) {
    if (graph.enabled[a.agent] === false) {
      a.action = 'skip'
      a.reason = bi('你在编辑面板把这位关掉了，这轮直接略过。', 'You turned this one off in the editor panel, so skipping it this round.')
    }
  }
  const route = plan.assignments.map(a => `${agentZh(a.agent)}:${actionZh(a.action)}`).join(' · ')
  const routeEn = plan.assignments.map(a => `${agentEn(a.agent)}: ${actionEn(a.action)}`).join(' · ')
  plan.route = bi(route, routeEn)
}

// Build a substantive digest of a stage-1 agent's output to thread into the
// next relay member's prompt. Richer than a TL;DR: enough for the downstream
// agent to genuinely anchor on the upstream result. Each section is capped so
// the prompt stays sane (key points ≤ 10, camps ≤ 6, terms ≤ 12).
function relayDigest(agent: Stage1Agent, value: unknown): string {
  if (agent === 'sum') {
    const s = value as HNLensResult['summary']
    const kp = (s.key_points ?? []).slice(0, 10).map(k => `- ${k.zh}`).join('\n')
    return [`TL;DR：${s.tldr?.zh || ''}`, kp && `重点：\n${kp}`].filter(Boolean).join('\n')
  }
  if (agent === 'comments') {
    const cd = value as HNLensResult['comment_digest']
    const camps = (cd.camps ?? []).slice(0, 6)
      .map(c => `- ${c.label?.zh || ''}${c.stance?.zh ? `：${c.stance.zh}` : ''}`)
      .join('\n')
    return [`留言轮廓：${cd.overview?.zh || ''}`, camps && `派别：\n${camps}`].filter(Boolean).join('\n')
  }
  // jargon
  const terms = value as JargonTerm[]
  return (terms ?? []).slice(0, 12).map(t => `- ${t.term}：${t.explain?.zh || ''}`).join('\n')
}

// Per-pair directive telling the downstream agent HOW to use the upstream
// output, so relay makes a real, explainable difference from parallel.
function relayDirective(upstream: Stage1Agent, downstream: Stage1Agent): string {
  if (downstream === 'jargon' && upstream === 'sum')
    return '请优先解释上面摘要强调的核心概念（先把这些讲清楚），再补上其他术语，让术语清单贴合文章真正的主旨。'
  if (downstream === 'jargon' && upstream === 'comments')
    return '除了文章术语，也要收录上面讨论在争辩／反复提到的词（社群特有的行话），不要只看文章。'
  if (downstream === 'comments' && upstream === 'sum')
    return '请依照上面摘要点出的主要主张／段落，来组织留言的派别与争论（让派别对应到文章的核心论点）。'
  if (downstream === 'comments' && upstream === 'jargon')
    return '若某个派别的分歧其实卡在上面某个技术术语上，请明确点出是哪个词。'
  if (downstream === 'sum')
    return '请特别加重上一步强调的重点。'
  return '参考上一步的产出，聚焦在它强调的重点。'
}

// Compose the full relay context block injected into a downstream member's
// prompt: a clearly-labelled upstream digest + the per-pair directive.
function relayContext(upstream: Stage1Agent, downstream: Stage1Agent, value: unknown): string {
  const digest = relayDigest(upstream, value)
  const directive = relayDirective(upstream, downstream)
  return `【接力脉络 ← 上一步(${agentZh(upstream)})】\n${digest}\n→ ${directive}`
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
  return ({ sum: '小摘', jargon: '小词', comments: '小潜', ctx: '小导' } as Record<WorkerAgent, string>)[agent]
}

// English display names for the same agents, used when building bilingual
// route/reason strings that go straight to the client (not agent prompts).
function agentEn(agent: WorkerAgent): string {
  return ({ sum: 'Summariser', jargon: 'Jargon', comments: 'Comments', ctx: 'Verdict' } as Record<WorkerAgent, string>)[agent]
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
  extraContext?: string, effort: Effort = 'med', meter?: UsageMeter, quiet = false, audience?: Audience
): Promise<HNLensResult['summary']> {
  if (!quiet) emit({ event: 'status', agent: 'sum', state: 'running', label: LABELS.sum.running })
  try {
    const prompt = buildSummarizerPrompt(item, articleText, itemType, extraContext, effort, audience)
    const text = await callAgent(env, env.AGENT_SUMMARIZER, prompt, 'sum', emit)
    meter?.add('sum', prompt.length, text.length)
    const p = parseLoose<{ tldr?: unknown; key_points?: unknown[] }>(text)
    if (!p?.tldr) throw new Error('Summariser returned output that could not be parsed as the required JSON.')
    const summary: HNLensResult['summary'] = {
      tldr: toBi(p.tldr),
      key_points: (Array.isArray(p.key_points) ? p.key_points : []).map(toBi).filter(k => k.zh),
    }
    if (!quiet) {
      emit({ event: 'status', agent: 'sum', state: 'done', mode: 'real', label: bi('TL;DR 完成!', 'TL;DR done!') })
      emit({ event: 'section', agent: 'sum', data: summary })
    }
    if (agentSources) agentSources.sum = { mode: 'real', reason: bi('小摘实际读取文章内容后产出。', 'Summariser actually read the article content to produce this.') }
    return summary
  } catch (e) {
    fallbackAgents?.add('sum')
    noteBudgetLimit(emit, 'sum', e)
    const sandboxReason = emitAgentFailure('sum', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'sum', state: 'done', mode: 'fallback', label: bi('摘要用备援内容', 'Summary used fallback content') })
      emit({ event: 'section', agent: 'sum', data: mock.summary })
    }
    if (agentSources) agentSources.sum = {
      mode: 'fallback',
      reason: fallbackReason('sum', e, sandboxReason, bi('改用本地备援摘要', 'falling back to the local backup summary')),
      budget_limited: isBudgetExhaustedError(e) || undefined,
    }
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
  const empty: HNLensResult['summary'] = {
    tldr: bi('你在编辑面板把小摘关掉了，这轮没有产生摘要。', 'You turned Summariser off in the editor panel, so no summary was produced this round.'),
    key_points: [],
  }
  emit({ event: 'status', agent: 'sum', state: 'done', mode: 'skipped', label: bi('已关闭，略过摘要', 'Turned off, skipping summary') })
  emit({ event: 'section', agent: 'sum', data: empty })
  if (agentSources) agentSources.sum = { mode: 'skipped', reason: bi('你在编辑面板关掉小摘，没有调用摘要 agent。', 'You turned Summariser off in the editor panel, so the summary agent was not called.') }
  return empty
}

// ── 小导 verdict (depends on summary + comments + 小词 jargon) ──────
// The one meaningful dependency edge: 小导 also reads 小词's jargon density
// (how many blocking / hard terms) so its worth_reading/tier/why reflect the
// article's reading accessibility, not just its content. `jargon` may be empty
// (e.g. the cheap escalate phase before 小词 runs) — then it's ignored.
// Parse a 小导 verdict JSON into a typed verdict, or null if unusable.
function parseVerdict(text: string): HNLensResult['verdict'] | null {
  const p = parseLoose<{ worth_reading?: string; why_frontpage?: unknown; tier?: string }>(text)
  const worth = String(p?.worth_reading ?? '').trim().toLowerCase()
  if (worth !== 'high' && worth !== 'medium' && worth !== 'low') return null
  const why = toBi(p?.why_frontpage)
  if (!why.zh.trim()) return null
  const rawTier = String(p?.tier ?? '').trim()
  const tier = rawTier === '10s' || rawTier === '1min' || rawTier === 'deep' ? rawTier : '1min'
  return {
    worth_reading: worth,
    why_frontpage: why,
    tier,
  }
}

// 辩论裁定: run 小导 twice with opposing framings (正方/反方) in parallel, then a
// third adjudication pass merges them into one balanced verdict. Throws only if
// BOTH sides fail (→ outer fallback); a single failed side still adjudicates.
async function debateVerdict(
  env: Env, item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'],
  jargon: JargonTerm[], mock: HNLensResult, emit: (e: SSEEvent) => void, meter?: UsageMeter, audience?: Audience
): Promise<HNLensResult['verdict']> {
  emit({ event: 'step', agent: 'ctx', label: bi('正方 vs 反方 辩论中…', 'Pro vs con debating…') })
  const proPrompt = buildDebatePrompt(item, summary, cd, jargon, 'pro', audience)
  const conPrompt = buildDebatePrompt(item, summary, cd, jargon, 'con', audience)
  const [proR, conR] = await Promise.allSettled([
    callAgent(env, env.AGENT_CONTEXT, proPrompt, 'ctx', emit),
    callAgent(env, env.AGENT_CONTEXT, conPrompt, 'ctx', emit),
  ])
  const proText = proR.status === 'fulfilled' ? proR.value : ''
  const conText = conR.status === 'fulfilled' ? conR.value : ''
  meter?.add('ctx', proPrompt.length + conPrompt.length, proText.length + conText.length)
  if (!proText && !conText) throw new Error('debate: both sides failed')
  const pro = parseVerdict(proText)
  const con = parseVerdict(conText)
  emit({ event: 'step', agent: 'ctx', label: bi('首席裁判合议中…', 'Head judge deliberating…') })
  const mergePrompt = buildDebateMergePrompt(item, pro, con)
  const mergeText = await callAgent(env, env.AGENT_CONTEXT, mergePrompt, 'ctx', emit)
  meter?.add('ctx', mergePrompt.length, mergeText.length)
  // Prefer the adjudicated verdict; else fall back to whichever side parsed.
  const verdict = parseVerdict(mergeText) ?? pro ?? con
  if (!verdict) throw new Error('Context debate returned no parseable verdict JSON.')
  return verdict
}

async function runContext(
  env: Env, item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'],
  jargon: JargonTerm[], mock: HNLensResult, emit: (e: SSEEvent) => void, fallbackAgents?: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>, meter?: UsageMeter, debate = false, audience?: Audience
): Promise<HNLensResult['verdict']> {
  emit({ event: 'status', agent: 'ctx', state: 'running', label: debate ? bi('辩论裁定中…', 'Debating verdict…') : LABELS.ctx.running })
  try {
    let verdict: HNLensResult['verdict']
    if (debate) {
      verdict = await inStage(emit, 'ctx', () =>
        debateVerdict(env, item, summary, cd, jargon, mock, emit, meter, audience))
    } else {
      const prompt = buildContextPrompt(item, summary, cd, jargon, audience)
      const text = await inStage(emit, 'ctx', () => callAgent(env, env.AGENT_CONTEXT, prompt, 'ctx', emit))
      meter?.add('ctx', prompt.length, text.length)
      const parsed = parseVerdict(text)
      if (!parsed) throw new Error('Context returned output that could not be parsed as the required verdict JSON.')
      verdict = parsed
    }
    emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'real', label: debate ? bi('辩论裁定完成!', 'Debate verdict is in!') : bi('裁定完成!', 'Verdict is in!') })
    emit({ event: 'section', agent: 'ctx', data: verdict })
    if (agentSources) agentSources.ctx = { mode: 'real', reason: bi(
      debate ? '小导以正反双方辩论后合议出平衡裁定。'
        : jargon.length ? '小导根据摘要、留言轮廓与小词的术语密度重新判断。'
          : '小导根据摘要和留言轮廓重新判断。',
      debate ? 'Context reached a balanced verdict after arguing both sides of the debate.'
        : jargon.length ? "Context re-judged this based on the summary, comment overview, and Jargon's term density."
          : 'Context re-judged this based on the summary and comment overview.') }
    return verdict
  } catch (e) {
    fallbackAgents?.add('ctx')
    noteBudgetLimit(emit, 'ctx', e)
    const sandboxReason = emitAgentFailure('ctx', e, emit)
    emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'fallback', label: bi('裁定用备援内容', 'Verdict used fallback content') })
    emit({ event: 'section', agent: 'ctx', data: mock.verdict })
    if (agentSources) agentSources.ctx = {
      mode: 'fallback',
      reason: fallbackReason('ctx', e, sandboxReason, bi('改用本地裁定', 'falling back to the local verdict')),
      budget_limited: isBudgetExhaustedError(e) || undefined,
    }
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
  if (go) return known ? `worth_reading=${wr}` : 'worth_reading unknown, over-delivering'
  return `worth_reading=${wr || 'low'}`
}

// Graph-only: force-skip 小导. Mirrors the other skip helpers.
async function skipContext(
  mock: HNLensResult,
  emit: (e: SSEEvent) => void,
  skippedAgents: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<HNLensResult['verdict']> {
  skippedAgents.add('ctx')
  const empty: HNLensResult['verdict'] = {
    worth_reading: mock.verdict.worth_reading,
    why_frontpage: bi('你在编辑面板把小导关掉了，这轮没有重新裁定。', 'You turned Verdict off in the editor panel, so no new verdict was made this round.'),
    tier: mock.verdict.tier,
  }
  emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'skipped', label: bi('已关闭，略过裁定', 'Turned off, skipping verdict') })
  emit({ event: 'section', agent: 'ctx', data: empty })
  if (agentSources) agentSources.ctx = { mode: 'skipped', reason: bi('你在编辑面板关掉小导，没有调用裁定 agent。', 'You turned Verdict off in the editor panel, so the verdict agent was not called.') }
  return empty
}

// Comment pipeline knobs per effort. Comments are ranked locally and sent in
// one bounded reduce call so remote startup latency is paid once.
interface CommentParams {
  rankedBudget: number
  reduceCap: number
  campsHint: string
}
function commentParams(effort: Effort): CommentParams {
  if (effort === 'low')
    return { rankedBudget: 1400, reduceCap: 4000, campsHint: '只挑最主要的 2-3 个派别（宁缺勿滥）。' }
  if (effort === 'high')
    return { rankedBudget: 3600, reduceCap: 12000, campsHint: '尽量涵盖更多派别（含 vocal-minority／fringe），最多 6 个。' }
  return { rankedBudget: 2600, reduceCap: 8000, campsHint: '' }
}

// ── 小潜 comments (token-budgeted, high-signal first) ──────────────
async function runComments(
  env: Env, item: HNItem, mock: HNLensResult, emit: (e: SSEEvent) => void, fallbackAgents?: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>,
  extraContext?: string, effort: Effort = 'med', meter?: UsageMeter, quiet = false
): Promise<HNLensResult['comment_digest']> {
  const commentCount = item.children?.length ?? 0
  if (commentCount === 0) {
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'running', label: bi('这篇没有 HN 讨论', 'No HN discussion on this one') })
      emit({ event: 'status', agent: 'comments', state: 'done', mode: 'skipped', label: bi('无留言', 'No comments') })
      emit({ event: 'section', agent: 'comments', data: mock.comment_digest })
      meter?.finish('comments')
    }
    if (agentSources) agentSources.comments = {
      mode: 'skipped',
      reason: bi('这篇内容没有 HN 留言，因此没有调用留言 agent。', 'This item has no HN comments, so the Comments agent was not called.'),
    }
    return mock.comment_digest
  }
  if (!quiet) emit({ event: 'status', agent: 'comments', state: 'running', label: bi(`潜进 ${commentCount} 楼…`, `Diving into ${commentCount} comments…`) })
  const params = commentParams(effort)
  try {
    const text = await runCommentPipeline(item, env, emit, extraContext, params, meter, quiet)
    const p = parseLoose<HNLensResult['comment_digest']>(text)
    if (!p?.overview && !p?.camps) throw new Error('Comments returned output that could not be parsed as the required digest JSON.')
    const cd = normalizeDigest(p)
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'done', mode: 'real', label: LABELS.comments.done })
      emit({ event: 'section', agent: 'comments', data: cd })
    }
    if (agentSources) agentSources.comments = {
      mode: 'real',
      reason: commentsWereSampled(item)
        ? bi('小潜实际分析高信号留言串。', 'Comments actually analysed the highest-signal threads.')
        : bi('小潜实际分析留言。', 'Comments actually analysed the comments.'),
    }
    return cd
  } catch (e) {
    fallbackAgents?.add('comments')
    noteBudgetLimit(emit, 'comments', e)
    const sandboxReason = emitAgentFailure('comments', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'done', mode: 'fallback', label: bi('留言用备援内容', 'Comments used fallback content') })
      emit({ event: 'section', agent: 'comments', data: mock.comment_digest })
    }
    if (agentSources) agentSources.comments = {
      mode: 'fallback',
      reason: fallbackReason('comments', e, sandboxReason, bi('改用本地留言摘要', 'falling back to the local comment digest')),
      budget_limited: isBudgetExhaustedError(e) || undefined,
    }
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
    overview: bi('留言太少，队长略过小潜的派别分析。', 'Too few comments, so the captain skipped Comments’ camp analysis.'),
    camps: [],
    consensus: bi('尚无足够讨论形成共识。', 'Not enough discussion yet to form a consensus.'),
    disputes: [],
    expert_corrections: [],
    spicy: [],
  })
  emit({ event: 'status', agent: 'comments', state: 'done', mode: 'skipped', label: bi('留言太少，略过', 'Too few comments, skipped') })
  emit({ event: 'section', agent: 'comments', data: empty.overview.zh ? empty : mock.comment_digest })
  if (agentSources) agentSources.comments = { mode: 'skipped', reason: bi('留言太少，队长判断不用调用小潜。', 'Too few comments, so the captain decided Comments did not need to be called.') }
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
  meter?: UsageMeter,
  audience?: Audience,
  fallbackAgents?: Set<AgentName>,
): Promise<void> {
  if (!result.jargon.length && !result.summary.key_points.length && !result.comment_digest.camps.length) return
  // Build the prompt first so we can meter the moment the agent is actually
  // invoked. The synthesizer legitimately runs long (~40s+) but is called with a
  // bounded budget with one transient retry, so metering the prompt up-front (and
  // the response below, when we get it) ensures synth's tokens are counted
  // whenever the call happens, consistent with the other agents, instead of the
  // `finally` emitting a misleading synth:0 for a call that really ran.
  const prompt = buildCuratorPrompt(item, result, audience)
  emit({ event: 'status', agent: 'synth', state: 'running', label: bi('整合中…', 'Synthesising…') })
  meter?.add('synth', prompt.length, 0)
  try {
    const text = await inStage(emit, 'synth', () =>
      callAgent(env, env.AGENT_SYNTHESIZER, prompt, 'synth', emit, { timeoutMs: 240_000, attempts: 2 }))
    meter?.add('synth', 0, text.length)
    const d = parseLoose<CuratorDecision>(text)
    if (!d) throw new Error('Synthesiser returned output that could not be parsed as the required curation JSON.')
    applyCuration(result, d)
    emit({ event: 'status', agent: 'synth', state: 'done', mode: 'real', label: bi('整合完成!', 'Synthesis done!') })
    if (agentSources) agentSources.synth = { mode: 'real', reason: bi('合成实际检查并修剪各段输出。', 'Synth actually reviewed and pruned each section’s output.') }
  } catch (e) {
    fallbackAgents?.add('synth')
    noteBudgetLimit(emit, 'synth', e)
    const sandboxReason = emitAgentFailure('synth', e, emit)
    emit({ event: 'status', agent: 'synth', state: 'done', mode: 'fallback', label: bi('整合略过', 'Synthesis skipped') })
    if (agentSources) agentSources.synth = {
      mode: 'fallback',
      budget_limited: isBudgetExhaustedError(e) || undefined,
      reason: sandboxReason
        ? bi(
            `合成的 sandbox/runtime 不在线，保留各组原始结果，不再等 QA 修剪。原因：${sandboxReason}`,
            `Synth's sandbox/runtime is offline, so each section's raw results are kept instead of waiting for QA pruning. Reason: ${sandboxReason}`
          )
        : bi(
            `合成超过等待时间或 runtime 失败；保留各组原始结果，不再等 QA 修剪。原因：${shortErr(e)}`,
            `Synth exceeded its wait budget or the runtime failed, so each section's raw results are kept instead of waiting for QA pruning. Reason: ${shortErr(e)}`
          ),
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
  const wasJargon = result.jargon.length
  const wasKeyPoints = result.summary.key_points.length
  const wasCamps = result.comment_digest.camps.length
  result.jargon = keepByIndex(result.jargon, d.jargon_keep)
  result.summary.key_points = keepByIndex(result.summary.key_points, d.key_points_keep)
  result.comment_digest.camps = keepByIndex(result.comment_digest.camps, d.camps_keep)
  // The editing record: what synth cut. Counted off the arrays, not off
  // `d.*_keep`, because keepByIndex keeps the original array when the indices are
  // unusable — inferring from the decision would report cuts that never happened.
  result.flags.curation = {
    jargon: { before: wasJargon, after: result.jargon.length },
    key_points: { before: wasKeyPoints, after: result.summary.key_points.length },
    camps: { before: wasCamps, after: result.comment_digest.camps.length },
  }
  if (d.note && (d.note.en || d.note.zh)) result.editor_note = toBi(d.note)
  if (d.summary_ok === false) result.flags.low_confidence = true
}

function buildCuratorPrompt(item: HNItem, r: HNLensResult, audience?: Audience): string {
  const jl = r.jargon.map((t, i) => `${i}: ${t.term} — ${t.zh_term} — ${t.explain.zh}`).join('\n')
  const kp = r.summary.key_points.map((k, i) => `${i}: ${k.zh}`).join('\n')
  const camps = r.comment_digest.camps.map((c, i) => `${i}: [${c.weight}] ${c.label.zh} — ${(c.quote || '').slice(0, 80)}`).join('\n')

  return `你是 统整，负责整合与品管。${readerDesc(audience)}。检视四个 agent 的产出，决定要保留哪些，并修掉跨段落的不一致。

术语（JARGON）— 先认出本文的核心技术领域，只保留 4-8 个【属于该技术领域、且对理解本文真正会卡住】的词；务必删掉：重复、太显而易见、循环定义，以及任何离题或非技术的词（一般英文字、无关专有名词）：
${jl || '(none)'}

重点（KEY POINTS）— 删掉冗余、薄弱、重复的，留下实质的：
${kp || '(none)'}

留言派别（CAMPS）— 删掉几乎重复或琐碎的，留下真正不同的观点：
${camps || '(none)'}

摘要 TL;DR：${r.summary.tldr.zh || '(none)'}

返回每个清单「要保留」的 0-based index（子集合，顺序不限）、摘要是否合格，以及一句中文编辑注记。
只返回这个 JSON（不要 markdown；字符串值里不要用 " 字元，用 ' 或「」）：
{"jargon_keep":[0,1,2],"key_points_keep":[0,1],"camps_keep":[0,1],"summary_ok":true,"note":{"zh":"..."}}`
}

// ── Agent caller labels ────────────────────────────────────────────
const LABELS: Record<AgentName, { running: BiStr; done: BiStr }> = {
  sum:      { running: bi('读文章中…', 'Reading the article…'),   done: bi('TL;DR 完成!', 'TL;DR done!') },
  jargon:   { running: bi('找术语中…', 'Hunting for jargon…'),   done: bi('术语解释完成!', 'Jargon explained!') },
  comments: { running: bi('潜进留言区…', 'Diving into the comments…'), done: bi('留言分析完成!', 'Comments analysed!') },
  ctx:      { running: bi('评估文章价值…', 'Judging if it is worth reading…'), done: bi('裁定完成!', 'Verdict is in!') },
  synth:    { running: bi('整合中…', 'Synthesising…'),     done: bi('整合完成!', 'Synthesis done!') },
}

// ── Comment pipeline: local ranking → one reduce, token-budgeted ──
async function runCommentPipeline(
  item: HNItem, env: Env, emit: (e: SSEEvent) => void, extraContext?: string,
  params: CommentParams = commentParams('med'), meter?: UsageMeter, quiet = false
): Promise<string> {
  const commentCount = item.children?.length ?? 0

  // Hosted peers have high first-token latency. The old 8–12 call
  // map fan-out could consume most of a Queue invocation before ctx/synth even
  // started. Rank and cap the raw comments locally, then make one grounded
  // reduce call; this preserves high-signal coverage with one remote turn.
  const ranked = rankedCommentsText(item.children ?? [], params.rankedBudget)
  if (commentCount >= 10 && !quiet) emit({
    event: 'step',
    agent: 'comments',
    label: bi('已挑出高信号留言，直接聚类分析…', 'Ranked high-signal comments; clustering directly…'),
  })
  return singleCommentCall(env, ranked, item, emit, extraContext, params, meter)
}

async function singleCommentCall(
  env: Env, text: string, item: HNItem, emit: (e: SSEEvent) => void, extraContext?: string,
  params: CommentParams = commentParams('med'), meter?: UsageMeter
): Promise<string> {
  const prompt = buildCommentReducePrompt([text], item, extraContext, params)
  const out = await callAgent(env, env.AGENT_COMMENT_REDUCE, prompt, 'comments', emit)
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
function buildSummarizerPrompt(item: HNItem, articleText: string, itemType: ItemType, extraContext?: string, effort: Effort = 'med', audience?: Audience): string {
  const content = (articleText || item.text || '(no article text available)').slice(0, 6000)
  // effort → how much the summary says. 'med' reproduces today's ask exactly.
  const ask = effort === 'low'
    ? '产出一句精简的 TL;DR + 最多 3 个最关键的重点（宁缺勿滥）。'
    : effort === 'high'
      ? '产出一句 TL;DR + 5-7 个重点，涵盖更多面向与细节。'
      : '产出一句 TL;DR + 3-4 个重点。'
  return `你是 小摘，精简的中文摘要员。
${relayBlock(extraContext)}
标题：${item.title}
类型：${itemType}
内容：
${content}

${ask}若内容不足，从标题推测并注明不确定。全部只用简体中文。${audienceDirective(audience, 'sum')}

只返回这个 JSON（不要 markdown；字符串值里不要用 " 字元，用 ' 或「」）：
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
  extraContext?: string, effort: Effort = 'med', audience?: Audience
): string {
  const where = part.n > 1 ? `（文章第 ${part.i + 1}/${part.n} 段）` : ''
  // effort → per-window term target. 'med' keeps today's "10-16" ask verbatim.
  const target = effort === 'low' ? '4-6' : effort === 'high' ? '12-16' : '10-16'
  const knownLine = known.length
    ? `\n读者「已经会」这些词，请务必【跳过】，把预算花在真正新的/较不显而易见的词上：\n${known.join('、')}\n`
    : ''
  const candLine = candidates.length
    ? `\n以下是程序从全文扫出的候选词（可能有杂讯）。请逐一检视、把属于本文技术领域且读者可能不懂的收进来，其余忽略；也要补上你自己扫到、清单漏掉的词：\n${candidates.join('、')}\n`
    : ''
  return `你是 小词，给 HN 读者的中文术语白话解说员。
${relayBlock(extraContext)}
文章标题：${item.title}

文章内文${where}（仔细读，从整段挑词，不要只挑开头）：
${articleChunk || '(no article text available)'}
${commentSample ? `\nHN 留言取样（这里出现的词 seen_in 标 "comments"）：\n${commentSample}` : ''}
${candLine}${knownLine}
第一步：先判定「这篇文章的核心技术领域」（例如 AI/机器学习、Agent/LLM、数据库、分散式系统、前端、密码学…）。
第二步：把【属于这个技术领域、且一个「会写程序但非此子领域」的人不会马上懂】的术语都挑出来 — 这段尽量挑 ${target} 个，宁可多收也不要漏。
※ 务必涵盖【文章标题点名的核心概念／方法】，以及反复出现的自创术语，即使是多字词（例如 'loop engineering'、'context engineering'、'reward model'、'agent loop'）。
目标：缩写、函数库/产品/演算法/模型名称、领域行话与方法（例如 RLHF、PPO、reward model、eval、rubric、grader、rollout、distillation 这类）、不直观的技术指标、非正式技术新造词。扫过中段与结尾。

【判断收录的标准】：只要「出了这个子领域的人不会马上懂」就收。
【只在这些情况才跳过】：
- 真正人人都懂的通用词（如 HTTP、JSON、API、CPU、URL）
- 跟核心技术主题无关的专有名词（人名、地名、与技术无关的公司名）
- 内文已自我清楚定义的词，以及上面「已经会」清单里的词

每个词要自评：
- on_topic：true=属于本文技术领域且相关；false=离题或非技术（会被丢掉）
- difficulty：1-5，「会写程序但非此领域」的人理解难度
- blocking：true=不懂这个词就会卡住对本文的理解

解说风格（只用简体中文）：1-2 句、不要循环定义、不要用行话解释行话、适时用具体比喻。${audienceDirective(audience, 'jargon')}
zh_term：标准简体中文名称或描述性中文标签；seen_in："article"/"comments"/"both"；appeared_as：出现的原句片段。

只返回这个 JSON 数组（不要 markdown；字符串值里不要用 " 字元，用 ' 或「」）：
[{"term":"...","zh_term":"...","explain":{"zh":"..."},"seen_in":"article","appeared_as":"source phrase","on_topic":true,"difficulty":3,"blocking":true}]`
}

async function runJargon(
  env: Env, item: HNItem, articleText: string, kbTerms: string[], emit: (e: SSEEvent) => void,
  fallbackAgents?: Set<AgentName>, agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>,
  extraContext?: string, effort: Effort = 'med', meter?: UsageMeter, quiet = false, audience?: Audience
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
      ? [buildJargonPrompt(item, '', commentSample, { i: 0, n: 1 }, known, candidates, extraContext, effort, audience)]
      : windows.map((w, i) => buildJargonPrompt(item, w, i === 0 ? commentSample : '', { i, n: windows.length }, known, candidates, i === 0 ? extraContext : undefined, effort, audience))
    if (prompts.length > 1 && !quiet) emit({ event: 'step', agent: 'jargon', label: bi(`通读全文 ${prompts.length} 段…`, `Reading the full article in ${prompts.length} passes…`) })
    // Run windows independently — a slow/failed window must NOT zero the rest.
    const settled = await Promise.allSettled(prompts.map(p =>
      callAgent(env, env.AGENT_JARGON, p, 'jargon', emit, { timeoutMs, attempts: 2 })))
    // Meter each window that returned: sum its prompt + response chars.
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') meter?.add('jargon', prompts[i].length, s.value.length)
    })
    const outputs = settled.filter((s): s is PromiseFulfilledResult<string> => s.status === 'fulfilled').map(s => s.value)
    if (!outputs.length) {
      const rej = settled.find(s => s.status === 'rejected') as PromiseRejectedResult | undefined
      throw rej ? rej.reason : new Error('jargon: no windows returned')
    }
    const usable = outputs.filter(output => {
      const parsed = parseLoose<unknown>(output)
      return Array.isArray(parsed) || Boolean(parsed && Array.isArray((parsed as { jargon?: unknown }).jargon))
    })
    if (!usable.length) {
      // The peers answered; their output was unusable. 小词 has the longest
      // structured output of any role, so a cut-off response is its most likely
      // non-transport failure — and it must not be reported as a timeout.
      throw new UnparseableOutputError(
        classifyUnparseable(outputs[0]) ?? 'not_json',
        { returned: outputs.length, parsed: 0 },
      )
    }
    let merged = mergeJargon(outputs)
    // Hard filter: never show a term the user already knows (case-insensitive).
    const knownSet = new Set(known.map(k => k.trim().toLowerCase()))
    merged = merged.filter(t => !knownSet.has((t.term || '').trim().toLowerCase()))
    if (!quiet) {
      emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'real', label: bi(`找到 ${merged.length} 个词!`, `Found ${merged.length} terms!`) })
      emit({ event: 'section', agent: 'jargon', data: merged })
    }
    if (agentSources) agentSources.jargon = {
      mode: 'real',
      reason: bi(
        `小词实际分析文章术语；本次最多等待 ${Math.round(timeoutMs / 1000)} 秒。`,
        `Jargon actually analysed the article's terms; this run waited up to ${Math.round(timeoutMs / 1000)}s.`
      ),
    }
    return merged
  } catch (e) {
    fallbackAgents?.add('jargon')
    noteBudgetLimit(emit, 'jargon', e)
    const sandboxReason = emitAgentFailure('jargon', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'fallback', label: bi('术语用备援内容', 'Jargon used fallback content') })
      emit({ event: 'section', agent: 'jargon', data: [] })
    }
    if (agentSources) agentSources.jargon = {
      mode: 'fallback',
      budget_limited: isBudgetExhaustedError(e) || undefined,
      output_unparseable: isUnparseableOutputError(e) ? e.classification : undefined,
      reason: sandboxReason
        ? bi(
            `小词的 sandbox/runtime 不在线，为避免整篇卡住，先不显示术语。原因：${sandboxReason}`,
            `Jargon's sandbox/runtime is offline, so the jargon list is skipped for now to avoid stalling the whole run. Reason: ${sandboxReason}`
          )
        // A cut-off or non-JSON answer is NOT a timeout: 小词 replied, and saying
        // it "did not respond in time" sends the next fix at the wrong target.
        : isUnparseableOutputError(e)
          ? e.classification === 'truncated'
            ? bi(
                `小词回复了，但术语清单写到一半就被截断，无法解析，所以这次不显示术语。它要写的条目最多，最容易超出输出长度上限。`,
                `Jargon did reply, but its term list was cut off mid-answer and could not be parsed, so no terms are shown. It has the longest output of any role, so it is the likeliest to exceed the output cap.`
              )
            : bi(
                `小词回复了，但内容不是可解析的 JSON，所以这次不显示术语。原因：${shortErr(e)}`,
                `Jargon did reply, but the content was not parseable JSON, so no terms are shown. Reason: ${shortErr(e)}`
              )
          : bi(
              `小词最多等待 ${Math.round(timeoutMs / 1000)} 秒；这次没有及时回复，为避免整篇卡住，先不显示术语。原因：${shortErr(e)}`,
              `Jargon waits up to ${Math.round(timeoutMs / 1000)}s; it did not respond in time this run, so the jargon list is skipped to avoid stalling the whole run. Reason: ${shortErr(e)}`
            ),
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
  emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'skipped', label: bi('非技术文，略过术语', 'Not technical, skipping jargon') })
  emit({ event: 'section', agent: 'jargon', data: [] })
  if (agentSources) agentSources.jargon = { mode: 'skipped', reason: bi('队长判断内容太短或不像技术文，没有调用小词。', 'The captain judged the content too short or not technical, so Jargon was not called.') }
  return []
}

function jargonTimeoutMs(text: string): number {
  // The bottleneck is generating 10-16 explanations, not reading the input —
  // so even short articles need a generous budget. (Empirically the agent does
  // ~5 terms in ~12s; a full pass with the candidate list can take 40-70s.)
  return 240_000
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

function emitAgentFailure(agent: AgentName, e: unknown, emit: (event: SSEEvent) => void): string | null {
  const sandboxReason = sandboxUnavailableReason(e)
  emit({
    event: 'error',
    agent,
    kind: sandboxReason ? 'sandbox_unavailable' : 'agent_error',
    message: sandboxReason ?? shortErr(e),
  })
  return sandboxReason
}

function fallbackReason(agent: WorkerAgent, e: unknown, sandboxReason: string | null, fallbackText: BiStr): BiStr {
  const zhName = agentZh(agent)
  const enName = agentEn(agent)
  if (isBudgetExhaustedError(e))
    return bi(
      `这一轮分给 ${zhName} 的时间用完了（后面的角色要留时间），${fallbackText.zh}；整篇不会因此重跑。`,
      `${enName} ran out of the time this round allotted it (later roles keep a reserve), so ${fallbackText.en}; the whole run is not retried for this.`
    )
  if (sandboxReason)
    return bi(
      `${zhName} 的 sandbox/runtime 不在线，${fallbackText.zh}。原因：${sandboxReason}`,
      `${enName}'s sandbox/runtime is offline, so ${fallbackText.en}. Reason: ${sandboxReason}`
    )
  return bi(
    `${zhName}未能顺利回复，${fallbackText.zh}。原因：${shortErr(e)}`,
    `${enName} did not respond successfully, so ${fallbackText.en}. Reason: ${shortErr(e)}`
  )
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

// A compact reading-accessibility line derived from 小词's jargon list: how many
// blocking / hard terms there are. Empty string when 小词 didn't run (so the
// prompt stays as before), so 小导 only weighs density when it actually exists.
function jargonAccessibilityLine(jargon: JargonTerm[]): string {
  const n = jargon?.length ?? 0
  if (!n) return ''
  const blocking = jargon.filter(t => t.blocking).length
  const hard = jargon.filter(t => (t.difficulty ?? 0) >= 4).length
  const names = jargon.slice(0, 6).map(t => t.zh_term || t.term).filter(Boolean).join('、')
  return `术语密度（小词盘点）：${n} 个关键术语，其中 ${blocking} 个不懂会卡住理解、${hard} 个偏难${names ? `（如：${names}）` : ''}。术语越多、越硬，阅读门槛越高。\n`
}

// Shared content block for every 小导 prompt (single verdict + debate sides +
// adjudication), so all of them judge the exact same material.
function verdictContext(
  item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'], jargon: JargonTerm[]
): { isHN: boolean; subject: string; block: string; jargonLine: string } {
  const kp = (summary.key_points ?? []).map(k => `- ${k.zh}`).join('\n')
  // Source-aware: only an actual HN thread gets the "front page / points" framing.
  const isHN = (item.points ?? 0) > 0 || (item.children?.length ?? 0) > 0
  const subject = isHN ? '一篇 Hacker News 贴文' : '一篇文章／一段内容'
  const metaLine = isHN ? `分数：${item.points} · 留言数：${item.children?.length ?? 0}\n` : ''
  const discussion = isHN ? `\n留言整体轮廓：${cd.overview?.zh || '(无讨论)'}\n` : ''
  const jargonLine = jargonAccessibilityLine(jargon)
  const block = `标题：${item.title}
${metaLine}文章摘要 TL;DR：${summary.tldr?.zh || '(无)'}
重点：
${kp || '(无)'}
${discussion}${jargonLine}`
  return { isHN, subject, block, jargonLine }
}

const VERDICT_JSON = '只返回这个 JSON（不要 markdown；字符串值里不要用 " 字元，用 \' 或「」）：\n{"worth_reading":"high","why_frontpage":{"zh":"..."},"tier":"deep"}'

function buildContextPrompt(
  item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'], jargon: JargonTerm[] = [], audience?: Audience
): string {
  const { isHN, subject, block, jargonLine } = verdictContext(item, summary, cd, jargon)
  const whyQ = isHN
    ? 'why_frontpage：为什么值得读 / 为何会上 HN 首页？1-2 句，反映上面的实际内容'
    : 'why_frontpage：这篇为什么值得读、重点价值是什么？1-2 句，反映实际内容（不要提「首页」或分数）'
  // Only ask 小导 to weigh accessibility when 小词 actually supplied density data.
  const accessibilityNote = jargonLine
    ? '\n评估时一并考量「阅读门槛」（上面的术语密度）：术语多且硬 → tier 偏 "deep"；门槛低、好懂 → 偏 "10s"/"1min"。若门槛偏高，why_frontpage 可点出「需要一些领域背景」。'
    : ''
  return `你是 小导，评估${subject}。请根据「实际内容」判断${isHN ? '，不要只看分数' : ''}。

${block}
回答三件事（只用简体中文）：
1. worth_reading："high"（必读）、"medium"（有趣）或 "low"（可略过）
2. ${whyQ}
3. tier："10s"、"1min" 或 "deep"${accessibilityNote}${audienceDirective(audience, 'ctx')}

${VERDICT_JSON}`
}

// One debate side: the SAME material, argued from a fixed stance. 正方(pro) makes
// the strongest case it's worth reading; 反方(con) the strongest case to skip it.
// Each still returns the standard verdict JSON, but leaning to its side.
function buildDebatePrompt(
  item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'],
  jargon: JargonTerm[], side: 'pro' | 'con', audience?: Audience
): string {
  const { subject, block } = verdictContext(item, summary, cd, jargon)
  const stance = side === 'pro'
    ? '你是辩论中的【正方】，任务是提出最有力的理由，主张这篇「值得读」（倾向 high/medium）。找出真正的亮点与价值。'
    : '你是辩论中的【反方】，任务是提出最有力的理由，主张这篇「可以略过」（倾向 low/medium）。点出它薄弱、老调、门槛过高或性价比低之处。'
  return `你正在对${subject}进行一场辩论式评估。${stance}只根据下面的实际内容，不要虚构。

${block}
用你这一方的立场，回答（只用简体中文）：
1. worth_reading："high" / "medium" / "low"
2. why_frontpage：你这一方最有力的一句理由
3. tier："10s" / "1min" / "deep"${audienceDirective(audience, 'ctx')}

${VERDICT_JSON}`
}

// Adjudication: a neutral chief judge weighs both sides into ONE balanced verdict.
function buildDebateMergePrompt(item: HNItem, pro: HNLensResult['verdict'] | null, con: HNLensResult['verdict'] | null): string {
  const side = (v: HNLensResult['verdict'] | null) =>
    v ? `worth_reading=${v.worth_reading}、tier=${v.tier}，理由：${v.why_frontpage?.zh || '(无)'}` : '(这一方未能提出)'
  return `你是首席裁判 小导。刚才正反两方针对「${item.title}」是否值得读进行了辩论：

【正方 · 主张值得读】${side(pro)}
【反方 · 主张可略过】${side(con)}

请综合双方最合理的论点，做出最终「平衡裁定」。worth_reading 取双方之间最诚实的判断；why_frontpage 要反映双方都成立的地方（可用「虽然…但…」的口吻），一句话；tier 反映真正需要的投入。只用简体中文。

${VERDICT_JSON}`
}

function buildCommentReducePrompt(
  subtreeSummaries: string[], item: HNItem, extraContext?: string,
  params: CommentParams = commentParams('med')
): string {
  const summaries = subtreeSummaries.filter(Boolean).join('\n\n---\n\n').slice(0, params.reduceCap)
  // effort's camps directive (empty at 'med' → prompt stays byte-for-byte today's).
  const campsLine = params.campsHint ? `${params.campsHint}\n` : ''
  return `你是 小潜，分析「${item.title}」的 Hacker News 讨论。
${relayBlock(extraContext)}
总留言数：${item.children?.length ?? 0}

各串摘要：
${summaries}

找出讨论的结构：主要派别（majority/vocal-minority/fringe）、共识、主要争论、对文章的专家纠错（若有）、最精彩/最辣的一则。
${campsLine}尽量带上 comment_id 让读者能找到原留言。只用简体中文。

只返回这个 JSON（不要 markdown；字符串值里不要用 " 字元，用 ' 或「」）：
{"overview":{"zh":"..."},"camps":[{"label":{"zh":"..."},"stance":{"zh":"..."},"weight":"majority","quote":"verbatim excerpt","comment_id":0}],"consensus":{"zh":"..."},"disputes":[{"zh":"..."}],"expert_corrections":[{"correction":{"zh":"..."},"comment_id":0}],"spicy":[{"quote":"...","zh":"...","comment_id":0}]}`
}
