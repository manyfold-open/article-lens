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
}

// ── SSE event types (§7) ──────────────────────────────────────────
export type AgentName = 'sum' | 'jargon' | 'comments' | 'ctx' | 'synth'
export type AgentState = 'idle' | 'running' | 'done' | 'error'

export interface SSEPlan   { event: 'plan';   agents: AgentName[] }
export interface SSEStatus { event: 'status'; agent: AgentName; state: AgentState; label: BiStr }
export interface SSEStep   { event: 'step';   agent: AgentName; label: BiStr }
export interface SSEResult { event: 'result'; data: HNLensResult }
export interface SSEError  { event: 'error';  agent?: AgentName; message: string }
// A section streams as soon as its agent finishes, so panels populate early.
export interface SSESection { event: 'section'; agent: AgentName; data: unknown }
export type SSEEvent = SSEPlan | SSEStatus | SSEStep | SSEResult | SSEError | SSESection

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
