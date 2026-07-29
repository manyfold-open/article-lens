import { parseLoose } from '../crew/json'
import { callMfAgent } from '../crew/mf'
import { mockDefineTerm } from '../crew/mock'
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

  if (!env.MF_API_TOKEN) return jsonResponse(mockDefineTerm(term, context))

  try {
    const prompt = `You are 小词, a bilingual (Chinese/English) jargon explainer for tech and HN readers.

Explain this term in plain language for a smart generalist who codes but isn't in this niche:

Term: "${term}"
${context ? `Seen in context: "${context}"` : ''}

Rules:
- 1-2 sentences per language
- No circular definitions, no jargon in the explanation
- Use a concrete analogy if it helps
- Find the standard Chinese name if one exists, else provide a descriptive label

Respond with ONLY this JSON (no markdown, no commentary; inside string values never use the " character — use ' or 「」 for quotes):
{"term":"${term}","zh_term":"<standard Chinese name or label>","explain":{"en":"<1-2 sentences>","zh":"<1-2 sentences>"}}`

    const text = await callMfAgent(env, env.AGENT_JARGON, prompt)
    const parsed = parseLoose<{ term: string; zh_term: string; explain: { en: string; zh: string } }>(text)
    if (!parsed?.explain?.zh && !parsed?.explain?.en) {
      return jsonResponse(mockDefineTerm(term, context))
    }
    return jsonResponse(parsed)
  } catch {
    return jsonResponse(mockDefineTerm(term, context))
  }
}
