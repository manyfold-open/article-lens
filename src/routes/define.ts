import { parseLoose } from '../crew/json'
import { callMfAgent } from '../crew/mf'
import { mockDefineTerm } from '../crew/mock'
import { isMockMode } from '../connect'
import { jsonResponse } from '../http'
import type { Env } from '../schema'

export async function handleDefine(request: Request, env: Env): Promise<Response> {
  let term = ''
  let context: string | undefined
  try {
    const body = await request.json() as { term?: string; context?: string }
    term = (body.term ?? '').trim()
    context = body.context
  } catch {
    return jsonResponse({ error: 'invalid body' }, 400)
  }
  if (!term) return jsonResponse({ error: 'term required' }, 400)

  if (isMockMode(env)) return jsonResponse(mockDefineTerm(term, context))

  try {
    const prompt = `You are the Jargon agent, explaining technical terms in plain language for tech and HN readers.

Explain this term in plain language for a smart generalist who codes but isn't in this niche:

Term: '${term}'
${context ? `Seen in context: '${context}'` : ''}

Rules:
- 1-2 sentences, in British English
- No circular definitions, no jargon in the explanation
- Use a concrete analogy if it helps

Respond with ONLY this JSON (no markdown, no commentary; inside string values never use the " character — use ' for quotes):
{"term":"${term}","explain":"<1-2 sentences>"}`

    const text = await callMfAgent(env, env.AGENT_JARGON, prompt)
    const parsed = parseLoose<{ term: string; explain: unknown }>(text)
    const explain = typeof parsed?.explain === 'string'
      ? parsed.explain
      // A peer may still answer with the old {en, zh} shape; take what has text.
      : (parsed?.explain as { en?: string; zh?: string } | undefined)?.en
        || (parsed?.explain as { en?: string; zh?: string } | undefined)?.zh
        || ''
    if (!explain.trim()) return jsonResponse(mockDefineTerm(term, context))
    return jsonResponse({ term: parsed?.term || term, explain })
  } catch {
    return jsonResponse(mockDefineTerm(term, context))
  }
}
