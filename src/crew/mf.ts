// ── Manyfold A2A client (Worker-side) ─────────────────────────────
// A Worker task consumer can't run the `mf` CLI, so we replicate its flow:
//   1. mint a short-lived per-peer bearer:
//        POST {MF_API_URL}/agent-self/a2a/peers/{peerId}/token   (Bearer = identity token)
//        → { token, rpcUrl, expiresAt }
//   2. call the peer's rpcUrl with that bearer using JSON-RPC message/stream.
// Minted tokens are cached per peer (they last ~15 min) so concurrent calls
// reuse one token instead of stampeding the credential endpoint.

import type { AgentName, BiStr, Env, SSEEvent } from '../schema'

interface PeerToken { token: string; rpcUrl: string; exp: number }
const tokenCache = new Map<string, PeerToken>()
const tokenInflight = new Map<string, Promise<PeerToken>>()
const TRACE_TEXT_LIMIT = 8_000
const ERROR_TEXT_LIMIT = 1_000
const DEFAULT_ATTEMPTS = 2
// Manyfold usage data for these hosted peers shows first-token latency
// commonly around 120–200s. A shorter deadline incorrectly kills healthy work.
const DEFAULT_TIMEOUT_MS = 240_000
const MIN_ATTEMPT_BUDGET_MS = 5_000
// A standard run already fans out summary, jargon windows, and comments.
// Keep the per-isolate pressure below both Manyfold's in-flight ceiling and
// Cloudflare's six simultaneous outbound connections per invocation.
const MAX_CONCURRENT_A2A_CALLS = 4
// message/stream normally needs one external subrequest per agent. If a stream
// is interrupted after the Task was accepted, use a small, sparse recovery
// schedule instead of returning to one tasks/get request per second.
const RECOVERY_POLL_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000]
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
  // Shared by every A2A call in one Queue invocation. Article Lens reserves
  // the rest of Free Workers' 50 external subrequests for article resolution
  // and other upstream work.
  requestBudget?: A2ASubrequestBudget
  trace?: TraceContext
}

interface A2ASubrequestBudget {
  remaining: number
}

type TaskStateCallback = (state: string, taskId: string, detail?: string) => void

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

function consumeRequestBudget(budget: A2ASubrequestBudget | undefined, operation: string): void {
  if (!budget) return
  if (budget.remaining <= 0) {
    throw new A2AError(
      `Free Workers A2A subrequest budget exhausted before ${operation}.`,
      false,
    )
  }
  budget.remaining -= 1
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

async function getPeerToken(
  env: Env,
  peerId: string,
  requestBudget?: A2ASubrequestBudget,
): Promise<PeerToken> {
  const key = peerCacheKey(env, peerId)
  const cached = tokenCache.get(key)
  if (cached && cached.exp > Date.now() + 30_000) return cached

  // Concurrent jargon/comment calls often target the same peer. Share the
  // in-progress mint so a cold cache produces one credential request, not N.
  const pending = tokenInflight.get(key)
  if (pending) return pending

  const mint = (async (): Promise<PeerToken> => {
    const q = env.MF_AGENT_ID ? `?agentId=${encodeURIComponent(env.MF_AGENT_ID)}` : ''
    consumeRequestBudget(requestBudget, `minting a credential for ${peerId}`)
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

interface StreamAccumulator {
  taskId: string | null
  state: string
  artifacts: Map<string, string>
  artifactOrder: string[]
  directText: string
  statusText: string
}

interface StreamReadOutcome {
  data: Record<string, unknown>
  interrupted?: A2AError
}

function createStreamAccumulator(): StreamAccumulator {
  return {
    taskId: null,
    state: '',
    artifacts: new Map(),
    artifactOrder: [],
    directText: '',
    statusText: '',
  }
}

function streamPartsText(raw: unknown): string {
  return textParts(Array.isArray(raw) ? raw as Array<Record<string, unknown>> : undefined)
}

function rememberArtifact(
  accumulator: StreamAccumulator,
  artifact: Record<string, unknown>,
  append = false,
): void {
  const artifactId = typeof artifact.artifactId === 'string' && artifact.artifactId
    ? artifact.artifactId
    : typeof artifact.id === 'string' && artifact.id
      ? artifact.id
      : 'artifact'
  const text = streamPartsText(artifact.parts)
  if (!accumulator.artifactOrder.includes(artifactId)) accumulator.artifactOrder.push(artifactId)
  accumulator.artifacts.set(
    artifactId,
    append ? `${accumulator.artifacts.get(artifactId) ?? ''}${text}` : text,
  )
}

function applyStreamResult(accumulator: StreamAccumulator, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const value = raw as Record<string, unknown>
  const kind = String(value.kind ?? '').trim().toLowerCase()
  const id = value.taskId ?? value.id
  if (typeof id === 'string' && id) accumulator.taskId = id

  if (kind === 'artifact-update' || value.artifact) {
    const artifact = value.artifact
    if (artifact && typeof artifact === 'object') {
      rememberArtifact(accumulator, artifact as Record<string, unknown>, value.append === true)
    }
  }
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts as Array<Record<string, unknown>>
    : []
  for (const artifact of artifacts) rememberArtifact(accumulator, artifact)

  if (kind === 'message' || (value.role && value.parts)) {
    accumulator.directText = streamPartsText(value.parts) || accumulator.directText
  }

  const status = value.status && typeof value.status === 'object'
    ? value.status as Record<string, unknown>
    : undefined
  const state = String(status?.state ?? value.state ?? '').trim().toLowerCase()
  if (state) accumulator.state = state
  const statusMessage = status?.message
  if (statusMessage && typeof statusMessage === 'object') {
    accumulator.statusText = streamPartsText(
      (statusMessage as Record<string, unknown>).parts,
    ) || accumulator.statusText
  }
}

function streamTaskData(accumulator: StreamAccumulator): Record<string, unknown> {
  const artifacts = accumulator.artifactOrder
    .map((id) => ({
      artifactId: id,
      parts: [{ kind: 'text', text: accumulator.artifacts.get(id) ?? '' }],
    }))
    .filter(artifact => artifact.parts[0].text)
  const result: Record<string, unknown> = {
    kind: 'task',
    status: {
      state: accumulator.state,
      ...(accumulator.statusText
        ? {
            message: {
              kind: 'message',
              role: 'agent',
              parts: [{ kind: 'text', text: accumulator.statusText }],
            },
          }
        : {}),
    },
    ...(accumulator.taskId ? { id: accumulator.taskId } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(!artifacts.length && accumulator.directText
      ? { parts: [{ kind: 'text', text: accumulator.directText }] }
      : {}),
  }
  return { jsonrpc: '2.0', result }
}

function isTerminalTaskState(state: string): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'rejected'
    || state === 'input-required'
    || state === 'auth-required'
}

async function readTaskStream(
  res: Response,
  peerId: string,
  onState?: TaskStateCallback,
): Promise<StreamReadOutcome> {
  if (!res.body) throw new A2AError(`Agent ${peerId} streaming response had no body.`, true)
  const accumulator = createStreamAccumulator()
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let received = false
  let previousState = ''
  let interrupted: A2AError | undefined

  const applyBlock = (block: string): void => {
    const payload = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!payload || payload === '[DONE]') return
    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(payload) as Record<string, unknown>
    } catch (error) {
      throw new A2AError(`Agent ${peerId} stream emitted invalid JSON. ${safeErrorText(error)}`, true)
    }
    const failure = rpcFailure(envelope, peerId)
    if (failure) throw failure
    applyStreamResult(accumulator, envelope.result)
    received = true
    if (accumulator.taskId && accumulator.state && accumulator.state !== previousState) {
      previousState = accumulator.state
      onState?.(accumulator.state, accumulator.taskId)
    }
  }

  try {
    while (!isTerminalTaskState(accumulator.state)) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.match(/\r?\n\r?\n/)
      while (boundary?.index !== undefined) {
        applyBlock(buffer.slice(0, boundary.index))
        buffer = buffer.slice(boundary.index + boundary[0].length)
        if (isTerminalTaskState(accumulator.state)) break
        boundary = buffer.match(/\r?\n\r?\n/)
      }
    }
    buffer += decoder.decode()
    if (!isTerminalTaskState(accumulator.state) && buffer.trim()) applyBlock(buffer)
  } catch (error) {
    interrupted = normalizeCallError(error)
  } finally {
    if (isTerminalTaskState(accumulator.state)) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }

  if (!received && interrupted) throw interrupted
  if (!received) {
    throw new A2AError(`Agent ${peerId} stream ended without A2A events.`, true)
  }
  if (!isTerminalTaskState(accumulator.state) && !interrupted) {
    interrupted = new A2AError(`Agent ${peerId} stream ended before the Task reached a terminal state.`, true)
  }
  return { data: streamTaskData(accumulator), interrupted }
}

async function pollTask(
  env: Env,
  credential: PeerToken,
  peerId: string,
  id: string,
  deadline: number,
  onState?: TaskStateCallback,
  initialState = '',
  requestBudget?: A2ASubrequestBudget,
): Promise<Record<string, unknown>> {
  let previousState = initialState
  for (const delay of RECOVERY_POLL_DELAYS_MS) {
    if (Date.now() >= deadline) break
    if (delay > 0) {
      await new Promise(resolve => setTimeout(
        resolve,
        Math.min(delay, Math.max(0, deadline - Date.now())),
      ))
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    let data: Record<string, unknown>
    try {
      consumeRequestBudget(requestBudget, `recovering accepted task ${id}`)
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
    } catch (error) {
      const failure = normalizeCallError(error)
      if (!failure.retryable) throw failure
      if (failure.refreshCredential) {
        forgetPeerToken(env, peerId)
        try {
          credential = await getPeerToken(env, peerId, requestBudget)
        } catch {
          // Keep polling the same Task. A later iteration can refresh again;
          // escaping here would resubmit an already-accepted message.
        }
      }
      onState?.('poll-retrying', id, failure.message)
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
  const canceled = await cancelTask(
    credential.rpcUrl,
    credential.token,
    peerId,
    id,
    requestBudget,
  )
  onState?.(canceled ? 'canceled-after-timeout' : 'timed-out', id)
  throw new A2AError(
    `Agent ${peerId} task ${id} did not complete within the bounded stream-recovery budget${canceled ? ' and was cancelled' : ''}.`,
    false,
  )
}

async function cancelTask(
  rpcUrl: string,
  token: string,
  peerId: string,
  id: string,
  requestBudget?: A2ASubrequestBudget,
): Promise<boolean> {
  try {
    consumeRequestBudget(requestBudget, `canceling task ${id}`)
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
  onTaskState?: TaskStateCallback,
  requestBudget?: A2ASubrequestBudget,
): Promise<string> {
  return withCallPermit(async () => {
    const deadline = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + timeoutMs)
    const credential = await getPeerToken(env, peerId, requestBudget)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new A2AError(`Agent ${peerId} exhausted the orchestration time budget before submission.`, true)
    }
    consumeRequestBudget(requestBudget, `opening a stream to ${peerId}`)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, remaining))
    let data: Record<string, unknown>
    let interruption: A2AError | undefined
    try {
      const res = await fetch(credential.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          authorization: `Bearer ${credential.token}`,
        },
        body,
        signal: ctrl.signal,
      })
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!res.ok || !contentType.includes('text/event-stream')) {
        data = await parseRpcResponse(res, peerId)
      } else {
        const outcome = await readTaskStream(res, peerId, onTaskState)
        data = outcome.data
        interruption = outcome.interrupted
      }
    } finally {
      clearTimeout(timer)
    }

    let state = taskState(data)
    const id = taskId(data)
    if (interruption && id) {
      onTaskState?.('stream-recovering', id, interruption.message)
    } else if (interruption) {
      throw interruption
    }
    if ((state === 'submitted' || state === 'working') && !id) {
      throw new A2AError(`Agent ${peerId} returned state "${state}" without a task id.`, true)
    }
    if (id && (state === 'submitted' || state === 'working' || !state)) {
      if (!interruption && state) onTaskState?.(state, id)
      data = await pollTask(
        env,
        credential,
        peerId,
        id,
        deadline,
        onTaskState,
        state,
        requestBudget,
      )
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
    bi('送往 Manyfold A2A 的实际输入', 'Actual input sent through Manyfold A2A'),
    prompt,
  )
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/stream',
    id: crypto.randomUUID(),
    params: {
      message: {
        kind: 'message', role: 'user', messageId: crypto.randomUUID(),
        parts: [{ kind: 'text', text: prompt }],
      },
      // A2A v0.3: one SSE stream carries Task state and artifact updates. This
      // replaces the old one-request-per-second tasks/get loop, which exhausted
      // Free Workers' 50 external-subrequest allowance in about 20 seconds.
      configuration: { acceptedOutputModes: ['text/plain'] },
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
        bi('编排时间预算已用完', 'Orchestration time budget exhausted'),
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
          ? bi(`第 ${attempt + 1} 次尝试：重新连线`, `Attempt ${attempt + 1}: reconnecting`)
          : bi('取得短效 A2A 凭证', 'Minting a short-lived A2A credential'),
        undefined,
        attempt + 1,
      )
      emitTrace(
        opts.trace,
        callId,
        'progress',
        bi('已开启串流，等待 Agent 回复', 'Stream opened; waiting for the agent'),
        undefined,
        attempt + 1,
      )
      const output = await executeAttempt(
        env,
        peerId,
        body,
        Math.min(timeoutMs, remainingBudget),
        opts.deadlineAt,
        (state, id, detail) => {
          const label = state === 'completed'
            ? bi('Agent 任务已完成', 'Agent task completed')
            : state === 'stream-recovering'
              ? bi('串流中断，恢复已接受的任务', 'Stream disconnected; recovering the accepted task')
              : state === 'poll-retrying'
                ? bi('已接受任务的恢复请求重试中', 'Accepted-task recovery request is retrying')
                : bi(`Agent 任务状态：${state}`, `Agent task state: ${state}`)
          emitTrace(
            opts.trace,
            callId,
            'progress',
            label,
            `task_id=${id}${detail ? ` · ${safeErrorText(detail)}` : ''}`,
            attempt + 1,
          )
        },
        opts.requestBudget,
      )
      emitTrace(
        opts.trace,
        callId,
        'output',
        bi('Agent 原始输出', 'Raw agent output'),
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
          ? bi(`第 ${attempt + 1} 次尝试失败，将重试`, `Attempt ${attempt + 1} failed; retrying`)
          : bi('Agent 调用失败', 'Agent call failed'),
        error.message,
        attempt + 1,
        willRetry,
      )
      if (!willRetry) throw error
      emitTrace(
        opts.trace,
        callId,
        'progress',
        bi(`等待 ${Math.ceil(waitMs / 100) / 10} 秒后重试`, `Retrying in ${Math.ceil(waitMs / 100) / 10}s`),
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
