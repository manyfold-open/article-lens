import { cacheGet, cachePut } from '../cache'
import { checkMfAgentAccess } from '../crew/mf'
import { jsonResponse } from '../http'
import type { Env } from '../schema'
import { parseFreshHealthSnapshot } from './health-snapshot'

const HEALTH_CACHE_KEY = 'health:latest'

function healthAgents(env: Env): Array<{ name: string; id: string }> {
  return [
    { name: 'Summariser', id: env.AGENT_SUMMARIZER },
    { name: 'Jargon', id: env.AGENT_JARGON },
    { name: 'Comments-map', id: env.AGENT_COMMENT_MAP ?? '' },
    { name: 'Comments-reduce', id: env.AGENT_COMMENT_REDUCE },
    { name: 'Context', id: env.AGENT_CONTEXT },
    { name: 'Synthesiser', id: env.AGENT_SYNTHESIZER },
  ]
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 140)
}

export async function checkAgentHealth(env: Env): Promise<unknown> {
  if (!env.MF_API_TOKEN) {
    return { checkedAt: new Date().toISOString(), up: 0, total: 0, agents: [], note: 'no MF_API_TOKEN' }
  }

  const agents = await Promise.all(healthAgents(env).map(async ({ name, id }) => {
    const startedAt = Date.now()
    try {
      await checkMfAgentAccess(env, id)
      return { name, id, ok: true, ms: Date.now() - startedAt, check: 'peer_access' }
    } catch (error) {
      return { name, id, ok: false, ms: Date.now() - startedAt, check: 'peer_access', error: shortError(error) }
    }
  }))
  const snapshot = {
    checkedAt: new Date().toISOString(),
    up: agents.filter(agent => agent.ok).length,
    total: agents.length,
    agents,
    note: 'Checks Manyfold peer credential access; does not start paid model turns.',
  }
  await cachePut(env, HEALTH_CACHE_KEY, JSON.stringify(snapshot))
  return snapshot
}

export async function handleHealth(url: URL, env: Env): Promise<Response> {
  if (url.searchParams.get('live') === '1') return jsonResponse(await checkAgentHealth(env))
  const snapshot = parseFreshHealthSnapshot(await cacheGet(env, HEALTH_CACHE_KEY))
  if (snapshot) return jsonResponse(snapshot)
  return jsonResponse(await checkAgentHealth(env))
}
