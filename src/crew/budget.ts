// ── Orchestration time budget ─────────────────────────────────────
// One orchestration attempt shares an absolute deadline (see
// ORCHESTRATION_BUDGET_MS). Handing that whole deadline to every call lets an
// early stage spend it all: stage 1 fans out three roles, each with a 240s
// per-attempt timeout and one retry, so Context and Synthesiser could be left with a few
// seconds and fail on arrival. Both are then reported as failures even though
// the peers were never really asked.
//
// Instead each stage stops early enough to leave the reservations the later
// stages need. Reservations are floors, not allocations: when stage 1 finishes
// quickly, Context and Synthesiser still get their full per-call timeout, because their
// own deadline is the run deadline minus only what still comes after them.

export type Stage = 'stage1' | 'ctx' | 'synth'

// One Context call plus room for a transient retry.
const CTX_RESERVE_MS = 150_000
// Debate Verdict runs pro/con in parallel and then adjudicates, so it needs a
// second sequential round.
const CTX_DEBATE_RESERVE_MS = 330_000
// Synthesiser is a single call that legitimately runs long, but it only prunes an
// otherwise complete report, so it reserves the least.
const SYNTH_RESERVE_MS = 90_000

export interface RunBudget {
  /** Absolute end of the whole orchestration attempt. */
  deadlineAt: number
  ctxReserveMs: number
  synthReserveMs: number
}

export function createRunBudget(
  startedAt: number,
  totalMs: number,
  opts: { debate?: boolean } = {},
): RunBudget {
  return {
    deadlineAt: startedAt + totalMs,
    ctxReserveMs: opts.debate ? CTX_DEBATE_RESERVE_MS : CTX_RESERVE_MS,
    synthReserveMs: SYNTH_RESERVE_MS,
  }
}

// The absolute deadline calls made during `stage` must respect. A stage never
// reserves anything for itself, so it keeps every millisecond the stages after
// it do not need.
export function stageDeadline(budget: RunBudget, stage: Stage): number {
  if (stage === 'stage1') return budget.deadlineAt - budget.ctxReserveMs - budget.synthReserveMs
  if (stage === 'ctx') return budget.deadlineAt - budget.synthReserveMs
  return budget.deadlineAt
}
