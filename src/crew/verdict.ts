import type { BiStr, HNLensResult } from '../schema'

const blank = (zh = ''): BiStr => ({ en: '', zh })

export function toBi(v: unknown): BiStr {
  if (v == null) return blank('')
  if (typeof v === 'string') return blank(v)
  if (typeof v !== 'object' || Array.isArray(v)) return blank('')
  const object = v as Record<string, unknown>
  const text = (...keys: string[]): string => {
    for (const key of keys) {
      if (typeof object[key] === 'string' && object[key].trim()) return object[key] as string
    }
    return ''
  }
  const zh = text('zh', 'text', 'value', 'content', 'reason', 'explanation')
  const en = text('en')
  return { en, zh: zh || en }
}

export interface VerdictParseResult {
  verdict: HNLensResult['verdict'] | null
  reason: string
}

export function normalizeContextVerdict(parsed: unknown): VerdictParseResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { verdict: null, reason: 'output was not a JSON object' }
  }
  const root = parsed as Record<string, unknown>
  const candidate = root.verdict && typeof root.verdict === 'object' && !Array.isArray(root.verdict)
    ? root.verdict as Record<string, unknown>
    : root
  const worth = String(candidate.worth_reading ?? candidate.worthReading ?? '').trim().toLowerCase()
  if (worth !== 'high' && worth !== 'medium' && worth !== 'low') {
    return { verdict: null, reason: 'missing valid worth_reading (expected high, medium, or low)' }
  }
  const whyValue = candidate.why_frontpage
    ?? candidate.why_front_page
    ?? candidate.why
    ?? candidate.reason
  const why = toBi(whyValue)
  if (!why.zh.trim()) {
    return { verdict: null, reason: 'missing non-empty why_frontpage text' }
  }
  const rawTier = String(candidate.tier ?? candidate.reading_tier ?? '').trim().toLowerCase()
  const tier = rawTier === '10s' || rawTier === '1min' || rawTier === 'deep' ? rawTier : '1min'
  return {
    verdict: { worth_reading: worth, why_frontpage: why, tier },
    reason: 'valid',
  }
}
