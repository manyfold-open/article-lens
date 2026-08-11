/**
 * A2A client: JSON-RPC 2.0 over HTTPS, streaming over SSE.
 *
 * This module speaks the protocol and nothing else. It has no imports, knows
 * nothing about Env, KV, budgets, tracing, or orchestration policy, and every
 * function takes an AgentCredential. src/connect.ts is where credentials come
 * from; src/crew/mf.ts is where the app's retry, budget and recovery policy
 * lives. Keep it that way — the moment this file imports app state it stops
 * being reviewable as a security boundary.
 *
 * DELIBERATE DIVERGENCE FROM THE UPSTREAM STARTER TEMPLATE:
 * `manyfold-open/cloudflare-worker-starter` throws when a stream breaks.
 * We must not. Once the agent has accepted a Task, re-sending the prompt bills
 * a second turn, so `sendMessageStream` returns `{ data, interrupted }` and
 * hands back whatever accumulated. The caller decides whether to recover the
 * accepted Task through `tasks/get` or to give up. Do not "fix" this back when
 * re-syncing with the starter.
 *
 * The second divergence: `normalizeState` does not whitelist. The starter maps
 * unrecognised states to '' so they cannot overwrite a known state; here an
 * unknown state must stay truthy, because the recovery loop treats an empty
 * state as "task finished, read the result". Whitelisting would turn an
 * unrecognised non-terminal state into a premature success.
 */

const ERROR_TEXT_LIMIT = 1_000
const PROBE_TIMEOUT_MS = 20_000
const CARD_TIMEOUT_MS = 10_000

/** Everything needed to talk to one agent. `label` only ever reaches error text. */
export interface AgentCredential {
  agentId: string
  rpcUrl: string
  token: string
  label: string
  /** Epoch ms, or null when the grant does not expire. */
  expiresAt: number | null
}

export type TaskStateCallback = (state: string, taskId: string, detail?: string) => void

export class A2AError extends Error {
  readonly retryable: boolean
  readonly refreshCredential: boolean
  readonly retryAfterMs?: number

  constructor(
    message: string,
    retryable: boolean,
    refreshCredential = false,
    retryAfterMs?: number,
  ) {
    // Redact in the constructor, not at the call sites: this is what makes
    // "no A2AError can carry a bearer token" a property of the type rather
    // than a habit every future caller has to remember.
    super(safeErrorText(message))
    this.name = 'A2AError'
    this.retryable = retryable
    this.refreshCredential = refreshCredential
    this.retryAfterMs = retryAfterMs
  }
}

/** Strips anything token-shaped before an error string can reach a log or the browser. */
export function safeErrorText(value: unknown): string {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-token]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, ERROR_TEXT_LIMIT)
}

export function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

export function looksTransient(message: string): boolean {
  return /\b(timeout|timed out|temporar|unavailable|overload|rate limit|too many|network|fetch failed|connection|socket|internal error|server error|502|503|504|turn_timeout)\b/i.test(message)
    || /\b(runtime|sandbox)\b.*\b(dead|offline|stopped|not alive|not running)\b/i.test(message)
}

export function retryAfterFrom(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), 15_000)
  return undefined
}

export function normalizeA2AError(error: unknown): A2AError {
  if (error instanceof A2AError) return error
  const message = safeErrorText(error instanceof Error ? error.message : error)
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  const timedOut = name === 'AbortError' || /abort|timeout|timed out/i.test(message)
  return new A2AError(
    timedOut ? `Manyfold A2A request timed out. ${message}` : message || 'Unknown Manyfold A2A failure.',
    timedOut || looksTransient(message) || error instanceof TypeError,
  )
}

/** fetch with a hard timeout so a hung agent call can't stall the whole run. */
export async function fetchTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

/**
 * A URL handed back by Manyfold is still untrusted input.
 *
 * Without this the Worker will POST a bearer token to whatever host the
 * handshake response names, which turns one compromised or spoofed response
 * into credential exfiltration, or into a request against the cloud metadata
 * endpoint from inside the network boundary.
 */
export function validateA2AUrl(raw: string, production: boolean, label: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new A2AError(`${label} is not a valid URL.`, false)
  }
  if (url.username || url.password) {
    throw new A2AError(`${label} must not carry credentials in the URL.`, false)
  }
  if (url.protocol !== 'https:' && !(!production && url.protocol === 'http:')) {
    throw new A2AError(`${label} must use https.`, false)
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const blocked = host === 'localhost'
    || host === '0.0.0.0'
    || host === '::'
    || host === '::1'
    || host.endsWith('.local')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/i.test(host)
    || /^fe[89ab][0-9a-f]:/i.test(host)
  if (blocked && production) throw new A2AError(`${label} points at a private address.`, false)
  url.hash = ''
  return url.toString()
}

/* ───────── JSON-RPC ───────── */

function rpcBody(method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', method, id: crypto.randomUUID(), params })
}

/**
 * One `message/stream` request body.
 *
 * `messageId` is A2A's idempotency key, so callers pass a value derived from
 * something stable rather than a fresh UUID per attempt: a retried send of the
 * same logical message must not be able to bill a second turn.
 */
export function messageStreamBody(prompt: string, messageId: string): string {
  return rpcBody('message/stream', {
    message: {
      kind: 'message',
      role: 'user',
      messageId,
      parts: [{ kind: 'text', text: prompt }],
    },
    // A2A v0.3: one SSE stream carries Task state and artifact updates. This
    // replaces the old one-request-per-second tasks/get loop, which exhausted
    // Free Workers' 50 external-subrequest allowance in about 20 seconds.
    configuration: { acceptedOutputModes: ['text/plain'] },
  })
}

export function rpcFailure(data: Record<string, unknown>, label: string): A2AError | null {
  const err = data.error as { code?: unknown; message?: unknown; data?: unknown } | undefined
  if (!err) return null
  const code = typeof err.code === 'number' ? err.code : undefined
  const message = safeErrorText(err.message ?? err.data ?? JSON.stringify(err))
  // -32700/-32600/-32601/-32602 mean we sent something wrong; retrying sends it again.
  const permanentProtocolError = code === -32700 || code === -32600 || code === -32601 || code === -32602
  return new A2AError(
    `Agent ${label} RPC error${code === undefined ? '' : ` ${code}`}: ${message}`,
    !permanentProtocolError && looksTransient(message),
  )
}

export async function parseRpcResponse(res: Response, label: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const detail = safeErrorText(await res.text())
    throw new A2AError(
      `Agent ${label} failed: HTTP ${res.status}${detail ? ` · ${detail}` : ''}`,
      retryableStatus(res.status) || res.status === 401,
      res.status === 401,
      retryAfterFrom(res),
    )
  }
  let data: Record<string, unknown>
  try {
    data = await res.json() as Record<string, unknown>
  } catch (error) {
    throw new A2AError(`Agent ${label} returned invalid JSON. ${safeErrorText(error)}`, true)
  }
  const rpcError = rpcFailure(data, label)
  if (rpcError) throw rpcError
  return data
}

/* ───────── task shape helpers ───────── */

/**
 * Canonical state string. Accepts the protobuf-style `TASK_STATE_COMPLETED`
 * and the hyphenated wire form alike. Deliberately not whitelisted; see the
 * module header.
 */
export function normalizeState(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^task_state_/, '')
    .replace(/_/g, '-')
}

export function isTerminalTaskState(state: string): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'rejected'
    || state === 'input-required'
    || state === 'auth-required'
}

export function taskState(data: Record<string, unknown>): string {
  const result = data.result as { status?: { state?: unknown } } | undefined
  return normalizeState(result?.status?.state)
}

export function taskId(data: Record<string, unknown>): string | null {
  const result = data.result as { id?: unknown; taskId?: unknown } | undefined
  const value = result?.id ?? result?.taskId
  return typeof value === 'string' && value ? value : null
}

function textParts(parts: Array<Record<string, unknown>> | undefined): string {
  return (parts ?? [])
    .flatMap(part => typeof part.text === 'string' && part.text ? [part.text] : [])
    .join('\n')
}

/** Pull the text out of an A2A task/message result (handles fenced JSON too). */
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
  const statusText = textParts(msg?.parts as Array<Record<string, unknown>> | undefined)
  if (statusText) return statusText
  return JSON.stringify(result)
}

/* ───────── streaming ───────── */

export interface StreamAccumulator {
  taskId: string | null
  state: string
  artifacts: Map<string, string>
  artifactOrder: string[]
  directText: string
  statusText: string
}

export interface StreamOutcome {
  /** Always a `tasks/get`-shaped envelope, whether the stream finished or broke. */
  data: Record<string, unknown>
  /** Set when the stream ended before a terminal state. Not necessarily fatal. */
  interrupted?: A2AError
}

export function createStreamAccumulator(): StreamAccumulator {
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

/** Folds one JSON-RPC `result` (task, message, status-update or artifact-update) in. */
export function applyStreamResult(accumulator: StreamAccumulator, raw: unknown): void {
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
  const state = normalizeState(status?.state ?? value.state)
  if (state) accumulator.state = state
  const statusMessage = status?.message
  if (statusMessage && typeof statusMessage === 'object') {
    accumulator.statusText = streamPartsText(
      (statusMessage as Record<string, unknown>).parts,
    ) || accumulator.statusText
  }
}

/**
 * Re-serialise the accumulator into the same envelope `tasks/get` returns.
 *
 * This is what lets one set of readers (extractAgentText, taskState, taskId)
 * serve both the streaming and the polling path, so recovery after a broken
 * stream needs no special-casing downstream.
 */
export function streamTaskData(accumulator: StreamAccumulator): Record<string, unknown> {
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

/** Test/dev helper: fold a sequence of JSON-RPC results into one task envelope. */
export function foldA2AResults(results: unknown[]): Record<string, unknown> {
  const accumulator = createStreamAccumulator()
  for (const result of results) applyStreamResult(accumulator, result)
  return streamTaskData(accumulator)
}

export async function readTaskStream(
  res: Response,
  label: string,
  onState?: TaskStateCallback,
): Promise<StreamOutcome> {
  if (!res.body) throw new A2AError(`Agent ${label} streaming response had no body.`, true)
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
      throw new A2AError(`Agent ${label} stream emitted invalid JSON. ${safeErrorText(error)}`, true)
    }
    const failure = rpcFailure(envelope, label)
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
    interrupted = normalizeA2AError(error)
  } finally {
    if (isTerminalTaskState(accumulator.state)) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }

  // Nothing arrived at all: no Task was accepted, so the caller is free to
  // retry the whole send without risking a double turn.
  if (!received && interrupted) throw interrupted
  if (!received) throw new A2AError(`Agent ${label} stream ended without A2A events.`, true)
  if (!isTerminalTaskState(accumulator.state) && !interrupted) {
    interrupted = new A2AError(`Agent ${label} stream ended before the Task reached a terminal state.`, true)
  }
  return { data: streamTaskData(accumulator), interrupted }
}

/**
 * One `message/stream` turn.
 *
 * A non-SSE 200 is not an error: some deployments answer a stream request with
 * a plain JSON-RPC task envelope, and that is still a usable answer. Only the
 * caller knows whether the resulting non-terminal task is worth recovering.
 */
export async function sendMessageStream(options: {
  cred: AgentCredential
  body: string
  timeoutMs: number
  onState?: TaskStateCallback
}): Promise<StreamOutcome> {
  const { cred } = options
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), Math.max(1_000, options.timeoutMs))
  try {
    const res = await fetch(cred.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        authorization: `Bearer ${cred.token}`,
      },
      // Never follow a redirect: a 3xx would replay the bearer against a host
      // that was never validated.
      redirect: 'manual',
      body: options.body,
      signal: ctrl.signal,
    })
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!res.ok || !contentType.includes('text/event-stream')) {
      return { data: await parseRpcResponse(res, cred.label) }
    }
    return await readTaskStream(res, cred.label, options.onState)
  } finally {
    clearTimeout(timer)
  }
}

export async function getTask(
  cred: AgentCredential,
  id: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await fetchTimeout(cred.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${cred.token}` },
    redirect: 'manual',
    body: rpcBody('tasks/get', { id }),
  }, timeoutMs)
  return parseRpcResponse(res, cred.label)
}

export async function cancelTask(
  cred: AgentCredential,
  id: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  try {
    const res = await fetchTimeout(cred.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${cred.token}` },
      redirect: 'manual',
      body: rpcBody('tasks/cancel', { id }),
    }, timeoutMs)
    return taskState(await parseRpcResponse(res, cred.label)) === 'canceled'
  } catch {
    return false
  }
}

/**
 * Connectivity probe: ask for a task id that cannot exist.
 *
 * Deliberately not `message/send` or `message/stream` — those run a real turn,
 * so verifying N agents would bill N turns. Only the auth answer matters:
 * 401/403 means the token is rejected, and anything else (including a JSON-RPC
 * "no such task" error) means the token and endpoint work.
 */
export async function probeAgentAuth(cred: AgentCredential): Promise<void> {
  const res = await fetchTimeout(cred.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${cred.token}` },
    redirect: 'manual',
    body: rpcBody('tasks/get', { id: `probe-${crypto.randomUUID()}` }),
  }, PROBE_TIMEOUT_MS)
  if (res.status === 401 || res.status === 403) {
    throw new A2AError(`${cred.label} rejected this token (HTTP ${res.status}).`, false, true)
  }
  if (!res.ok && res.status >= 500) {
    throw new A2AError(`${cred.label} is temporarily unavailable (HTTP ${res.status}).`, true)
  }
}

/** Best-effort agent-card read for a description; cards are public, so no bearer is sent. */
export async function describeFromCard(cardUrl: string): Promise<string> {
  try {
    const res = await fetchTimeout(
      cardUrl,
      { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' },
      CARD_TIMEOUT_MS,
    )
    if (!res.ok) return ''
    const card = await res.json() as Record<string, unknown>
    return typeof card.description === 'string' ? card.description.slice(0, 240) : ''
  } catch {
    return ''
  }
}
