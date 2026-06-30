// ── Manyfold A2A client (Worker-side) ─────────────────────────────
// A stateless Worker can't run the `mf` CLI, so we replicate its flow:
//   1. mint a short-lived per-peer bearer:
//        POST {MF_API_URL}/agent-self/a2a/peers/{peerId}/token   (Bearer = identity token)
//        → { token, rpcUrl, expiresAt }
//   2. call the peer's rpcUrl with that bearer using JSON-RPC message/send.
// Minted tokens are cached per peer (they last ~15 min) so a fan-out of
// comment-map calls reuses one token instead of minting每次.

import type { Env } from '../schema'

interface PeerToken { token: string; rpcUrl: string; exp: number }
const tokenCache = new Map<string, PeerToken>()

async function getPeerToken(env: Env, peerId: string): Promise<PeerToken> {
  const cached = tokenCache.get(peerId)
  if (cached && cached.exp > Date.now() + 30_000) return cached

  const q = env.MF_AGENT_ID ? `?agentId=${encodeURIComponent(env.MF_AGENT_ID)}` : ''
  const res = await fetch(`${env.MF_API_URL}/agent-self/a2a/peers/${encodeURIComponent(peerId)}/token${q}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MF_API_TOKEN}`, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`peer token mint failed: ${res.status} ${await res.text()}`)
  const j = await res.json() as { token: string; rpcUrl: string; expiresAt?: string }
  const exp = j.expiresAt ? new Date(j.expiresAt).getTime() : Date.now() + 10 * 60_000
  const entry: PeerToken = { token: j.token, rpcUrl: j.rpcUrl, exp }
  tokenCache.set(peerId, entry)
  return entry
}

// fetch with a hard timeout so a hung agent call can't stall the whole run.
async function fetchTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// Send one prompt to a Manyfold agent and return its text output.
// Retries once on transient failure (timeout / 5xx / network); on a fresh
// attempt the peer token is re-minted in case it expired.
export async function callMfAgent(
  env: Env,
  peerId: string,
  prompt: string,
  opts: { timeoutMs?: number; attempts?: number } = {}
): Promise<string> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/send',
    id: crypto.randomUUID(),
    params: {
      message: {
        kind: 'message', role: 'user', messageId: crypto.randomUUID(),
        parts: [{ kind: 'text', text: prompt }],
      },
    },
  })

  let lastErr: unknown
  const attempts = Math.max(1, opts.attempts ?? 2)
  const timeoutMs = opts.timeoutMs ?? 75_000
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (attempt > 0) tokenCache.delete(peerId)          // force a fresh mint on retry
      const { token, rpcUrl } = await getPeerToken(env, peerId)
      const res = await fetchTimeout(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body,
      }, timeoutMs)   // some agents (e.g. the synthesizer) legitimately take ~40s+
      // 5xx is worth retrying; 4xx is not (bad request / auth) → fail fast.
      if (!res.ok) {
        const detail = `${res.status} ${await res.text()}`
        if (res.status >= 500 && attempt < attempts - 1) { lastErr = new Error(detail); continue }
        throw new Error(`agent ${peerId} failed: ${detail}`)
      }
      const data = await res.json() as Record<string, unknown>
      const err = data.error as { message?: string } | undefined
      if (err) throw new Error(`agent ${peerId} rpc error: ${err.message ?? JSON.stringify(err)}`)
      // A task can come back HTTP-200 but with state:"failed" (e.g. the agent's
      // runtime 502'd). Treat that as a real failure so callers can degrade /
      // mark the agent "asleep", and retry once.
      const result = data.result as { status?: { state?: string; message?: unknown } } | undefined
      if (result?.status?.state === 'failed') {
        const detail = extractAgentText(data)
        if (attempt < attempts - 1) { lastErr = new Error(detail); continue }
        throw new Error(`agent ${peerId} task failed: ${detail}`)
      }
      return extractAgentText(data)
    } catch (e) {
      lastErr = e
      if (attempt < attempts - 1) continue                 // retry transient timeout/network error
      throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// Pull the text out of an A2A task/message result (handles fenced JSON too).
export function extractAgentText(data: Record<string, unknown>): string {
  const result = data?.result as Record<string, unknown> | undefined
  if (!result) return JSON.stringify(data)
  const parts = result.parts as Array<Record<string, unknown>> | undefined
  if (parts?.[0]?.text) return parts[0].text as string
  const artifacts = result.artifacts as Array<Record<string, unknown>> | undefined
  if (artifacts?.length) {
    const texts = artifacts
      .flatMap(a => (a.parts as Array<Record<string, unknown>> | undefined) ?? [])
      .map(p => p.text as string | undefined)
      .filter((t): t is string => !!t)
    if (texts.length) return texts.join('\n')
  }
  const status = result.status as Record<string, unknown> | undefined
  const msg = status?.message as Record<string, unknown> | undefined
  const mparts = msg?.parts as Array<Record<string, unknown>> | undefined
  if (mparts?.[0]?.text) return mparts[0].text as string
  return JSON.stringify(result)
}
