import { isReconnectRequiredError } from '../crew/mf'
import type { Env, HNLensResult, SSEEvent } from '../schema'
import { runAnalysisRequest } from '../routes/analyze'
import type { AnalysisClaim, AnalysisQueueMessage } from './analysis-job'

const FLUSH_INTERVAL_MS = 350

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function isRetryable(error: unknown): boolean {
  // Checked by identity, not by pattern: with max_retries = 30 on the queue, a
  // revoked or expired authorization would otherwise be re-attempted for hours,
  // and no number of retries can re-issue a credential only the operator can.
  if (isReconnectRequiredError(error)) return false
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (/\b(400|401|403|404|invalid input|validation|schema|permission)\b/.test(message)) return false
  return true
}

export async function handleAnalysisTaskBatch(
  batch: MessageBatch<AnalysisQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const jobId = message.body?.jobId
    if (!jobId) {
      message.ack()
      continue
    }

    const stub = env.ANALYSIS_JOBS.get(env.ANALYSIS_JOBS.idFromName(jobId))
    let claim: AnalysisClaim
    try {
      claim = await stub.claim()
    } catch {
      message.retry({ delaySeconds: 15 })
      continue
    }

    if (claim.status === 'done' || claim.status === 'missing') {
      message.ack()
      continue
    }
    if (claim.status === 'busy') {
      message.retry({ delaySeconds: Math.min(claim.retryAfterSeconds ?? 15, 600) })
      continue
    }
    if (!claim.leaseId || !claim.params) {
      message.retry({ delaySeconds: 15 })
      continue
    }

    const buffered: SSEEvent[] = []
    let stopped = false
    const flush = async () => {
      if (!buffered.length) return
      const events = buffered.splice(0, buffered.length)
      await stub.appendEvents(claim.leaseId!, events)
    }
    const flushLoop = (async () => {
      while (!stopped) {
        await sleep(FLUSH_INTERVAL_MS)
        try {
          await flush()
        } catch {
          // The final flush and task completion path remain authoritative.
        }
      }
    })()

    try {
      const requestUrl = new URL(`https://analysis.internal/api/analyze${claim.params.query}`)
      const result = await runAnalysisRequest(requestUrl, env, event => buffered.push(event), {
        // First attempt requires the critical agents to succeed. The final job
        // attempt may return an explicitly degraded result instead of looping.
        allowCriticalFallback: (claim.attempt ?? 1) >= (claim.maxAttempts ?? 2),
        analysisId: jobId,
        attempt: claim.attempt ?? 1,
        maxAttempts: claim.maxAttempts ?? 2,
      })
      stopped = true
      await flushLoop
      await flush()
      await stub.complete(claim.leaseId, result as HNLensResult)
      message.ack()
    } catch (error) {
      stopped = true
      await flushLoop
      try {
        await flush()
      } catch {
        // Failure state below still reaches the client.
      }
      try {
        const decision = await stub.fail(claim.leaseId, error, isRetryable(error))
        if (decision.action === 'retry') message.retry({ delaySeconds: decision.delaySeconds ?? 30 })
        else message.ack()
      } catch {
        message.retry({ delaySeconds: 30 })
      }
    }
  }
}
