import type {
  Env, HNItem, HNComment, ItemType, SSEEvent, AgentName, HNLensResult,
  JargonTerm, GraphConfig, Effort,
} from '../schema'
import { getSubtrees } from '../hn'
import { stripHtml } from '../extract'
import { toText } from './legacy'
import type { SharedSections } from './legacy'
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
// Thrifty Progressive runs ctx between two halves of stage 1, so this cannot be monotonic.
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

export type { SharedSections } from './legacy'

// ── Audience (reader level) ────────────────────────────────────────
// A single graph flag shifts the TONE/DEPTH of Summariser/Jargon/Context/
// Synthesiser without changing which agents run. Absent → the default
// (an intermediate dev).
type Audience = 'beginner' | 'expert'
function normAudience(a: unknown): Audience | undefined {
  return a === 'beginner' || a === 'expert' ? a : undefined
}
// The "the reader is…" descriptor shared across prompts.
function readerDesc(a?: Audience): string {
  if (a === 'beginner') return 'the reader is new to programming or to this field'
  if (a === 'expert') return 'the reader is a senior expert in this field'
  return 'the reader can code but is not a specialist in this field'
}
// Per-agent tone directive (leading \n so it slots into a prompt). Empty for the
// default audience, so those prompts stay as they are.
function audienceDirective(a: Audience | undefined, who: 'sum' | 'jargon' | 'ctx'): string {
  if (!a) return ''
  if (who === 'sum') return a === 'beginner'
    ? '\nTone: the reader is a beginner. Use plainer wording, fewer technical terms, and add a line of background where it helps.'
    : '\nTone: the reader is an expert. Assume the basics, go straight to the substance and the deeper detail, and do not explain common knowledge.'
  if (who === 'jargon') return a === 'beginner'
    ? '\nTone: the reader is a beginner. Lower the bar for inclusion (even mid-level common terms are worth explaining) and keep explanations plain, leaning on analogies.'
    : '\nTone: the reader is an expert. Only include genuinely advanced, obscure or subtle terms and skip everything basic or mid-level; explanations can be terse and use professional vocabulary.'
  return a === 'beginner'   // ctx
    ? '\nTone: the reader is a beginner, so judge the reading bar more strictly — a beginner gets stuck more easily.'
    : '\nTone: the reader is an expert, so basic material is a low bar for them; only award the deep tier when the piece genuinely has depth.'
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
  reason: string
}
interface CaptainPlan {
  route: string
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
  emit({ event: 'status', agent: 'sum', state: 'done', mode: 'fallback', label: 'TL;DR done!' })
  emit({ event: 'section', agent: 'sum', data: result.summary })
  await sleep(260)
  emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'fallback', label: `Found ${result.jargon.length} terms! 💡` })
  emit({ event: 'section', agent: 'jargon', data: result.jargon })
  await sleep(260)
  emit({ event: 'status', agent: 'comments', state: 'done', mode: 'fallback', label: `Split into ${result.comment_digest.camps.length} camps!` })
  emit({ event: 'section', agent: 'comments', data: result.comment_digest })
  await sleep(260)
  emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'fallback', label: 'Verdict is in!' })
  emit({ event: 'section', agent: 'ctx', data: result.verdict })
  await sleep(220)
  return result
}

// ── Main orchestration ────────────────────────────────────────────
// Stage 1 (parallel): Summariser summary · Jargon jargon (KB-aware) · Comments comments.
// Stage 2: Context verdict — runs AFTER, fed the summary + comment overview.
// Then Synthesiser/Synthesizer integrates + QA-prunes and the caller emits the final.
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
  // Debate Verdict flag rides on the raw graph (like escalate). Applies wherever Context runs.
  const debate = !!opts.graph?.debate
  const budgetLimited = new Set<AgentName>()
  runStates.set(emit, {
    budget: createRunBudget(Date.now(), ORCHESTRATION_BUDGET_MS, { debate }),
    stage: 'stage1',
    budgetLimited,
  })
  // Audience tone: reader level shifts tone/depth of sum/jargon/ctx/curator prompts.
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
      doneLabel: (merged: Awaited<T>) => string,
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
          reason: 'Every voting replica used fallback output.',
        }
      } else {
        agentSources[agent] = {
          mode: 'real',
          reason: `${real.length}/${n} voting replicas succeeded; merged the valid results.`,
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
              bestSummary, () => 'TL;DR done!')
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
              mergeJargonReplicas, m => `Found ${m.length} terms!`)
    // ctx producer, parameterised by the comment_digest to feed it (cheap phase
    // passes an empty digest — summary-only is fine for a quick worth-reading call).
    const runCtx = (cd: HNLensResult['comment_digest'], jrg: JargonTerm[] = []): Promise<HNLensResult['verdict']> =>
      haveShared ? replaySection('ctx', opts.cachedShared!.verdict, emit, agentSources)
        : graph.enabled.ctx === false ? skipContext(mock, emit, skippedAgents, agentSources)
          : runContext(env, item, summary, cd, jrg, mock, emit, fallbackAgents, agentSources, meter, debate, audience)

    if (opts.graph?.escalate) {
      // ── Conditional escalate (Thrifty Progressive): cheap first, escalate if worthy ──
      // Phase 1 (cheap): sum + ctx only. ctx runs on the summary alone (empty
      // comment_digest) — good enough for a quick "is it worth reading" call.
      summary = await runSum()
      assertCriticalAgents(fallbackAgents, opts.requireCriticalAgents, ['sum'], budgetLimited)
      const emptyDigest = normalizeDigest({
        overview: '', camps: [], consensus: '', disputes: [], expert_corrections: [], spicy: [],
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

      // ── Stage 2: ctx — now also fed Jargon's jargon density (dep edge). ──
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
    // Jargon runs in parallel with Summariser/Comments; await it BEFORE Context so the verdict can
    // weigh jargon density (the Jargon→Context dependency edge). It's usually already
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
    title: '',
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
      reason: 'You turned Synthesiser off in the editor, so the original role outputs were kept.',
    }
    emit({ event: 'status', agent: 'synth', state: 'done', mode: 'skipped', label: 'Turned off, skipping synthesis' })
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
  if (agentSources) agentSources[agent] = { mode: 'cache', reason: 'Reused this section from the previous cache, the agent was not called again.' }
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
        ? 'The summary is already cached, reusing it as-is.'
        : 'Read the article first to pull out a one-liner and the key points.',
    },
    {
      agent: 'jargon',
      action: cachedJargon ? 'reuse' : (looksTechnical && textLen >= 220 ? 'run' : 'skip'),
      reason: cachedJargon
        ? 'The jargon list is already cached against your known-terms list.'
        : looksTechnical && textLen >= 220
          ? 'The content looks technically dense, so let Jargon pick out the terms that would actually trip readers up.'
          : 'The content is too short or not technical, so skipping the jargon hunt for now.',
    },
    {
      agent: 'comments',
      action: cachedShared ? 'reuse' : (comments >= 3 ? 'run' : 'skip'),
      reason: cachedShared
        ? 'The comment digest is already cached, reusing it as-is.'
        : comments >= 3
          ? commentsWereSampled(item) ? 'There are a lot of comments, so sampling the highest-signal threads to analyse.' : 'There are enough comments, so let Comments sort out the camps.'
          : 'Too few comments to bother with camp analysis.',
    },
    {
      agent: 'ctx',
      action: cachedShared ? 'reuse' : 'run',
      reason: cachedShared
        ? 'The verdict is already cached.'
        : 'Wait for the summary and comment overview, then judge whether it is worth reading.',
    },
  ]
  const route = assignments
    .map(a => `${agentEn(a.agent)}: ${actionEn(a.action)}`)
    .join(' · ')
  return { route, assignments }
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
      a.reason = 'You turned this one off in the editor panel, so skipping it this round.'
    }
  }
  plan.route = plan.assignments.map(a => `${agentEn(a.agent)}: ${actionEn(a.action)}`).join(' · ')
}

// Build a substantive digest of a stage-1 agent's output to thread into the
// next relay member's prompt. Richer than a TL;DR: enough for the downstream
// agent to genuinely anchor on the upstream result. Each section is capped so
// the prompt stays sane (key points ≤ 10, camps ≤ 6, terms ≤ 12).
function relayDigest(agent: Stage1Agent, value: unknown): string {
  if (agent === 'sum') {
    const s = value as HNLensResult['summary']
    const kp = (s.key_points ?? []).slice(0, 10).map(k => `- ${toText(k)}`).join('\n')
    return [`TL;DR: ${toText(s.tldr)}`, kp && `Key points:\n${kp}`].filter(Boolean).join('\n')
  }
  if (agent === 'comments') {
    const cd = value as HNLensResult['comment_digest']
    const camps = (cd.camps ?? []).slice(0, 6)
      .map(c => `- ${toText(c.label)}${toText(c.stance) ? `: ${toText(c.stance)}` : ''}`)
      .join('\n')
    return [`Discussion shape: ${toText(cd.overview)}`, camps && `Camps:\n${camps}`].filter(Boolean).join('\n')
  }
  // jargon
  const terms = value as JargonTerm[]
  return (terms ?? []).slice(0, 12).map(t => `- ${t.term}: ${toText(t.explain)}`).join('\n')
}

// Per-pair directive telling the downstream agent HOW to use the upstream
// output, so relay makes a real, explainable difference from parallel.
function relayDirective(upstream: Stage1Agent, downstream: Stage1Agent): string {
  if (downstream === 'jargon' && upstream === 'sum')
    return 'Explain the core concepts the summary above emphasises first, then add the remaining terms, so the term list tracks what the article is actually about.'
  if (downstream === 'jargon' && upstream === 'comments')
    return 'As well as the article\'s terms, include the words the discussion above argues over or keeps returning to (the community\'s own jargon) — do not work from the article alone.'
  if (downstream === 'comments' && upstream === 'sum')
    return 'Organise the camps and disputes around the main claims and sections the summary above identifies, so the camps map onto the article\'s core arguments.'
  if (downstream === 'comments' && upstream === 'jargon')
    return 'Where a camp\'s disagreement actually turns on one of the technical terms above, say which term it is.'
  if (downstream === 'sum')
    return 'Give extra weight to what the previous step emphasised.'
  return 'Use the previous step\'s output as context and focus on what it emphasised.'
}

// Compose the full relay context block injected into a downstream member's
// prompt: a clearly-labelled upstream digest + the per-pair directive.
function relayContext(upstream: Stage1Agent, downstream: Stage1Agent, value: unknown): string {
  const digest = relayDigest(upstream, value)
  const directive = relayDirective(upstream, downstream)
  return `[Relay context — from the previous step (${agentEn(upstream)})]\n${digest}\n→ ${directive}`
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

// Display names for the agents, used in route/reason strings that go straight
// to the client and in the relay context block handed to a downstream peer.
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

// ── Summariser summary ───────────────────────────────────────────────────
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
      tldr: toText(p.tldr),
      key_points: (Array.isArray(p.key_points) ? p.key_points : []).map(toText).filter(Boolean),
    }
    if (!quiet) {
      emit({ event: 'status', agent: 'sum', state: 'done', mode: 'real', label: 'TL;DR done!' })
      emit({ event: 'section', agent: 'sum', data: summary })
    }
    if (agentSources) agentSources.sum = { mode: 'real', reason: 'Summariser actually read the article content to produce this.' }
    return summary
  } catch (e) {
    fallbackAgents?.add('sum')
    noteBudgetLimit(emit, 'sum', e)
    const sandboxReason = emitAgentFailure('sum', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'sum', state: 'done', mode: 'fallback', label: 'Summary used fallback content' })
      emit({ event: 'section', agent: 'sum', data: mock.summary })
    }
    if (agentSources) agentSources.sum = {
      mode: 'fallback',
      reason: fallbackReason('sum', e, sandboxReason, 'falling back to the local backup summary'),
      budget_limited: isBudgetExhaustedError(e) || undefined,
    }
    return mock.summary
  } finally {
    if (!quiet) meter?.finish('sum')
  }
}

// Graph-only: force-skip Summariser (no captain skip path exists). Mirrors the other
// skip helpers — empty/placeholder section + a done status + skipped source.
async function skipSummary(
  mock: HNLensResult,
  emit: (e: SSEEvent) => void,
  skippedAgents: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<HNLensResult['summary']> {
  skippedAgents.add('sum')
  const empty: HNLensResult['summary'] = {
    tldr: 'You turned Summariser off in the editor panel, so no summary was produced this round.',
    key_points: [],
  }
  emit({ event: 'status', agent: 'sum', state: 'done', mode: 'skipped', label: 'Turned off, skipping summary' })
  emit({ event: 'section', agent: 'sum', data: empty })
  if (agentSources) agentSources.sum = { mode: 'skipped', reason: 'You turned Summariser off in the editor panel, so the summary agent was not called.' }
  return empty
}

// ── Context verdict (depends on summary + comments + Jargon jargon) ──────
// The one meaningful dependency edge: Context also reads Jargon's jargon density
// (how many blocking / hard terms) so its worth_reading/tier/why reflect the
// article's reading accessibility, not just its content. `jargon` may be empty
// (e.g. the cheap escalate phase before Jargon runs) — then it's ignored.
// Parse a Context verdict JSON into a typed verdict, or null if unusable.
function parseVerdict(text: string): HNLensResult['verdict'] | null {
  const p = parseLoose<{ worth_reading?: string; why_frontpage?: unknown; tier?: string }>(text)
  const worth = String(p?.worth_reading ?? '').trim().toLowerCase()
  if (worth !== 'high' && worth !== 'medium' && worth !== 'low') return null
  const why = toText(p?.why_frontpage)
  if (!why.trim()) return null
  const rawTier = String(p?.tier ?? '').trim()
  const tier = rawTier === '10s' || rawTier === '1min' || rawTier === 'deep' ? rawTier : '1min'
  return {
    worth_reading: worth,
    why_frontpage: why,
    tier,
  }
}

// Debate Verdict: run Context twice with opposing framings (pro/con) in parallel, then a
// third adjudication pass merges them into one balanced verdict. Throws only if
// BOTH sides fail (→ outer fallback); a single failed side still adjudicates.
async function debateVerdict(
  env: Env, item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'],
  jargon: JargonTerm[], mock: HNLensResult, emit: (e: SSEEvent) => void, meter?: UsageMeter, audience?: Audience
): Promise<HNLensResult['verdict']> {
  emit({ event: 'step', agent: 'ctx', label: 'Pro vs con debating…' })
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
  emit({ event: 'step', agent: 'ctx', label: 'Head judge deliberating…' })
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
  emit({ event: 'status', agent: 'ctx', state: 'running', label: debate ? 'Debating verdict…' : LABELS.ctx.running })
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
    emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'real', label: debate ? 'Debate verdict is in!' : 'Verdict is in!' })
    emit({ event: 'section', agent: 'ctx', data: verdict })
    if (agentSources) agentSources.ctx = { mode: 'real', reason: debate ? 'Context reached a balanced verdict after arguing both sides of the debate.'
        : jargon.length ? "Context re-judged this based on the summary, comment overview, and Jargon's term density."
          : 'Context re-judged this based on the summary and comment overview.' }
    return verdict
  } catch (e) {
    fallbackAgents?.add('ctx')
    noteBudgetLimit(emit, 'ctx', e)
    const sandboxReason = emitAgentFailure('ctx', e, emit)
    emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'fallback', label: 'Verdict used fallback content' })
    emit({ event: 'section', agent: 'ctx', data: mock.verdict })
    if (agentSources) agentSources.ctx = {
      mode: 'fallback',
      reason: fallbackReason('ctx', e, sandboxReason, 'falling back to the local verdict'),
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

// Graph-only: force-skip Context. Mirrors the other skip helpers.
async function skipContext(
  mock: HNLensResult,
  emit: (e: SSEEvent) => void,
  skippedAgents: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>
): Promise<HNLensResult['verdict']> {
  skippedAgents.add('ctx')
  const empty: HNLensResult['verdict'] = {
    worth_reading: mock.verdict.worth_reading,
    why_frontpage: 'You turned Verdict off in the editor panel, so no new verdict was made this round.',
    tier: mock.verdict.tier,
  }
  emit({ event: 'status', agent: 'ctx', state: 'done', mode: 'skipped', label: 'Turned off, skipping verdict' })
  emit({ event: 'section', agent: 'ctx', data: empty })
  if (agentSources) agentSources.ctx = { mode: 'skipped', reason: 'You turned Verdict off in the editor panel, so the verdict agent was not called.' }
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
    return { rankedBudget: 1400, reduceCap: 4000, campsHint: 'Pick only the 2-3 most significant camps (fewer is better than padded).' }
  if (effort === 'high')
    return { rankedBudget: 3600, reduceCap: 12000, campsHint: 'Cover as many camps as you can (including vocal-minority and fringe ones), up to 6.' }
  return { rankedBudget: 2600, reduceCap: 8000, campsHint: '' }
}

// ── Comments comments (token-budgeted, high-signal first) ──────────────
async function runComments(
  env: Env, item: HNItem, mock: HNLensResult, emit: (e: SSEEvent) => void, fallbackAgents?: Set<AgentName>,
  agentSources?: NonNullable<HNLensResult['flags']['agent_sources']>,
  extraContext?: string, effort: Effort = 'med', meter?: UsageMeter, quiet = false
): Promise<HNLensResult['comment_digest']> {
  const commentCount = item.children?.length ?? 0
  if (commentCount === 0) {
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'running', label: 'No HN discussion on this one' })
      emit({ event: 'status', agent: 'comments', state: 'done', mode: 'skipped', label: 'No comments' })
      emit({ event: 'section', agent: 'comments', data: mock.comment_digest })
      meter?.finish('comments')
    }
    if (agentSources) agentSources.comments = {
      mode: 'skipped',
      reason: 'This item has no HN comments, so the Comments agent was not called.',
    }
    return mock.comment_digest
  }
  if (!quiet) emit({ event: 'status', agent: 'comments', state: 'running', label: `Diving into ${commentCount} comments…` })
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
        ? 'Comments actually analysed the highest-signal threads.'
        : 'Comments actually analysed the comments.',
    }
    return cd
  } catch (e) {
    fallbackAgents?.add('comments')
    noteBudgetLimit(emit, 'comments', e)
    const sandboxReason = emitAgentFailure('comments', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'comments', state: 'done', mode: 'fallback', label: 'Comments used fallback content' })
      emit({ event: 'section', agent: 'comments', data: mock.comment_digest })
    }
    if (agentSources) agentSources.comments = {
      mode: 'fallback',
      reason: fallbackReason('comments', e, sandboxReason, 'falling back to the local comment digest'),
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
    overview: 'Too few comments, so the captain skipped Comments’ camp analysis.',
    camps: [],
    consensus: 'Not enough discussion yet to form a consensus.',
    disputes: [],
    expert_corrections: [],
    spicy: [],
  })
  emit({ event: 'status', agent: 'comments', state: 'done', mode: 'skipped', label: 'Too few comments, skipped' })
  emit({ event: 'section', agent: 'comments', data: empty.overview ? empty : mock.comment_digest })
  if (agentSources) agentSources.comments = { mode: 'skipped', reason: 'Too few comments, so the captain decided Comments did not need to be called.' }
  return empty.overview ? empty : mock.comment_digest
}

function normalizeDigest(d: HNLensResult['comment_digest']): HNLensResult['comment_digest'] {
  return {
    overview: toText(d.overview),
    camps: (d.camps ?? []).map(c => ({
      label: toText(c.label), stance: toText(c.stance),
      weight: c.weight || 'majority', quote: c.quote || '', comment_id: c.comment_id || 0,
    })),
    consensus: toText(d.consensus),
    disputes: (d.disputes ?? []).map(toText).filter(Boolean),
    expert_corrections: (d.expert_corrections ?? []).map(ec => ({ correction: toText(ec.correction), comment_id: ec.comment_id || 0 })),
    spicy: (d.spicy ?? []).map(s => ({ quote: s.quote || '', note: toText(s.note), comment_id: s.comment_id || 0 })),
  }
}

interface CuratorDecision {
  jargon_keep?: number[]
  key_points_keep?: number[]
  camps_keep?: number[]
  summary_ok?: boolean
  note?: string
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
  emit({ event: 'status', agent: 'synth', state: 'running', label: 'Synthesising…' })
  meter?.add('synth', prompt.length, 0)
  try {
    const text = await inStage(emit, 'synth', () =>
      callAgent(env, env.AGENT_SYNTHESIZER, prompt, 'synth', emit, { timeoutMs: 240_000, attempts: 2 }))
    meter?.add('synth', 0, text.length)
    const d = parseLoose<CuratorDecision>(text)
    if (!d) throw new Error('Synthesiser returned output that could not be parsed as the required curation JSON.')
    applyCuration(result, d)
    emit({ event: 'status', agent: 'synth', state: 'done', mode: 'real', label: 'Synthesis done!' })
    if (agentSources) agentSources.synth = { mode: 'real', reason: 'Synth actually reviewed and pruned each section’s output.' }
  } catch (e) {
    fallbackAgents?.add('synth')
    noteBudgetLimit(emit, 'synth', e)
    const sandboxReason = emitAgentFailure('synth', e, emit)
    emit({ event: 'status', agent: 'synth', state: 'done', mode: 'fallback', label: 'Synthesis skipped' })
    if (agentSources) agentSources.synth = {
      mode: 'fallback',
      budget_limited: isBudgetExhaustedError(e) || undefined,
      reason: sandboxReason
        ? `Synth's sandbox/runtime is offline, so each section's raw results are kept instead of waiting for QA pruning. Reason: ${sandboxReason}`
        : `Synth exceeded its wait budget or the runtime failed, so each section's raw results are kept instead of waiting for QA pruning. Reason: ${shortErr(e)}`,
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
  const note = toText(d.note)
  if (note) result.editor_note = note
  if (d.summary_ok === false) result.flags.low_confidence = true
}

function buildCuratorPrompt(item: HNItem, r: HNLensResult, audience?: Audience): string {
  const jl = r.jargon.map((t, i) => `${i}: ${t.term} — ${t.explain}`).join('\n')
  const kp = r.summary.key_points.map((k, i) => `${i}: ${k}`).join('\n')
  const camps = r.comment_digest.camps.map((c, i) => `${i}: [${c.weight}] ${c.label} — ${(c.quote || '').slice(0, 80)}`).join('\n')

  return `You are the Synthesiser, responsible for integration and quality control. Assume ${readerDesc(audience)}. Review what the four agents produced, decide what to keep, and fix inconsistencies across sections.

JARGON — first identify this article's core technical field, then keep only 4-8 terms that belong to that field AND would genuinely block understanding of this article. Cut duplicates, the too-obvious, circular definitions, and anything off-topic or non-technical (ordinary words, unrelated proper nouns):
${jl || '(none)'}

KEY POINTS — cut the redundant, thin and repetitive; keep the substantive:
${kp || '(none)'}

CAMPS — cut near-duplicates and trivia; keep the genuinely distinct viewpoints:
${camps || '(none)'}

Summary TL;DR: ${r.summary.tldr || '(none)'}

Return the 0-based indexes to KEEP from each list (a subset, any order), whether the summary passes, and a one-sentence editor's note in British English.
Return only this JSON (no markdown; never use the " character inside string values — use ' instead):
{"jargon_keep":[0,1,2],"key_points_keep":[0,1],"camps_keep":[0,1],"summary_ok":true,"note":"..."}`
}

// ── Agent caller labels ────────────────────────────────────────────
const LABELS: Record<AgentName, { running: string; done: string }> = {
  sum:      { running: 'Reading the article…',              done: 'TL;DR done!' },
  jargon:   { running: 'Hunting for jargon…',               done: 'Jargon explained!' },
  comments: { running: 'Diving into the comments…',         done: 'Comments analysed!' },
  ctx:      { running: 'Judging if it is worth reading…',   done: 'Verdict is in!' },
  synth:    { running: 'Synthesising…',                     done: 'Synthesis done!' },
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
    label: 'Ranked high-signal comments; clustering directly…',
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
    ? 'Produce one terse TL;DR plus at most 3 of the most important key points (fewer is better than padded).'
    : effort === 'high'
      ? 'Produce one TL;DR plus 5-7 key points, covering more angles and detail.'
      : 'Produce one TL;DR plus 3-4 key points.'
  return `You are the Summariser, a concise summarising agent.
${relayBlock(extraContext)}Title: ${item.title}
Type: ${itemType}
Content:
${content}

${ask} If the content is too thin, infer from the title and say that you are unsure. Write everything in British English.${audienceDirective(audience, 'sum')}

Return only this JSON (no markdown; never use the " character inside string values — use ' instead):
{"tldr":"...","key_points":["..."]}`
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
  const where = part.n > 1 ? ` (part ${part.i + 1}/${part.n} of the article)` : ''
  // effort → per-window term target. 'med' keeps the "10-16" ask.
  const target = effort === 'low' ? '4-6' : effort === 'high' ? '12-16' : '10-16'
  const knownLine = known.length
    ? `\nThe reader ALREADY KNOWS these terms. Skip them, and spend the budget on genuinely new or less obvious ones:\n${known.join(', ')}\n`
    : ''
  const candLine = candidates.length
    ? `\nBelow are candidate terms a script scanned out of the full text (it is noisy). Review them one by one, keep the ones that belong to this article's technical field and that the reader may not know, ignore the rest; also add terms you spotted yourself that the list missed:\n${candidates.join(', ')}\n`
    : ''
  return `You are the Jargon agent, explaining technical terms in plain language for Hacker News readers.
${relayBlock(extraContext)}Article title: ${item.title}

Article body${where} (read it carefully and pick terms from the whole passage, not just the opening):
${articleChunk || '(no article text available)'}
${commentSample ? `\nSample of the HN comments (mark terms that appear here with seen_in "comments"):\n${commentSample}` : ''}
${candLine}${knownLine}
Step one: work out this article's core technical field (for example AI/machine learning, agents/LLMs, databases, distributed systems, frontend, cryptography…).
Step two: pull out the terms that belong to that field AND that someone who can code but does not work in this sub-field would not immediately understand — aim for ${target} in this passage, and prefer including one too many over missing one.
Be sure to cover the core concept or method named in the article title, along with any coined terms that recur, even multi-word ones (for example 'loop engineering', 'context engineering', 'reward model', 'agent loop').
Targets: acronyms, library/product/algorithm/model names, field jargon and methods (RLHF, PPO, reward model, eval, rubric, grader, rollout, distillation and the like), non-obvious technical metrics, and informal technical coinages. Scan the middle and the end too.

Bar for inclusion: include it if someone outside this sub-field would not immediately understand it.
Only skip a term when it is:
- genuinely universal (HTTP, JSON, API, CPU, URL)
- a proper noun unrelated to the core technical topic (people, places, non-technical company names)
- clearly defined in the body itself, or already on the "reader knows this" list above

Rate every term:
- on_topic: true = belongs to this article's technical field and is relevant; false = off-topic or non-technical (it will be dropped)
- difficulty: 1-5, how hard it is for someone who codes but not in this field
- blocking: true = not knowing this term blocks understanding of the article

Explanation style (British English): 1-2 sentences, never circular, never jargon explained with jargon, and use a concrete analogy where it earns its place.${audienceDirective(audience, 'jargon')}
seen_in: "article" / "comments" / "both". appeared_as: the source phrase it appeared in.

Return only this JSON array (no markdown; never use the " character inside string values — use ' instead):
[{"term":"...","explain":"...","seen_in":"article","appeared_as":"source phrase","on_topic":true,"difficulty":3,"blocking":true}]`
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
    if (prompts.length > 1 && !quiet) emit({ event: 'step', agent: 'jargon', label: `Reading the full article in ${prompts.length} passes…` })
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
      // The peers answered; their output was unusable. Jargon has the longest
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
      emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'real', label: `Found ${merged.length} terms!` })
      emit({ event: 'section', agent: 'jargon', data: merged })
    }
    if (agentSources) agentSources.jargon = {
      mode: 'real',
      reason: `Jargon actually analysed the article's terms; this run waited up to ${Math.round(timeoutMs / 1000)}s.`,
    }
    return merged
  } catch (e) {
    fallbackAgents?.add('jargon')
    noteBudgetLimit(emit, 'jargon', e)
    const sandboxReason = emitAgentFailure('jargon', e, emit)
    if (!quiet) {
      emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'fallback', label: 'Jargon used fallback content' })
      emit({ event: 'section', agent: 'jargon', data: [] })
    }
    if (agentSources) agentSources.jargon = {
      mode: 'fallback',
      budget_limited: isBudgetExhaustedError(e) || undefined,
      output_unparseable: isUnparseableOutputError(e) ? e.classification : undefined,
      reason: sandboxReason
        ? `Jargon's sandbox/runtime is offline, so the jargon list is skipped for now to avoid stalling the whole run. Reason: ${sandboxReason}`
        // A cut-off or non-JSON answer is NOT a timeout: Jargon replied, and saying
        // it "did not respond in time" sends the next fix at the wrong target.
        : isUnparseableOutputError(e)
          ? e.classification === 'truncated'
            ? `Jargon did reply, but its term list was cut off mid-answer and could not be parsed, so no terms are shown. It has the longest output of any role, so it is the likeliest to exceed the output cap.`
            : `Jargon did reply, but the content was not parseable JSON, so no terms are shown. Reason: ${shortErr(e)}`
          : `Jargon waits up to ${Math.round(timeoutMs / 1000)}s; it did not respond in time this run, so the jargon list is skipped to avoid stalling the whole run. Reason: ${shortErr(e)}`,
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
  emit({ event: 'status', agent: 'jargon', state: 'done', mode: 'skipped', label: 'Not technical, skipping jargon' })
  emit({ event: 'section', agent: 'jargon', data: [] })
  if (agentSources) agentSources.jargon = { mode: 'skipped', reason: 'The captain judged the content too short or not technical, so Jargon was not called.' }
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

function fallbackReason(agent: WorkerAgent, e: unknown, sandboxReason: string | null, fallbackText: string): string {
  const name = agentEn(agent)
  if (isBudgetExhaustedError(e))
    return `${name} ran out of the time this round allotted it (later roles keep a reserve), so ${fallbackText}; the whole run is not retried for this.`
  if (sandboxReason)
    return `${name}'s sandbox/runtime is offline, so ${fallbackText}. Reason: ${sandboxReason}`
  return `${name} did not respond successfully, so ${fallbackText}. Reason: ${shortErr(e)}`
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
      t.explain = toText(t.explain)
      const key = normTerm(t.term)                 // merge case / spacing / singular-plural
      const prev = byTerm.get(key)
      if (!prev) { byTerm.set(key, t); continue }
      if (prev.seen_in !== t.seen_in) prev.seen_in = 'both'
      const prevLen = prev.explain?.length ?? 0
      const curLen = t.explain?.length ?? 0
      if (curLen > prevLen) { t.seen_in = prev.seen_in; byTerm.set(key, t) }
    }
  }
  // Rank by signal: blocking first, then difficulty, then appears in both
  // article+comments (more salient), then explanation richness. Keep the top 10.
  const score = (t: JargonTerm) =>
    (t.blocking ? 100 : 0) +
    (typeof t.difficulty === 'number' ? t.difficulty * 10 : 20) +
    (t.seen_in === 'both' ? 8 : 0) +
    Math.min(6, (t.explain?.length ?? 0) / 20)
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
  const nonEmpty = cands.filter(s => s && (s.key_points?.length || s.tldr))
  if (!nonEmpty.length) return cands[0]
  return nonEmpty.reduce((best, s) => {
    const bk = best.key_points?.length ?? 0, sk = s.key_points?.length ?? 0
    if (sk !== bk) return sk > bk ? s : best
    return (s.tldr?.length ?? 0) > (best.tldr?.length ?? 0) ? s : best
  })
}

// comments: pick the BEST non-empty digest — most camps, tie → longest
// overview. If every replica is empty, return the first (keeps empty as today).
function bestDigest(cands: HNLensResult['comment_digest'][]): HNLensResult['comment_digest'] {
  const nonEmpty = cands.filter(c => c && (c.camps?.length || c.overview))
  if (!nonEmpty.length) return cands[0]
  return nonEmpty.reduce((best, c) => {
    const bc = best.camps?.length ?? 0, cc = c.camps?.length ?? 0
    if (cc !== bc) return cc > bc ? c : best
    return (c.overview?.length ?? 0) > (best.overview?.length ?? 0) ? c : best
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

// A compact reading-accessibility line derived from Jargon's term list: how many
// blocking / hard terms there are. Empty string when Jargon didn't run (so the
// prompt stays as before), so Context only weighs density when it actually exists.
function jargonAccessibilityLine(jargon: JargonTerm[]): string {
  const n = jargon?.length ?? 0
  if (!n) return ''
  const blocking = jargon.filter(t => t.blocking).length
  const hard = jargon.filter(t => (t.difficulty ?? 0) >= 4).length
  const names = jargon.slice(0, 6).map(t => t.term).filter(Boolean).join(', ')
  return `Term density (from the Jargon agent): ${n} key terms, of which ${blocking} block understanding if unknown and ${hard} are on the hard side${names ? ` (for example: ${names})` : ''}. The more terms, and the harder they are, the higher the reading bar.\n`
}

// Shared content block for every Context prompt (single verdict + debate sides +
// adjudication), so all of them judge the exact same material.
function verdictContext(
  item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'], jargon: JargonTerm[]
): { isHN: boolean; subject: string; block: string; jargonLine: string } {
  const kp = (summary.key_points ?? []).map(k => `- ${toText(k)}`).join('\n')
  // Source-aware: only an actual HN thread gets the "front page / points" framing.
  const isHN = (item.points ?? 0) > 0 || (item.children?.length ?? 0) > 0
  const subject = isHN ? 'a Hacker News post' : 'an article or passage of content'
  const metaLine = isHN ? `Points: ${item.points} · Comments: ${item.children?.length ?? 0}\n` : ''
  const discussion = isHN ? `\nOverall shape of the comments: ${toText(cd.overview) || '(no discussion)'}\n` : ''
  const jargonLine = jargonAccessibilityLine(jargon)
  const block = `Title: ${item.title}
${metaLine}Article TL;DR: ${toText(summary.tldr) || '(none)'}
Key points:
${kp || '(none)'}
${discussion}${jargonLine}`
  return { isHN, subject, block, jargonLine }
}

const VERDICT_JSON = 'Return only this JSON (no markdown; never use the " character inside string values — use \' instead):\n{"worth_reading":"high","why_frontpage":"...","tier":"deep"}'

function buildContextPrompt(
  item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'], jargon: JargonTerm[] = [], audience?: Audience
): string {
  const { isHN, subject, block, jargonLine } = verdictContext(item, summary, cd, jargon)
  const whyQ = isHN
    ? 'why_frontpage: why is it worth reading, and why did it reach the HN front page? 1-2 sentences that reflect the actual content above'
    : 'why_frontpage: why is this worth reading, and what is the core value? 1-2 sentences that reflect the actual content (do not mention the front page or points)'
  // Only ask Context to weigh accessibility when Jargon actually supplied density data.
  const accessibilityNote = jargonLine
    ? '\nWeigh the reading bar too (the term density above): many hard terms → tier leans "deep"; low bar and easy going → leans "10s"/"1min". If the bar is high, why_frontpage may note that some domain background is needed.'
    : ''
  return `You are the Context agent, assessing ${subject}. Judge from the actual content${isHN ? ', not just the score' : ''}.

${block}
Answer three things, in British English:
1. worth_reading: "high" (must read), "medium" (interesting) or "low" (skippable)
2. ${whyQ}
3. tier: "10s", "1min" or "deep"${accessibilityNote}${audienceDirective(audience, 'ctx')}

${VERDICT_JSON}`
}

// One debate side: the SAME material, argued from a fixed stance. The pro side
// makes the strongest case it's worth reading; the con side the case to skip it.
// Each still returns the standard verdict JSON, but leaning to its side.
function buildDebatePrompt(
  item: HNItem, summary: HNLensResult['summary'], cd: HNLensResult['comment_digest'],
  jargon: JargonTerm[], side: 'pro' | 'con', audience?: Audience
): string {
  const { subject, block } = verdictContext(item, summary, cd, jargon)
  const stance = side === 'pro'
    ? 'You are arguing FOR the motion: make the strongest case that this is worth reading (lean high/medium). Find the genuine highlights and value.'
    : 'You are arguing AGAINST the motion: make the strongest case that this can be skipped (lean low/medium). Point out where it is thin, rehashed, too high a bar, or poor value for the time.'
  return `You are taking part in a debate-style assessment of ${subject}. ${stance} Work only from the actual content below; invent nothing.

${block}
Answer from your side of the debate, in British English:
1. worth_reading: "high" / "medium" / "low"
2. why_frontpage: your side's single strongest reason
3. tier: "10s" / "1min" / "deep"${audienceDirective(audience, 'ctx')}

${VERDICT_JSON}`
}

// Adjudication: a neutral chief judge weighs both sides into ONE balanced verdict.
function buildDebateMergePrompt(item: HNItem, pro: HNLensResult['verdict'] | null, con: HNLensResult['verdict'] | null): string {
  const side = (v: HNLensResult['verdict'] | null) =>
    v ? `worth_reading=${v.worth_reading}, tier=${v.tier}, reason: ${toText(v.why_frontpage) || '(none)'}` : '(this side did not manage to argue)'
  return `You are the head judge. Two sides have just debated whether '${item.title}' is worth reading:

FOR, arguing it is worth reading: ${side(pro)}
AGAINST, arguing it can be skipped: ${side(con)}

Weigh the soundest arguments from both sides into one final balanced verdict. Take the most honest worth_reading between them; why_frontpage should reflect what holds true on both sides (an 'although… it still…' shape works well), in one sentence; tier should reflect the effort the piece genuinely needs. Write in British English.

${VERDICT_JSON}`
}

function buildCommentReducePrompt(
  subtreeSummaries: string[], item: HNItem, extraContext?: string,
  params: CommentParams = commentParams('med')
): string {
  const summaries = subtreeSummaries.filter(Boolean).join('\n\n---\n\n').slice(0, params.reduceCap)
  // effort's camps directive (empty at 'med' → prompt stays byte-for-byte today's).
  const campsLine = params.campsHint ? `${params.campsHint}\n` : ''
  return `You are the Comments agent, analysing the Hacker News discussion of '${item.title}'.
${relayBlock(extraContext)}Total comments: ${item.children?.length ?? 0}

Per-thread summaries:
${summaries}

Find the structure of the discussion: the main camps (majority / vocal-minority / fringe), the consensus, the main disputes, any expert corrections to the article, and the most striking or spiciest single take.
${campsLine}Carry comment_id wherever you can so the reader can find the original comment. Write in British English.

Return only this JSON (no markdown; never use the " character inside string values — use ' instead):
{"overview":"...","camps":[{"label":"...","stance":"...","weight":"majority","quote":"verbatim excerpt","comment_id":0}],"consensus":"...","disputes":["..."],"expert_corrections":[{"correction":"...","comment_id":0}],"spicy":[{"quote":"...","note":"...","comment_id":0}]}`
}
