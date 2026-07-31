import type { AgentName, HNLensResult, JargonTerm } from '../schema'

// ── Reading results written before the language collapse ──────────
// Every user-facing string used to be a `BiStr = {en, zh}`; it is a plain string
// now. Two stores keep handing back the old shape for a while: the seven-day
// result cache and a Durable Object's retained result (24 hours).
//
// This matters more than it looks. The card renderers interpolate these fields
// directly, so an uncoerced object reaches the reader as the literal text
// "[object Object]" — measurably worse than the mixed language the collapse set
// out to remove. Coerce once at each boundary where old data enters rather than
// teaching every renderer to accept either shape.
//
// Type-only imports on purpose: this module has to stay loadable on its own so
// the coercion can be tested without dragging in the orchestrator's runtime.

export type SharedSections = Pick<HNLensResult, 'summary' | 'comment_digest' | 'verdict'>

/** Take whichever side of a legacy `{en, zh}` holds text; pass a string through. */
export function toText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  const o = v as { en?: unknown; zh?: unknown }
  if (typeof o.en === 'string' && o.en.trim()) return o.en
  if (typeof o.zh === 'string' && o.zh.trim()) return o.zh
  return ''
}

// Each of these is an explicit field walk rather than a deep traversal, because
// `quote`, `appeared_as` and `comment_id` are verbatim source data that has to
// survive untouched.

export function coerceLegacyResult<T>(value: T): T {
  const r = value as HNLensResult | null
  if (!r || typeof r !== 'object') return value
  r.title = toText(r.title)
  if (r.editor_note !== undefined) r.editor_note = toText(r.editor_note)
  if (r.verdict) r.verdict.why_frontpage = toText(r.verdict.why_frontpage)
  if (r.summary) coerceLegacySummary(r.summary)
  if (Array.isArray(r.jargon)) r.jargon = coerceLegacyJargon(r.jargon) as JargonTerm[]
  if (r.comment_digest) coerceLegacyDigest(r.comment_digest)
  if (r.briefing) {
    r.briefing.route = toText(r.briefing.route)
    r.briefing.assignments = (r.briefing.assignments ?? [])
      .map(a => ({ ...a, reason: toText(a.reason) }))
  }
  const sources = r.flags?.agent_sources
  if (sources) {
    for (const key of Object.keys(sources) as AgentName[]) {
      const source = sources[key]
      if (source) source.reason = toText(source.reason)
    }
  }
  return value
}

export function coerceLegacySummary(s: HNLensResult['summary']): HNLensResult['summary'] {
  if (!s || typeof s !== 'object') return s
  s.tldr = toText(s.tldr)
  s.key_points = (s.key_points ?? []).map(toText).filter(Boolean)
  return s
}

export function coerceLegacyDigest(d: HNLensResult['comment_digest']): HNLensResult['comment_digest'] {
  if (!d || typeof d !== 'object') return d
  d.overview = toText(d.overview)
  d.consensus = toText(d.consensus)
  d.camps = (d.camps ?? []).map(c => ({ ...c, label: toText(c.label), stance: toText(c.stance) }))
  d.disputes = (d.disputes ?? []).map(toText).filter(Boolean)
  d.expert_corrections = (d.expert_corrections ?? [])
    .map(e => ({ ...e, correction: toText(e.correction) }))
  // `note` was named `zh` while the remark was written in Chinese. It was never a
  // translation of the quote beside it, so a legacy entry has to keep it.
  d.spicy = (d.spicy ?? []).map(s => ({
    ...s,
    note: toText(s.note ?? (s as { zh?: unknown }).zh),
  }))
  return d
}

export function coerceLegacyJargon(terms: JargonTerm[] | null): JargonTerm[] | null {
  if (!Array.isArray(terms)) return terms
  return terms.map(t => ({ ...t, explain: toText(t.explain) }))
}

export function coerceLegacyShared(shared: SharedSections | null): SharedSections | null {
  if (!shared || typeof shared !== 'object') return shared
  if (shared.summary) coerceLegacySummary(shared.summary)
  if (shared.verdict) shared.verdict.why_frontpage = toText(shared.verdict.why_frontpage)
  if (shared.comment_digest) coerceLegacyDigest(shared.comment_digest)
  return shared
}
