// ── Bilingual string ──────────────────────────────────────────────
export interface BiStr { en: string; zh: string }

// ── Core types ────────────────────────────────────────────────────
export type ItemType     = 'article' | 'ask' | 'show' | 'pdf' | 'paywalled'
export type WorthReading = 'high' | 'medium' | 'low'
export type ReadingTier  = '10s' | '1min' | 'deep'
export type CampWeight   = 'majority' | 'vocal-minority' | 'fringe'
export type SeenIn       = 'article' | 'comments' | 'both'

export interface JargonTerm {
  term: string
  zh_term: string
  explain: BiStr
  seen_in: SeenIn
  appeared_as?: string
  // Selection signals (set by 小詞): whether the term belongs to the article's
  // technical domain, how hard it is (1-5), and whether not knowing it blocks
  // comprehension. Used to rank + filter which terms are worth recording.
  on_topic?: boolean
  difficulty?: number
  blocking?: boolean
}

export interface Camp {
  label: BiStr
  stance: BiStr
  weight: CampWeight
  quote: string
  comment_id: number
}

export interface ExpertCorrection {
  correction: BiStr
  comment_id: number
}

export interface SpicyTake {
  quote: string
  zh: string
  comment_id: number
}

// ── Main result schema (§6) ───────────────────────────────────────
export interface HNLensResult {
  item_id: number
  spec_version: number
  type: ItemType
  title: BiStr
  url: string
  meta: { points: number; comments: number; author: string; age: string }
  verdict: { worth_reading: WorthReading; why_frontpage: BiStr; tier: ReadingTier }
  jargon: JargonTerm[]
  summary: { tldr: BiStr; key_points: BiStr[] }
  comment_digest: {
    overview: BiStr
    camps: Camp[]
    consensus: BiStr
    disputes: BiStr[]
    expert_corrections: ExpertCorrection[]
    spicy: SpicyTake[]
  }
  flags: {
    low_confidence: boolean
    comments_sampled: boolean
    no_discussion?: boolean
    fallback_agents?: AgentName[]
    skipped_agents?: AgentName[]
    agent_sources?: Partial<Record<AgentName, { mode: 'real' | 'cache' | 'fallback' | 'skipped'; reason: BiStr }>>
  }
  briefing?: {
    route: BiStr
    assignments: { agent: AgentName; action: 'run' | 'skip' | 'reuse'; reason: BiStr }[]
  }
  // Optional editor's note from the 統整/Synthesizer curation pass.
  editor_note?: BiStr
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
  // Conditional "escalate" mode (省錢漸進): when true, run a cheap phase first
  // (only sum + ctx verdict). If the verdict says the item is worth reading,
  // escalate ("go") and run jargon + comments + synth; otherwise stop and skip
  // jargon + comments. Falsy/absent → today's full flow, byte-for-byte.
  escalate?: boolean
  // "Debate" verdict (辯論裁定): when true, 小導 runs TWICE with opposing framings
  // (正方 argues worth-reading / 反方 argues skippable) and a third adjudication
  // pass merges them into one balanced verdict. This is the one spot where
  // multi-agent genuinely changes the OUTPUT (opposing prompts, not identical
  // runs). Falsy/absent → single ctx call (= today). Costs ~3× ctx tokens.
  debate?: boolean
  // Reader level (受眾語氣): shifts the tone/depth of 小摘/小詞/小導/統整.
  // 'beginner' → plainer, more analogies, explain more terms, higher accessibility
  // bar; 'expert' → terser, skip basics, only advanced jargon. Absent → today's
  // default ("會寫程式但非此領域專家", byte-for-byte). Same tokens, different prompt.
  audience?: 'beginner' | 'expert'
}

// ── SSE event types (§7) ──────────────────────────────────────────
export type AgentName = 'sum' | 'jargon' | 'comments' | 'ctx' | 'synth'
export type AgentState = 'idle' | 'running' | 'done' | 'error'

export interface SSEPlan   { event: 'plan';   agents: AgentName[] }
export interface SSEStatus { event: 'status'; agent: AgentName; state: AgentState; label: BiStr }
export interface SSEStep   { event: 'step';   agent: AgentName; label: BiStr }
export interface SSEResult { event: 'result'; data: HNLensResult }
export interface SSEError  { event: 'error';  agent?: AgentName; message: string; kind?: 'sandbox_unavailable' | 'agent_error' }
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
export type SSEEvent = SSEPlan | SSEStatus | SSEStep | SSEResult | SSEError | SSESection | SSEUsage | SSEEscalate

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
  MF_API_TOKEN?: string
  MF_API_URL: string
  MF_AGENT_ID?: string
  SPEC_VERSION: string
  AGENT_SUMMARIZER: string
  AGENT_CONTEXT: string
  AGENT_SYNTHESIZER: string
  AGENT_COMMENT_MAP: string
  AGENT_JARGON: string
  AGENT_COMMENT_REDUCE: string
}
