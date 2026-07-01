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
export interface GraphNode { enabled?: boolean; effort?: Effort }
export interface GraphConfig {
  v: number
  // v2 per-agent config. sum/jargon/comments honour enabled+effort; ctx/synth
  // honour enabled only.
  nodes?: Partial<Record<'sum' | 'jargon' | 'comments' | 'ctx' | 'synth', GraphNode>>
  // v1 legacy skip map (kept working; superseded by `nodes` when both present).
  enabled?: Partial<Record<'sum' | 'jargon' | 'comments' | 'ctx', boolean>>
  groups?: { members: string[]; mode: 'parallel' | 'relay' }[]
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
export type SSEEvent = SSEPlan | SSEStatus | SSEStep | SSEResult | SSEError | SSESection | SSEUsage

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
