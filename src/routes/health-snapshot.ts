export const HEALTH_FRESHNESS_MS = 2 * 60 * 60_000
const MAX_FUTURE_SKEW_MS = 5 * 60_000

export function parseFreshHealthSnapshot(
  cached: string | null,
  now = Date.now(),
): Record<string, unknown> | null {
  if (!cached) return null
  try {
    const snapshot = JSON.parse(cached) as unknown
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
    const checkedAtValue = (snapshot as { checkedAt?: unknown }).checkedAt
    const checkedAt = typeof checkedAtValue === 'string' ? Date.parse(checkedAtValue) : Number.NaN
    if (!Number.isFinite(checkedAt)) return null
    if (checkedAt < now - HEALTH_FRESHNESS_MS || checkedAt > now + MAX_FUTURE_SKEW_MS) return null
    return snapshot as Record<string, unknown>
  } catch {
    return null
  }
}
