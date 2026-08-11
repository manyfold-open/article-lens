// ── Manyfold agent adapter (Worker-side) ──────────────────────────
// Everything above this line in the call stack thinks in terms of "send this
// prompt to this agent and give me the text back". Everything below it is
// src/a2a.ts, which only speaks the protocol.
//
// What lives here is the policy the protocol layer must not know about:
// the retry loop, the orchestration time budget, the Free Workers subrequest
// budget, the agent_trace events the UI renders, the concurrency permits, and
// the decision to recover an accepted Task instead of resubmitting a prompt.
//
// Credentials come from src/connect.ts via env.A2A, resolved once per request
// or queue invocation. There is no credential minting any more: an agent's
// bearer is issued once when the operator connects it, so a rejected token is
// a reconnect, not a refresh.

import {
  A2AError,
  cancelTask,
  extractAgentText,
  getTask,
  looksTransient,
  messageStreamBody,
  normalizeA2AError,
  probeAgentAuth,
  safeErrorText,
  sendMessageStream,
  taskId,
  taskState,
  type AgentCredential,
  type TaskStateCallback,
} from '../a2a.ts'
import { markCredentialRejected } from '../connect.ts'
import type { AgentName, Env, SSEEvent } from '../schema.ts'

export { extractAgentText } from '../a2a.ts'

const TRACE_TEXT_LIMIT = 8_000
const DEFAULT_ATTEMPTS = 2
// Manyfold usage data for these hosted agents shows first-token latency
// commonly around 120–200s. A shorter deadline incorrectly kills healthy work.
const DEFAULT_TIMEOUT_MS = 240_000
const MIN_ATTEMPT_BUDGET_MS = 5_000
// A standard run already fans out summary, jargon windows, and comments.
// Keep the per-isolate pressure below both Manyfold's in-flight ceiling and
// Cloudflare's six simultaneous outbound connections per invocation.
const MAX_CONCURRENT_A2A_CALLS = 4
// Under the connect model every role can legitimately resolve to the SAME
// agent, which the peer-mint model made impossible. Four concurrent streams
// against one agent is a different load profile from four against four, and
// nothing in the Manyfold docs says whether an agent serves A2A tasks in
// parallel or serialises them. Provisional until measured with
// scripts/probe-agent-concurrency.mjs; that script bills real turns, so it is
// run by hand against staging, never in CI.
const MAX_CONCURRENT_PER_AGENT = 2
// message/stream normally needs one external subrequest per agent. If a stream
// is interrupted after the Task was accepted, recover with a backoff instead of
// returning to one tasks/get request per second.
//
// The schedule is bounded by the DEADLINE, not by a request count. An earlier
// version used a fixed seven-delay list, which covered only ~137s after a break
// however much budget was left: a stream that died 30s into a 240s turn was
// cancelled at 167s while the agent was still working. Backing off to a 30s
// beat keeps the subrequest cost low (a 240s budget spends at most ~10 requests
// against the old loop's 240) without ever giving up early.
const RECOVERY_FIRST_DELAY_MS = 2_000
const RECOVERY_MAX_DELAY_MS = 30_000
// Backstop so a pathological deadline cannot exhaust the shared subrequest
// budget on recovery alone.
const RECOVERY_MAX_REQUESTS = 16

/** The delay before recovery request `attempt`. Exported so its shape is testable. */
export function recoveryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0
  return Math.min(RECOVERY_MAX_DELAY_MS, RECOVERY_FIRST_DELAY_MS * (2 ** (attempt - 1)))
}

/** Total wall time recovery can cover after a stream breaks. */
export function recoveryCoverageMs(): number {
  let total = 0
  for (let attempt = 0; attempt < RECOVERY_MAX_REQUESTS; attempt++) total += recoveryDelayMs(attempt)
  return total
}

interface TraceContext {
  agent: AgentName
  emit: (event: SSEEvent) => void
}

interface A2ASubrequestBudget {
  remaining: number
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

/**
 * The run's time budget ended this call, not the agent. Retrying the whole
 * workflow cannot fix that, so callers degrade to a fallback instead.
 */
class BudgetExhaustedError extends A2AError {}

/**
 * The stored authorization is gone: never issued, unassigned, expired, or
 * rejected by the agent. Always non-retryable — under the connect model there
 * is nothing to re-mint, and only the operator can fix it.
 */
class ReconnectRequiredError extends A2AError {}

export function isBudgetExhaustedError(error: unknown): boolean {
  return error instanceof BudgetExhaustedError
}

export function isReconnectRequiredError(error: unknown): boolean {
  return error instanceof ReconnectRequiredError
}

function consumeRequestBudget(budget: A2ASubrequestBudget | undefined, operation: string): void {
  if (!budget) return
  if (budget.remaining <= 0) {
    throw new A2AError(`Free Workers A2A subrequest budget exhausted before ${operation}.`, false)
  }
  budget.remaining -= 1
}

/* ───────── credentials ───────── */

function requireCredential(env: Env, agentId: string): AgentCredential {
  const runtime = env.A2A
  if (!runtime) {
    throw new ReconnectRequiredError(
      'No Manyfold agents are connected. Open /settings and connect one.',
      false,
    )
  }
  if (!agentId) {
    throw new ReconnectRequiredError(
      'This role has no Manyfold agent assigned. Assign one on /settings.',
      false,
    )
  }
  const cred = runtime.credential(agentId)
  if (!cred) {
    throw new ReconnectRequiredError(
      `Agent ${agentId} is not connected. Reconnect it on /settings.`,
      false,
    )
  }
  if (cred.expiresAt !== null && cred.expiresAt <= Date.now()) {
    throw new ReconnectRequiredError(
      `The authorization for "${cred.label}" expired. Reconnect it on /settings.`,
      false,
    )
  }
  return cred
}

/**
 * Health checks confirm an agent still accepts its stored token. They start no
 * model turn: hosted first-token latency is measured in minutes, and scheduled
 * "OK" prompts created expensive work that was routinely cancelled before
 * producing a useful health signal.
 */
export async function checkMfAgentAccess(env: Env, agentId: string): Promise<void> {
  await probeAgentAuth(requireCredential(env, agentId))
}

/* ───────── concurrency ───────── */

class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.active += 1
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    this.waiters.shift()?.()
  }
}

const globalPermits = new Semaphore(MAX_CONCURRENT_A2A_CALLS)
const agentPermits = new Map<string, Semaphore>()

async function withCallPermit<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  let perAgent = agentPermits.get(agentId)
  if (!perAgent) {
    perAgent = new Semaphore(MAX_CONCURRENT_PER_AGENT)
    agentPermits.set(agentId, perAgent)
  }
  // Per-agent permit first, then the global one, released in reverse. The
  // other order lets callers queued behind one saturated agent sit on every
  // global permit and stall a different agent that still has capacity, which
  // surfaces as a spurious budget_limited on an agent that was never busy.
  await perAgent.acquire()
  try {
    await globalPermits.acquire()
    try {
      return await fn()
    } finally {
      globalPermits.release()
    }
  } finally {
    perAgent.release()
  }
}

/* ───────── accepted-task recovery ───────── */

async function noteRejectedCredential(env: Env, cred: AgentCredential, reason: string): Promise<void> {
  try {
    await markCredentialRejected(env, cred.agentId, reason)
  } catch {
    // Recording the rejection is a convenience for /settings, never a reason
    // to lose the underlying error.
  }
}

function rejectedCredentialError(cred: AgentCredential): ReconnectRequiredError {
  return new ReconnectRequiredError(
    `Agent "${cred.label}" rejected its stored authorization. Reconnect it on /settings.`,
    false,
  )
}

async function cancelAccepted(
  cred: AgentCredential,
  id: string,
  requestBudget?: A2ASubrequestBudget,
): Promise<boolean> {
  try {
    consumeRequestBudget(requestBudget, `canceling task ${id}`)
  } catch {
    return false
  }
  return cancelTask(cred, id)
}

/**
 * Follow a Task that was already accepted but whose stream did not deliver a
 * terminal state. Never resubmits the prompt: the turn is already being billed,
 * and a second message/stream would buy a second one.
 */
async function recoverTask(
  env: Env,
  cred: AgentCredential,
  id: string,
  deadline: number,
  onState?: TaskStateCallback,
  initialState = '',
  requestBudget?: A2ASubrequestBudget,
): Promise<Record<string, unknown>> {
  let previousState = initialState
  for (let attempt = 0; attempt < RECOVERY_MAX_REQUESTS; attempt++) {
    if (Date.now() >= deadline) break
    // First check is immediate; the task may already be finished.
    const delay = recoveryDelayMs(attempt)
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))))
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break

    let data: Record<string, unknown>
    try {
      consumeRequestBudget(requestBudget, `recovering accepted task ${id}`)
      data = await getTask(cred, id, Math.max(1_000, Math.min(remaining, 15_000)))
    } catch (error) {
      const failure = normalizeA2AError(error)
      if (!failure.retryable) throw failure
      if (failure.refreshCredential) {
        // Under the peer-mint model this re-minted and kept polling. There is
        // no mint any more, so a rejected token ends the call.
        await noteRejectedCredential(env, cred, failure.message)
        throw rejectedCredentialError(cred)
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
      throw new A2AError(`Agent ${cred.label} task ${state}: ${detail}`, state === 'failed' && looksTransient(detail))
    }
    if (state === 'input-required' || state === 'auth-required') {
      throw new A2AError(`Agent ${cred.label} task stopped in state "${state}".`, false)
    }
  }

  const canceled = await cancelAccepted(cred, id, requestBudget)
  onState?.(canceled ? 'canceled-after-timeout' : 'timed-out', id)
  throw new A2AError(
    `Agent ${cred.label} task ${id} did not complete within the bounded stream-recovery budget${canceled ? ' and was cancelled' : ''}.`,
    false,
  )
}

/* ───────── one attempt ───────── */

async function executeAttempt(
  env: Env,
  cred: AgentCredential,
  body: string,
  timeoutMs: number,
  deadlineAt?: number,
  onTaskState?: TaskStateCallback,
  requestBudget?: A2ASubrequestBudget,
): Promise<string> {
  return withCallPermit(cred.agentId, async () => {
    const deadline = Math.min(deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + timeoutMs)
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // The deadline, not the agent, ended this call before it was submitted.
      throw new BudgetExhaustedError(
        `Agent ${cred.label} exhausted the orchestration time budget before submission.`,
        true,
      )
    }
    consumeRequestBudget(requestBudget, `opening a stream to ${cred.label}`)

    const outcome = await sendMessageStream({ cred, body, timeoutMs: remaining, onState: onTaskState })
    let data = outcome.data
    const interruption = outcome.interrupted

    let state = taskState(data)
    const id = taskId(data)
    // An interruption with a task id means the turn is already running and
    // being billed; recover it. Without an id nothing was accepted, so the
    // error can propagate and a retry is safe.
    if (interruption && id) {
      onTaskState?.('stream-recovering', id, interruption.message)
    } else if (interruption) {
      throw interruption
    }
    if ((state === 'submitted' || state === 'working') && !id) {
      throw new A2AError(`Agent ${cred.label} returned state "${state}" without a task id.`, true)
    }
    if (id && (state === 'submitted' || state === 'working' || !state)) {
      if (!interruption && state) onTaskState?.(state, id)
      data = await recoverTask(env, cred, id, deadline, onTaskState, state, requestBudget)
      state = taskState(data)
    }
    if (state === 'failed' || state === 'canceled' || state === 'rejected') {
      const detail = safeErrorText(extractAgentText(data))
      throw new A2AError(`Agent ${cred.label} task ${state}: ${detail}`, state === 'failed' && looksTransient(detail))
    }
    if (state === 'input-required' || state === 'auth-required') {
      throw new A2AError(`Agent ${cred.label} task stopped in state "${state}".`, false)
    }
    const output = extractAgentText(data).trim()
    if (!output) throw new A2AError(`Agent ${cred.label} completed without text output.`, true)
    return output
  })
}

/* ───────── tracing ───────── */

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
  label: string,
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

function retryDelay(error: A2AError, attempt: number): number {
  if (error.retryAfterMs !== undefined) return error.retryAfterMs
  const exponential = Math.min(4_000, 450 * (2 ** Math.max(0, attempt - 1)))
  return exponential + Math.floor(Math.random() * 250)
}

/* ───────── the call ───────── */

/**
 * Send one prompt to a connected Manyfold agent and return its text output.
 *
 * The deployed queue/Durable Object workflow retries an escaped orchestration
 * failure. Most orchestrator stages intentionally degrade per-agent instead, so
 * transport retries have to happen here, before those fallback paths run.
 */
export async function callMfAgent(
  env: Env,
  agentId: string,
  prompt: string,
  opts: CallOptions = {},
): Promise<string> {
  const callId = crypto.randomUUID()
  emitTrace(opts.trace, callId, 'input', 'Actual input sent through Manyfold A2A', prompt)

  // messageId is A2A's idempotency key and is derived from the call, not
  // generated per attempt: a retried send of the same prompt must not be able
  // to bill a second turn.
  const body = messageStreamBody(prompt, `lens-${callId}`)

  let lastErr: A2AError | undefined
  const attempts = Math.min(3, Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS))
  const timeoutMs = Math.max(5_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  for (let attempt = 0; attempt < attempts; attempt++) {
    const remainingBudget = (opts.deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now()
    if (remainingBudget < MIN_ATTEMPT_BUDGET_MS) {
      lastErr = new BudgetExhaustedError(
        `Agent ${agentId} was stopped because this stage's time budget was exhausted.`,
        true,
      )
      emitTrace(opts.trace, callId, 'error', 'Orchestration time budget exhausted', lastErr.message, attempt + 1, false)
      break
    }
    // When the deadline is tighter than the configured timeout, a failure in
    // that shortened window is the budget's doing, not the agent's verdict.
    const attemptBudget = Math.min(timeoutMs, remainingBudget)
    const clampedByDeadline = remainingBudget < timeoutMs

    try {
      const cred = requireCredential(env, agentId)
      emitTrace(
        opts.trace,
        callId,
        'progress',
        attempt > 0 ? `Attempt ${attempt + 1}: reconnecting` : 'Opening an A2A stream',
        undefined,
        attempt + 1,
      )
      emitTrace(opts.trace, callId, 'progress', 'Stream opened; waiting for the agent', undefined, attempt + 1)

      const output = await executeAttempt(
        env,
        cred,
        body,
        attemptBudget,
        opts.deadlineAt,
        (state, id, detail) => {
          const label = state === 'completed'
            ? 'Agent task completed'
            : state === 'stream-recovering'
              ? 'Stream disconnected; recovering the accepted task'
              : state === 'poll-retrying'
                ? 'Accepted-task recovery request is retrying'
                : `Agent task state: ${state}`
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
      emitTrace(opts.trace, callId, 'output', 'Raw agent output', output, attempt + 1)
      return output
    } catch (e) {
      let error = normalizeA2AError(e)
      if (error.refreshCredential && !(error instanceof ReconnectRequiredError)) {
        // The peer-mint model refreshed here. A connect credential is issued
        // once, so a rejection is terminal and retrying only wastes the budget.
        const cred = env.A2A?.credential(agentId)
        if (cred) {
          await noteRejectedCredential(env, cred, error.message)
          error = rejectedCredentialError(cred)
        }
      }
      if (clampedByDeadline && error.retryable && !isBudgetExhaustedError(error) && !isReconnectRequiredError(error)) {
        error = new BudgetExhaustedError(
          `Agent ${agentId} ran out of this stage's time budget: ${error.message}`,
          true,
          error.refreshCredential,
          error.retryAfterMs,
        )
      }
      lastErr = error

      const waitMs = retryDelay(error, attempt + 1)
      const budgetAfterWait = (opts.deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now() - waitMs
      const willRetry = error.retryable
        && attempt < attempts - 1
        && budgetAfterWait >= MIN_ATTEMPT_BUDGET_MS
      emitTrace(
        opts.trace,
        callId,
        'error',
        willRetry ? `Attempt ${attempt + 1} failed; retrying` : 'Agent call failed',
        error.message,
        attempt + 1,
        willRetry,
      )
      if (!willRetry) throw error
      emitTrace(opts.trace, callId, 'progress', `Retrying in ${Math.ceil(waitMs / 100) / 10}s`, undefined, attempt + 1)
      await new Promise(resolve => setTimeout(resolve, waitMs))
    }
  }
  throw lastErr ?? new A2AError('Manyfold A2A call failed without an error.', false)
}
