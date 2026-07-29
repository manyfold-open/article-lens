import { cacheGet, cachePut } from '../cache'
import { parseLoose } from '../crew/json'
import { callMfAgent } from '../crew/mf'
import { hashString } from '../hash'
import { jsonResponse } from '../http'
import type { Env } from '../schema'

// Agents generate Chinese only. English is generated lazily and cached per
// string when the client switches to English or bilingual mode.
export async function handleTranslate(request: Request, env: Env): Promise<Response> {
  let chinese: string[] = []
  try {
    const body = await request.json() as { zh?: string[] }
    chinese = (body.zh ?? []).filter(value => typeof value === 'string').slice(0, 80)
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400)
  }
  if (!chinese.length) return jsonResponse({ en: [] })

  const keyFor = (value: string) => `tr:${hashString(value)}:v${env.SPEC_VERSION}`
  const cached = await Promise.all(chinese.map(value => cacheGet(env, keyFor(value))))
  const english = chinese.map((value, index) => cached[index] ?? value)
  const missingIndexes = chinese.map((_, index) => index).filter(index => cached[index] == null)

  if (!missingIndexes.length || !env.MF_API_TOKEN) return jsonResponse({ en: english })

  try {
    const missing = missingIndexes.map(index => chinese[index])
    const numbered = missing.map((value, index) => `${index}: ${value}`).join('\n')
    const prompt = `Translate each numbered Chinese line into natural, concise British English (use British spelling: analyse, summarise, organise, colour, licence as a noun). Keep technical terms. Return ONLY a JSON array of strings in the SAME order and length (no markdown; inside string values never use the " character — use ' instead):
${numbered}

Format: ["english 0","english 1", ...]`
    const text = await callMfAgent(env, env.AGENT_SUMMARIZER, prompt)
    const parsed = parseLoose<string[]>(text)
    if (Array.isArray(parsed) && parsed.length === missing.length) {
      const writes: Promise<void>[] = []
      missingIndexes.forEach((originalIndex, missingIndex) => {
        const candidate = parsed[missingIndex]
        const translated = typeof candidate === 'string' ? candidate.trim() : ''
        // A missing or echoed line is not a translation. Caching the Chinese
        // under its own key used to serve it as English for seven days, so an
        // English session had no way to recover. Leave the key unwritten and
        // let the next request try again.
        if (!translated || translated === chinese[originalIndex]) return
        english[originalIndex] = translated
        writes.push(cachePut(env, keyFor(chinese[originalIndex]), translated))
      })
      await Promise.all(writes)
    }
  } catch {
    // Keep the original Chinese value for misses when translation is unavailable.
  }
  return jsonResponse({ en: english })
}
