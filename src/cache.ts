import type { Env } from './schema'

const CACHE_TTL_SECONDS = 86400 * 7

// Keep cache failures from taking down an analysis. Local development and tests
// can run without a bound namespace, while production still benefits from KV.
export async function cacheGet(env: Env, key: string): Promise<string | null> {
  try {
    return env.CACHE ? await env.CACHE.get(key) : null
  } catch {
    return null
  }
}

export async function cachePut(env: Env, key: string, value: string): Promise<void> {
  try {
    if (env.CACHE) await env.CACHE.put(key, value, { expirationTtl: CACHE_TTL_SECONDS })
  } catch {
    // Cache writes are best-effort.
  }
}
