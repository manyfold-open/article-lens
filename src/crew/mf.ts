// ── Manyfold A2A client (Worker-side) ─────────────────────────────
// A Worker task consumer can't run the `mf` CLI, so we replicate its flow:
//   1. mint a short-lived per-peer bearer:
//        POST {MF_API_URL}/agent-self/a2a/peers/{peerId}/token   (Bearer = identity token)
//        → { token, rpcUrl, expiresAt }
//   2. call the peer's rpcUrl with that bearer using JSON-RPC message/send.
// Minted tokens are cached per peer (they last ~15 min) so concurrent calls
// reuse one token instead of stampeding the credential endpoint.

import type { AgentName, BiStr, Env, SSEEvent } from '../schema'

interface PeerToken { token: string; rpcUrl: string; exp: number }
const tokenCache = new Map<string, PeerToken>()
const tokenInflight = new Map<string, Promise<PeerToken>>()
const TRACE_TEXT_LIMIT = 8_000
const ERROR_TEXT_LIMIT = 1_000
const DEFAULT_ATTEMPTS = 2
// Manyfold usage data for these Gemini CLI peers shows first-token latency
// commonly around 120–200s. A shorter deadline incorrectly kills healthy work.
const DEFAULT_TIMEOUT_MS = 240_000
const MIN_ATTEMPT_BUDGET_MS = 5_000
const TASK_POLL_INTERVAL_MS = 1_000
// A standard run already fans out summary, jargon windows, and comments.
// Keep the per-isolate pressure below the Manyfold in-flight ceiling;
// queued calls retain their own timeout budget because it starts after permit.
const MAX_CONCURRENT_A2A_CALLS = 4
let activeA2ACalls = 0
const callWaiters: Array<() => void> = []

interface TraceContext {
  agent: AgentName
  emit: (event: SSEEvent) => void
}

interface CallOptions {
  timeoutMs?: number
  attempts?: number
  // Absolute budget shared by every call in one orchestration. This keeps a
  // queue consumer below Cloudflare's wall-clock limit even when several
  // agents are slow in sequence.
  deadlineAt?: number
  trace?: TraceContext
}

const bi = (zh: string, en: string): BiStr => ({ zh, en })

class A2AError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly refreshCredential = false,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'A2AError'
  }
}

function clippedContent(content: string): Pick<Extract<SSEEvent, { event: 'agent_trace' }>, 'content' | 'truncated' | 'original_chars'> {
  if (content.length <= TRACE_TEXT_LIMIT) return { content }
  const head = content.slice(0, TRACE_TEXT_LIMIT - 900)
  const tail = content.slice(-800)
  return {
    content: `${head}\n\n… [truncated] …\n\n${tail}`,
    truncated: true,
    original_chars: content.length,
  }
}

function emitTrace(
  trace: TraceContext | undefined,
  callId: string,
  phase: Extract<SSEEvent, { event: 'agent_trace' }>['phase'],
  label: BiStr,
  content?: string,
  attempt?: number,
  willRetry?: boolean,
): void {
  if (!trace) return
  trace.emit({
    event: 'agent_trace',
    agent: trace.agent,
    call_id: callId,
    phase,
    label,
    at: new Date().toISOString(),
    attempt,
    ...(willRetry === undefined ? {} : { will_retry: willRetry }),
    ...(content === undefined ? {} : clippedContent(content)),
  })
}

function peerCacheKey(env: Env, peerId: string): string {
  return `${env.MF_AGENT_ID || 'self'}:${peerId}`
}

function forgetPeerToken(env: Env, peerId: string): void {
  tokenCache.delete(peerCacheKey(env, peerId))
}

function safeErrorText(value: unknown): string {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .slice(0, ERROR_TEXT_LIMIT)
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 15_000)
  return undefined
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function looksTransient(message: string): boolean {
  return /\b(timeout|timed out|temporar|unavailable|overload|rate limit|too many|network|fetch failed|connection|socket|internal error|server error|502|503|504|turn_timeout)\b/i.test(message)
    || /\b(runtime|sandbox)\b.*\b(dead|offline|stopped|not alive|not running)\b/i.test(message)
}

function normalizeCallError(error: unknown): A2AError {
  if (error instanceof A2AError) return error
  const message = safeErrorText(error instanceof Error ? error.message : error)
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  const timedOut = name === 'AbortError' || /abort|timeout|timed out/i.test(message)
  return new A2AError(
    timedOut ? `Manyfold A2A request timed out. ${message}` : message || 'Unknown Manyfold A2A failure.',
    timedOut || looksTransient(message) || error instanceof TypeError,
  )
}

async function acquireCallPermit(): Promise<void> {
  if (activeA2ACalls < MAX_CONCURRENT_A2A_CALLS) {
    activeA2ACalls += 1
    return
  }
  await new Promise<void>(resolve => callWaiters.push(resolve))
  activeA2ACalls += 1
}

function releaseCallPermit(): void {
  activeA2ACalls = Math.max(0, activeA2ACalls - 1)
  callWaiters.shift()?.()
}

async function withCallPermit<T>(fn: () => Promise<T>): Promise<T> {
  await acquireCallPermit()
  try {
    return await fn()
  } finally {
    releaseCallPermit()
  }
}

async function getPeerToken(env: Env, peerId: string): Promise<PeerToken> {
  const key = peerCacheKey(env, peerId)
  const cached = tokenCache.get(key)
  if (cached && cached.exp > Date.now() + 30_000) return cached

  // Concurrent jargon/comment calls often target the same peer. Share the
  // in-progress mint so a cold cache produces one credential request, not N.
  const pending = tokenInflight.get(key)
  if (pending) return pending

  const mint = (async (): Promise<PeerToken> => {
    const q = env.MF_AGENT_ID ? `?agentId=${encodeURIComponent(env.MF_AGENT_ID)}` : ''
    const res = await fetchTimeout(`${env.MF_API_URL}/agent-self/a2a/peers/${encodeURIComponent(peerId)}/token${q}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.MF_API_TOKEN}`, accept: 'application/json' },
    }, 15_000)
    if (!res.ok) {
      const detail = safeErrorText(await res.text())
      throw new A2AError(
        `Peer credential mint failed: HTTP ${res.status}${detail ? ` · ${detail}` : ''}`,
        retryableStatus(res.status),
        false,
        retryAfterMs(res),
      )
    }
    let j: { token?: string; rpcUrl?: string; expiresAt?: string }
    try {
      j = await res.json() as typeof j
    } catch (error) {
      throw new A2AError(`Peer credential response was not valid JSON. ${safeErrorText(error)}`, true)
    }
    if (!j.token || !j.rpcUrl) throw new A2AError('Peer credential response omitted token or rpcUrl.', true)
    const parsedExpiry = j.expiresAt ? new Date(j.expiresAt).getTime() : Number.NaN
    const exp = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 10 * 60_000
    const entry: PeerToken = { token: j.token, rpcUrl: j.rpcUrl, exp }
    tokenCache.set(key, entry)
    return entry
  })()
  tokenInflight.set(key, mint)
  try {
    return await mint
  } finally {
    if (tokenInflight.get(key) === mint) tokenInflight.delete(key)
  }
}

// Health checks validate that the source identity can mint a credential for a
// peer. They intentionally do not start a model turn: hosted first-token
// latency is measured in minutes, and scheduled "OK" prompts created expensive
// work that was routinely canceled before producing a useful health signal.
export async function checkMfPeerAccess(env: Env, peerId: string): Promise<void> {
  await getPeerToken(env, peerId)
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

function taskState(data: Record<string, unknown>): string {
  const result = data.result as { status?: { state?: unknown } } | undefined
  return String(result?.status?.state ?? '').trim().toLowerCase()
}

function taskId(data: Record<string, unknown>): string | null {
  const result = data.result as { id?: unknown; taskId?: unknown } | undefined
  const value = result?.id ?? result?.taskId
  return typeof value === 'string' && value ? value : null
}

function rpcFailure(data: Record<string, unknown>, peerId: string): A2AError | null {
  const err = data.error as { code?: unknown; message?: unknown; data?: unknown } | undefined
  if (!err) return null
  const code = typeof err.code === 'number' ? err.code : undefined
  const message = safeErrorText(err.message ?? err.data ?? JSON.stringify(err))
  const permanentProtocolError = code === -32700 || code === -32600 || code === -32601 || code === -32602
  return new A2AError(
    `Agent ${peerId} RPC error${code === undefined ? '' : ` ${code}`}: ${message}`,
    !permanentProtocolError && looksTransient(message),
  )
}

async function parseRpcResponse(res: Response, peerId: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const detail = safeErrorText(await res.text())
    throw new A2AError(
      `Agent ${peerId} failed: HTTP ${res.status}${detail ? ` · ${detail}` : ''}`,
      retryableStatus(res.status) || res.status === 401,
      res.status === 401,
      retryAfterMs(res),
    )
  }
  let data: Record<string, unknown>
  try {
    data = await res.json() as Record<string, unknown>
  } catch (error) {
    throw new A2AError(`Agent ${peerId} returned invalid JSON. ${safeErrorText(error)}`, true)
  }
  const rpcError = rpcFailure(data, peerId)
  if (rpcError) throw rpcError
  return data
}

async function pollTask(
  env: Env,
  credential: PeerToken,
  peerId: string,
  id: string,
  deadline: number,
  onState?: (state: string, taskId: string) => void,
  initialState = '',
): Promise<Record<string, unknown>> {
  let previousState = initialState
  let pollFailures = 0
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, TASK_POLL_INTERVAL_MS))
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    let data: Record<string, unknown>
    try {
      const res = await fetchTimeout(credential.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${credential.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tasks/get',
          id: crypto.randomUUID(),
          params: { id },
        }),
      }, Math.max(1_000, Math.min(remaining, 15_000)))
      data = await parseRpcResponse(res, peerId)
      pollFailures = 0
    } catch (error) {
      const failure = normalizeCallError(error)
      if (!failure.retryable) throw failure
      pollFailures += 1
      if (failure.refreshCredential) {
        forgetPeerToken(env, peerId)
        try {
          credential = await getPeerToken(env, peerId)
        } catch {
          // Keep polling the same Task. A later iteration can refresh again;
          // escaping here would resubmit an already-accepted message.
        }
      }
      onState?.('poll-retrying', id)
      const waitMs = Math.min(retryDelay(failure, pollFailures), Math.max(0, deadline - Date.now()))
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
      continue
    }
    const state = taskState(data)
    if (state && state !== previousState) {
      previousState = state
      onState?.(state, id)
    }
    if (!state || state === 'completed') return data
    if (state === 'failed' || state === 'canceled' || state === 'rejected') {
      const detail = safeErrorText(extractAgentText(data))
      throw new A2AError(`Agent ${peerId} task ${state}: ${detail}`, state === 'failed' && looksTransient(detail))
    }
    if (state === 'input-required' || state === 'auth-required') {
      throw new A2AError(`Agent ${peerId} task stopped in state "${state}".`, false)
    }
  }
  const canceled = await cancelTask(credential.rpcUrl, credential.token, peerId, id)
  onState?.(canceled ? 'canceled-after-timeout' : 'timed-out', id)
  // Do not immediately submit a second copy of an accepted task. Critical
  // roles can still trigger the workflow-owned retry; non-critical roles
  // degrade explicitly.
  throw new A2AError(
    `Agent ${peerId} task ${id} did not complete within its wait budget${canceled ? ' and was canceled' : ''}.`,
    false,
  )
}

async function cancelTask(
  rpcUrl: string,
  token: string,
  peerId: string,
  id: string,
): Promise<boolean> {
  try {
    const res = await fetchTimeout(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/cancel',
        id: crypto.randomUUID(),
        params: { id },
      }),
    }, 10_000)
    const data = await parseRpcResponse(res, peerId)
    return taskState(data) === 'canceled'
  } catch {
    return false
  }
}

async function executeAttempt(
  env: Env,
  peerId: string,
  body: string,
  timeoutMs: number,
  deadlineAt?: number,
  onTaskState?: (state: string, taskId: string) => void,
): Promise<string> {
  return withCallPermit(async () => {
    const deadline = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + timeoutMs)
    const credential = await getPeerToken(env, peerId)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new A2AError(`Agent ${peerId} exhausted the orchestration time budget before submission.`, true)
    }
    const res = await fetchTimeout(credential.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${credential.token}` },
      body,
    }, Math.max(1_000, remaining))
    let data = await parseRpcResponse(res, peerId)
    let state = taskState(data)
    if (state === 'submitted' || state === 'working') {
      const id = taskId(data)
      if (!id) throw new A2AError(`Agent ${peerId} returned state "${state}" without a task id.`, true)
      onTaskState?.(state, id)
      data = await pollTask(env, credential, peerId, id, deadline, onTaskState, state)
      state = taskState(data)
    }
    if (state === 'failed' || state === 'canceled' || state === 'rejected') {
      const detail = safeErrorText(extractAgentText(data))
      throw new A2AError(`Agent ${peerId} task ${state}: ${detail}`, state === 'failed' && looksTransient(detail))
    }
    if (state === 'input-required' || state === 'auth-required') {
      throw new A2AError(`Agent ${peerId} task stopped in state "${state}".`, false)
    }
    const output = extractAgentText(data).trim()
    if (!output) throw new A2AError(`Agent ${peerId} completed without text output.`, true)
    return output
  })
}

function retryDelay(error: A2AError, attempt: number): number {
  if (error.retryAfterMs !== undefined) return error.retryAfterMs
  const exponential = Math.min(4_000, 450 * (2 ** Math.max(0, attempt - 1)))
  return exponential + Math.floor(Math.random() * 250)
}

// Send one prompt to a Manyfold agent and return its text output. The deployed
// queue/Durable Object workflow retries an escaped orchestration failure. Most
// worker functions intentionally degrade per-agent, so transport retries must
// happen here before those fallback paths run.
export async function callMfAgent(
  env: Env,
  peerId: string,
  prompt: string,
  opts: CallOptions = {}
): Promise<string> {
  const callId = crypto.randomUUID()
  emitTrace(
    opts.trace,
    callId,
    'input',
    bi('送往 Manyfold A2A 的實際輸入', 'Actual input sent through Manyfold A2A'),
    prompt,
  )
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/send',
    id: crypto.randomUUID(),
    params: {
      message: {
        kind: 'message', role: 'user', messageId: crypto.randomUUID(),
        parts: [{ kind: 'text', text: prompt }],
      },
      // A2A v0.3: return the Task immediately and monitor it with tasks/get.
      // Holding message/send open for the full agent run caused healthy, slow
      // peers to look like transport timeouts and tied up outbound connections.
      configuration: { blocking: false },
    },
  })

  let lastErr: A2AError | undefined
  const attempts = Math.min(3, Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS))
  const timeoutMs = Math.max(5_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remainingBudget = (opts.deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now()
    if (remainingBudget < MIN_ATTEMPT_BUDGET_MS) {
      lastErr = new A2AError(`Agent ${peerId} was stopped because the orchestration time budget was exhausted.`, true)
      emitTrace(
        opts.trace,
        callId,
        'error',
        bi('編排時間預算已用完', 'Orchestration time budget exhausted'),
        lastErr.message,
        attempt + 1,
        false,
      )
      break
    }
    try {
      emitTrace(
        opts.trace,
        callId,
        'progress',
        attempt > 0
          ? bi(`第 ${attempt + 1} 次嘗試：重新連線`, `Attempt ${attempt + 1}: reconnecting`)
          : bi('取得短效 A2A 憑證', 'Minting a short-lived A2A credential'),
        undefined,
        attempt + 1,
      )
      emitTrace(
        opts.trace,
        callId,
        'progress',
        bi('已送出請求，等待 Agent 回覆', 'Request sent; waiting for the agent'),
        undefined,
        attempt + 1,
      )
      const output = await executeAttempt(
        env,
        peerId,
        body,
        Math.min(timeoutMs, remainingBudget),
        opts.deadlineAt,
        (state, id) => {
          emitTrace(
            opts.trace,
            callId,
            'progress',
            state === 'completed'
              ? bi('Agent 任務已完成', 'Agent task completed')
              : bi(`Agent 任務狀態：${state}`, `Agent task state: ${state}`),
            `task_id=${id}`,
            attempt + 1,
          )
        },
      )
      emitTrace(
        opts.trace,
        callId,
        'output',
        bi('Agent 原始輸出', 'Raw agent output'),
        output,
        attempt + 1,
      )
      return output
    } catch (e) {
      const error = normalizeCallError(e)
      lastErr = error
      if (error.refreshCredential) forgetPeerToken(env, peerId)
      const waitMs = retryDelay(error, attempt + 1)
      const budgetAfterWait = (opts.deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now() - waitMs
      const willRetry = error.retryable
        && attempt < attempts - 1
        && budgetAfterWait >= MIN_ATTEMPT_BUDGET_MS
      emitTrace(
        opts.trace,
        callId,
        'error',
        willRetry
          ? bi(`第 ${attempt + 1} 次嘗試失敗，將重試`, `Attempt ${attempt + 1} failed; retrying`)
          : bi('Agent 呼叫失敗', 'Agent call failed'),
        error.message,
        attempt + 1,
        willRetry,
      )
      if (!willRetry) throw error
      emitTrace(
        opts.trace,
        callId,
        'progress',
        bi(`等待 ${Math.ceil(waitMs / 100) / 10} 秒後重試`, `Retrying in ${Math.ceil(waitMs / 100) / 10}s`),
        undefined,
        attempt + 1,
      )
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }
  }
  throw lastErr ?? new A2AError('Manyfold A2A call failed without an error.', false)
}

// Pull the text out of an A2A task/message result (handles fenced JSON too).
export function extractAgentText(data: Record<string, unknown>): string {
  const result = data?.result as Record<string, unknown> | undefined
  if (!result) return JSON.stringify(data)
  const parts = result.parts as Array<Record<string, unknown>> | undefined
  const directText = textParts(parts)
  if (directText) return directText
  const artifacts = result.artifacts as Array<Record<string, unknown>> | undefined
  if (artifacts?.length) {
    const texts = artifacts
      .flatMap(a => (a.parts as Array<Record<string, unknown>> | undefined) ?? [])
      .flatMap(part => typeof part.text === 'string' && part.text ? [part.text] : [])
    if (texts.length) return texts.join('\n')
  }
  const status = result.status as Record<string, unknown> | undefined
  const msg = status?.message as Record<string, unknown> | undefined
  const mparts = msg?.parts as Array<Record<string, unknown>> | undefined
  const statusText = textParts(mparts)
  if (statusText) return statusText
  return JSON.stringify(result)
}

function textParts(parts: Array<Record<string, unknown>> | undefined): string {
  return (parts ?? [])
    .flatMap(part => typeof part.text === 'string' && part.text ? [part.text] : [])
    .join('\n')
}
