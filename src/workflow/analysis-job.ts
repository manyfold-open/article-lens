import { DurableObject } from 'cloudflare:workers'
import type { Env, HNLensResult, SSEEvent } from '../schema'

export interface AnalysisJobParams {
  jobId: string
  query: string
  createdAt: number
  source: 'api' | 'sse'
}

export interface AnalysisQueueMessage {
  jobId: string
}

interface StoredEvent {
  seq: number
  data: SSEEvent
}

interface AnalysisJobState {
  version: 1
  params: AnalysisJobParams
  phase: 'queued' | 'running' | 'done' | 'error'
  attempts: number
  maxAttempts: number
  availableAt: number
  queuedAt?: number
  leaseId?: string
  leaseUntil?: number
  events: StoredEvent[]
  nextSeq: number
  result?: HNLensResult
  error?: string
  updatedAt: number
  completedAt?: number
}

export interface AnalysisClaim {
  status: 'claimed' | 'done' | 'busy' | 'missing'
  leaseId?: string
  retryAfterSeconds?: number
  params?: AnalysisJobParams
  attempt?: number
  maxAttempts?: number
}

const STATE_KEY = 'job'
const RECONCILE_MS = 60_000
const LEASE_MS = 14 * 60_000
const RETENTION_MS = 24 * 60 * 60_000
const MAX_EVENTS = 400

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500)
}

export class AnalysisJob extends DurableObject<Env> {
  async initialize(params: AnalysisJobParams): Promise<Record<string, unknown>> {
    const existing = this.readState()
    if (existing) return this.snapshot(existing, 0)

    const state: AnalysisJobState = {
      version: 1,
      params,
      phase: 'queued',
      attempts: 0,
      maxAttempts: 2,
      availableAt: 0,
      events: [],
      nextSeq: 1,
      updatedAt: Date.now(),
    }
    this.append(state, {
      event: 'workflow_state',
      analysis_id: params.jobId,
      attempt: 0,
      max_attempts: state.maxAttempts,
      state: 'queued',
    })
    this.writeState(state)
    await this.publish(state)
    return this.snapshot(state, 0)
  }

  async claim(): Promise<AnalysisClaim> {
    const state = this.readState()
    if (!state) return { status: 'missing' }
    if (state.phase === 'done' || state.phase === 'error') return { status: 'done' }

    const now = Date.now()
    if (state.phase === 'running' && (state.leaseUntil ?? 0) > now) {
      return {
        status: 'busy',
        retryAfterSeconds: Math.max(5, Math.ceil(((state.leaseUntil ?? now) - now) / 1000)),
      }
    }
    if (state.availableAt > now) {
      return { status: 'busy', retryAfterSeconds: Math.max(1, Math.ceil((state.availableAt - now) / 1000)) }
    }

    const leaseId = crypto.randomUUID()
    state.phase = 'running'
    state.attempts += 1
    state.leaseId = leaseId
    state.leaseUntil = now + LEASE_MS
    state.updatedAt = now
    this.append(state, {
      event: 'workflow_state',
      analysis_id: state.params.jobId,
      attempt: state.attempts,
      max_attempts: state.maxAttempts,
      state: 'running',
    })
    this.writeState(state)
    await this.scheduleAlarm(state)
    return {
      status: 'claimed',
      leaseId,
      params: state.params,
      attempt: state.attempts,
      maxAttempts: state.maxAttempts,
    }
  }

  async appendEvents(leaseId: string, events: SSEEvent[]): Promise<'ok' | 'stale'> {
    const state = this.readState()
    if (!state || state.phase !== 'running' || state.leaseId !== leaseId) return 'stale'
    for (const event of events) this.append(state, event)
    state.updatedAt = Date.now()
    this.writeState(state)
    return 'ok'
  }

  async complete(leaseId: string, result: HNLensResult): Promise<'ok' | 'stale'> {
    const state = this.readState()
    if (!state || state.phase !== 'running' || state.leaseId !== leaseId) return 'stale'
    const now = Date.now()
    state.phase = 'done'
    state.result = result
    state.completedAt = now
    state.updatedAt = now
    state.leaseId = undefined
    state.leaseUntil = undefined
    if (!state.events.some(entry => entry.data.event === 'result')) {
      this.append(state, { event: 'result', data: result })
    }
    this.append(state, {
      event: 'workflow_state',
      analysis_id: state.params.jobId,
      attempt: state.attempts,
      max_attempts: state.maxAttempts,
      state: 'done',
    })
    this.writeState(state)
    await this.ctx.storage.setAlarm(now + RETENTION_MS)
    return 'ok'
  }

  async fail(leaseId: string, error: unknown, retryable: boolean): Promise<{ action: 'retry' | 'terminal' | 'stale'; delaySeconds?: number }> {
    const state = this.readState()
    if (!state || state.phase !== 'running' || state.leaseId !== leaseId) return { action: 'stale' }
    const now = Date.now()
    const message = shortError(error)
    state.leaseId = undefined
    state.leaseUntil = undefined

    if (retryable && state.attempts < state.maxAttempts) {
      const delaySeconds = 10 * state.attempts
      state.phase = 'queued'
      state.availableAt = now + delaySeconds * 1000
      state.queuedAt = undefined
      state.updatedAt = now
      this.append(state, {
        event: 'retry',
        attempt: state.attempts + 1,
        max_attempts: state.maxAttempts,
        delay_seconds: delaySeconds,
        reason: message,
      })
      this.append(state, {
        event: 'workflow_state',
        analysis_id: state.params.jobId,
        attempt: state.attempts,
        max_attempts: state.maxAttempts,
        state: 'retry_wait',
        delay_seconds: delaySeconds,
        reason: message,
      })
      this.writeState(state)
      await this.scheduleAlarm(state)
      return { action: 'retry', delaySeconds }
    }

    state.phase = 'error'
    state.error = message
    state.completedAt = now
    state.updatedAt = now
    this.append(state, { event: 'error', message })
    this.append(state, {
      event: 'workflow_state',
      analysis_id: state.params.jobId,
      attempt: state.attempts,
      max_attempts: state.maxAttempts,
      state: 'error',
      reason: message,
    })
    this.writeState(state)
    await this.ctx.storage.setAlarm(now + RETENTION_MS)
    return { action: 'terminal' }
  }

  async getSnapshot(afterSeq = 0): Promise<Record<string, unknown> | null> {
    const state = this.readState()
    return state ? this.snapshot(state, afterSeq) : null
  }

  async alarm(): Promise<void> {
    const state = this.readState()
    if (!state) return
    const now = Date.now()

    if ((state.phase === 'done' || state.phase === 'error') && state.completedAt && now >= state.completedAt + RETENTION_MS) {
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return
    }

    if (state.phase === 'running' && (state.leaseUntil ?? 0) <= now) {
      state.phase = 'queued'
      state.leaseId = undefined
      state.leaseUntil = undefined
      state.queuedAt = undefined
      state.availableAt = now
      state.updatedAt = now
      this.append(state, {
        event: 'workflow_state',
        analysis_id: state.params.jobId,
        attempt: state.attempts,
        max_attempts: state.maxAttempts,
        state: 'queued',
        reason: 'The previous workflow lease expired; the job was queued again.',
      })
      this.writeState(state)
    }
    if (state.phase === 'queued') await this.publish(state)
    else await this.scheduleAlarm(state)
  }

  private readState(): AnalysisJobState | undefined {
    return this.ctx.storage.kv.get<AnalysisJobState>(STATE_KEY)
  }

  private writeState(state: AnalysisJobState): void {
    this.ctx.storage.kv.put(STATE_KEY, state)
  }

  private append(state: AnalysisJobState, event: SSEEvent): void {
    const stamped = event.at ? event : { ...event, at: new Date().toISOString() }
    state.events.push({ seq: state.nextSeq++, data: stamped })
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
  }

  private async publish(state: AnalysisJobState): Promise<void> {
    const now = Date.now()
    if (state.availableAt > now) {
      await this.scheduleAlarm(state)
      return
    }
    if (state.queuedAt && state.queuedAt > now - RECONCILE_MS) {
      await this.scheduleAlarm(state)
      return
    }
    state.queuedAt = now
    state.updatedAt = now
    this.writeState(state)
    await this.scheduleAlarm(state)
    try {
      await this.env.ANALYSIS_TASK_QUEUE.send({ jobId: state.params.jobId })
    } catch (error) {
      // The durable alarm is already armed. Keep the accepted job and let
      // reconciliation publish it again instead of losing its public job ID.
      console.error('analysis queue publish failed; reconciliation will retry', shortError(error))
    }
  }

  private async scheduleAlarm(state: AnalysisJobState): Promise<void> {
    if (state.phase === 'done' || state.phase === 'error') {
      if (state.completedAt) await this.ctx.storage.setAlarm(state.completedAt + RETENTION_MS)
      return
    }
    const now = Date.now()
    const candidates = [
      state.availableAt > now ? state.availableAt : undefined,
      state.queuedAt ? state.queuedAt + RECONCILE_MS : undefined,
      state.leaseUntil,
    ].filter((value): value is number => typeof value === 'number' && value > now)
    await this.ctx.storage.setAlarm(candidates.length ? Math.min(...candidates) : now + RECONCILE_MS)
  }

  private snapshot(state: AnalysisJobState, afterSeq: number): Record<string, unknown> {
    return {
      analysis_id: state.params.jobId,
      phase: state.phase,
      attempts: state.attempts,
      max_attempts: state.maxAttempts,
      created_at: new Date(state.params.createdAt).toISOString(),
      events: state.events.filter(event => event.seq > afterSeq),
      cursor: state.nextSeq - 1,
      result: state.result,
      error: state.error ?? null,
      updated_at: new Date(state.updatedAt).toISOString(),
    }
  }
}
