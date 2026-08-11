// ── Bilingual string ──────────────────────────────────────────────

// ── Core types ────────────────────────────────────────────────────
// Why a completed agent call's output could not be parsed. 'truncated' means the
// role wrote past its output cap, so the fix is to ask for less; 'not_json'
// means the prompt or format is not landing. Produced by crew/json.ts.
export type UnparseableKind = 'truncated' | 'not_json' | 'empty'
export type ItemType     = 'article' | 'ask' | 'show' | 'pdf' | 'paywalled'
export type WorthReading = 'high' | 'medium' | 'low'
export type ReadingTier  = '10s' | '1min' | 'deep'
export type CampWeight   = 'majority' | 'vocal-minority' | 'fringe'
export type SeenIn       = 'article' | 'comments' | 'both'

export interface JargonTerm {
  term: string
  explain: string
  seen_in: SeenIn
  appeared_as?: string
  // Selection signals (set by Jargon): whether the term belongs to the article's
  // technical domain, how hard it is (1-5), and whether not knowing it blocks
  // comprehension. Used to rank + filter which terms are worth recording.
  on_topic?: boolean
  difficulty?: number
  blocking?: boolean
}

export interface Camp {
  label: string
  stance: string
  weight: CampWeight
  quote: string
  comment_id: number
}

// One section's size before and after Synthesiser pruned it. Always measured off the
// arrays themselves rather than derived from the curator's keep-indices, because
// `keepByIndex` deliberately keeps the original array when those indices are
// unusable: only measuring reports what the reader actually ends up with.
export interface CurationTrim { before: number; after: number }

export interface ExpertCorrection {
  correction: string
  comment_id: number
}

export interface SpicyTake {
  quote: string
  // The crew's line about the quote. It was named `zh` when the note was written
  // in Chinese and the quote stayed in its original English; both are English
  // now, so the name describes what it is.
  note: string
  comment_id: number
}

// ── Main result schema (§6) ───────────────────────────────────────
export interface HNLensResult {
  item_id: number
  spec_version: number
  type: ItemType
  title: string
  url: string
  meta: { points: number; comments: number; author: string; age: string }
  verdict: { worth_reading: WorthReading; why_frontpage: string; tier: ReadingTier }
  jargon: JargonTerm[]
  summary: { tldr: string; key_points: string[] }
  comment_digest: {
    overview: string
    camps: Camp[]
    consensus: string
    disputes: string[]
    expert_corrections: ExpertCorrection[]
    spicy: SpicyTake[]
  }
  flags: {
    low_confidence: boolean
    comments_sampled: boolean
    no_discussion?: boolean
    fallback_agents?: AgentName[]
    skipped_agents?: AgentName[]
    // `budget_limited` marks a fallback the run's own time budget caused, not
    // the peer. Those do not escalate to a whole-workflow retry, because the
    // retry would reach the same wall.
    agent_sources?: Partial<Record<AgentName, {
      mode: 'real' | 'cache' | 'fallback' | 'skipped'
      reason: string
      budget_limited?: boolean
      // `output_unparseable` marks a fallback where the peer DID answer but the
      // output could not be parsed. Separate from both budget_limited and a
      // transport failure, because the fix differs: 'truncated' means the role
      // wrote past its output cap (ask for less), 'not_json' means the prompt
      // or format is not landing.
      output_unparseable?: UnparseableKind
    }>>
    // What Synthesiser's curation pass actually removed, per section. Absent on results
    // written before this field existed and whenever synth fell back, so the
    // reader is told "not pruned this time" instead of a fabricated zero.
    curation?: {
      jargon: CurationTrim
      key_points: CurationTrim
      camps: CurationTrim
    }
  }
  briefing?: {
    route: string
    assignments: { agent: AgentName; action: 'run' | 'skip' | 'reuse'; reason: string }[]
  }
  // Optional editor's note from the Synthesiser/Synthesizer curation pass.
  editor_note?: string
  // Where the input came from: an HN thread, a bare article URL, or pasted text.
  source?: 'hn' | 'article' | 'text'
  // Token meter: estimated tokens spent this run (input+output), total + per agent.
  // Additive — absent on cached results written before metering existed.
  usage?: { total: number; byAgent: Record<string, number> }
}

// ── Graph config — client-supplied orchestration override ─────────
// Sent on GET /api/analyze as &graph=<encodeURIComponent(JSON.stringify(cfg))>.
//
// v2 (current): `nodes` carries per-agent {enabled?, effort?}. effort defaults
// 'med' (= today's behaviour, byte-for-byte). enabled defaults true. `ctx`/
// `synth` take `enabled` only (effort is ignored for them).
//
// v1 (still accepted for back-compat): `enabled` is a per-key SKIP override
// (false = force skip; true/absent = run as today, cache reuse still applies).
//
// `groups` (both versions): partition the ENABLED stage-1 workers
// {sum,jargon,comments} only (ctx is never grouped). mode 'relay' runs the
// group's members sequentially, threading a short digest of the previous
// member's output into the next member's prompt.
export type Effort = 'low' | 'med' | 'high'
// `replicas` (v2, sum/jargon/comments only): run the agent N times in parallel
// and merge (vote ×N). Default 1 (= today's single run). Typically 1–3; the
// orchestrator clamps out-of-range values. Ignored for ctx/synth.
export interface GraphNode { enabled?: boolean; effort?: Effort; replicas?: number }
export interface GraphConfig {
  v: number
  // v2 per-agent config. sum/jargon/comments honour enabled+effort; ctx/synth
  // honour enabled only.
  nodes?: Partial<Record<'sum' | 'jargon' | 'comments' | 'ctx' | 'synth', GraphNode>>
  // v1 legacy skip map (kept working; superseded by `nodes` when both present).
  enabled?: Partial<Record<'sum' | 'jargon' | 'comments' | 'ctx', boolean>>
  groups?: { members: string[]; mode: 'parallel' | 'relay' }[]
  // Conditional "escalate" mode (Thrifty Progressive): when true, run a cheap phase first
  // (only sum + ctx verdict). If the verdict says the item is worth reading,
  // escalate ("go") and run jargon + comments + synth; otherwise stop and skip
  // jargon + comments. Falsy/absent → today's full flow, byte-for-byte.
  escalate?: boolean
  // "Debate" verdict (Debate Verdict): when true, Context runs TWICE with opposing framings
  // (pro argues worth-reading / con argues skippable) and a third adjudication
  // pass merges them into one balanced verdict. This is the one spot where
  // multi-agent genuinely changes the OUTPUT (opposing prompts, not identical
  // runs). Falsy/absent → single ctx call (= today). Costs ~3× ctx tokens.
  debate?: boolean
  // Reader level (Audience tone): shifts the tone/depth of Summariser/Jargon/Context/Synthesiser.
  // 'beginner' → plainer, more analogies, explain more terms, higher accessibility
  // bar; 'expert' → terser, skip basics, only advanced jargon. Absent → the
  // default (a reader who codes but is not a specialist). Same tokens, different prompt.
  audience?: 'beginner' | 'expert'
}

// ── SSE event types (§7) ──────────────────────────────────────────
export type AgentName = 'sum' | 'jargon' | 'comments' | 'ctx' | 'synth'
export type AgentState = 'idle' | 'running' | 'done' | 'error'
export type AgentRunMode = 'real' | 'cache' | 'fallback' | 'skipped'
export type WorkflowNodeId = 'input' | AgentName | 'report'
export type WorkflowNodeState = 'queued' | 'running' | 'retry_wait' | 'done' | 'error'

export interface SSEPlan   { event: 'plan';   agents: AgentName[] }
export interface SSEStatus { event: 'status'; agent: AgentName; state: AgentState; label: string; mode?: AgentRunMode }
export interface SSEStep   { event: 'step';   agent: AgentName; label: string }
export interface SSEResult { event: 'result'; data: HNLensResult }
export interface SSEError  {
  event: 'error'
  agent?: AgentName
  message: string
  kind?: 'sandbox_unavailable' | 'agent_error' | 'orchestration_error'
}
export interface SSEAgentTrace {
  event: 'agent_trace'
  agent: AgentName
  call_id: string
  phase: 'input' | 'progress' | 'output' | 'error'
  label: string
  at: string
  attempt?: number
  // A failed transport attempt can be recoverable. Consumers must not mark the
  // whole agent terminal while the caller is about to retry the same call.
  will_retry?: boolean
  content?: string
  truncated?: boolean
  original_chars?: number
}
// A section streams as soon as its agent finishes, so panels populate early.
export interface SSESection { event: 'section'; agent: AgentName; data: unknown }
// Token meter: emitted after an agent resolves with that agent's tokens; the
// final one (with `total`) may be sent once at the end. `tokens` is the delta,
// `total`/`byAgent`-derived total is the accumulated run cost.
export interface SSEUsage { event: 'usage'; agent?: string; tokens: number; total?: number }
// Emitted in escalate mode right after the cheap-phase verdict is read, so the
// office can react: 'go' → jargon+comments+synth still run; 'stop' → they're
// skipped. `reason` is a short human-readable note (optional).
export interface SSEEscalate { event: 'escalate'; decision: 'go' | 'stop'; reason?: string }
export interface SSERetry {
  event: 'retry'
  attempt: number
  max_attempts: number
  delay_seconds: number
  reason: string
}
export interface WorkflowPlanNode {
  id: WorkflowNodeId
  kind: 'source' | 'agent' | 'sink'
  label: string
  enabled: boolean
  effort?: Effort
  replicas?: number
  debate?: boolean
}
export interface WorkflowPlanEdge {
  id: string
  from: WorkflowNodeId
  to: WorkflowNodeId
  kind: 'dependency' | 'relay' | 'conditional'
  label?: string
}
export interface SSEWorkflowPlan {
  event: 'workflow_plan'
  analysis_id: string
  attempt: number
  max_attempts: number
  nodes: WorkflowPlanNode[]
  edges: WorkflowPlanEdge[]
  groups: { members: AgentName[]; mode: 'parallel' | 'relay' }[]
  escalate: boolean
  debate: boolean
  audience?: 'beginner' | 'expert'
}
export interface SSEWorkflowState {
  event: 'workflow_state'
  analysis_id: string
  attempt: number
  max_attempts: number
  state: WorkflowNodeState
  reason?: string
  delay_seconds?: number
}
export type SSEEvent = (
  | SSEPlan
  | SSEStatus
  | SSEStep
  | SSEResult
  | SSEError
  | SSEAgentTrace
  | SSESection
  | SSEUsage
  | SSEEscalate
  | SSERetry
  | SSEWorkflowPlan
  | SSEWorkflowState
) & { at?: string }

// ── HN Algolia types ──────────────────────────────────────────────
export interface HNComment {
  id: number
  author: string | null
  text: string | null
  created_at: string
  children: HNComment[]
}

export interface HNItem {
  id: number
  title: string
  url?: string
  text?: string | null
  author: string
  points: number
  created_at: string
  children: HNComment[]
  type: string
}

// ── Cloudflare Worker env bindings ────────────────────────────────
export interface Env {
  CACHE: KVNamespace
  ASSETS: Fetcher
  ANALYSIS_JOBS: DurableObjectNamespace<import('./workflow/analysis-job').AnalysisJob>
  ANALYSIS_TASK_QUEUE: Queue<import('./workflow/analysis-job').AnalysisQueueMessage>
  ADMIN_SETTINGS_PASSWORD?: string
  ACCESS_PASSCODE?: string
  /** Manyfold API origin, without the /api path prefix the connect routes add. */
  MANYFOLD_API_BASE_URL?: string
  /** 'production' turns on the https-only and private-address checks in validateA2AUrl. */
  ENVIRONMENT?: string
  SPEC_VERSION: string
  // Peer-mint era configuration. Removed once src/crew/mf.ts and the mock-mode
  // switches move over to the connect runtime; kept until then so the tree
  // typechecks at every commit in this series.
  MF_API_TOKEN?: string
  MF_API_URL?: string
  MF_AGENT_ID?: string
  AGENT_COMMENT_MAP?: string
  // Agent ids resolved from the connect role map by resolveRuntimeEnv. They are
  // plain strings so the orchestrator keeps reading env.AGENT_* unchanged; only
  // their provenance changed, from wrangler.toml vars to connected agents.
  AGENT_SUMMARIZER: string
  AGENT_CONTEXT: string
  AGENT_SYNTHESIZER: string
  AGENT_JARGON: string
  AGENT_COMMENT_REDUCE: string
  /**
   * Connected agents and their credentials for this invocation. Attached by
   * resolveRuntimeEnv; absent means mock mode. Never serialize it.
   */
  A2A?: import('./connect.ts').A2ARuntime
}
