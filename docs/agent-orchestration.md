# Article Lens — agent orchestration

This document defines the graph semantics implemented by
`src/crew/orchestrator.ts` and edited through the pixel office.

For runtime internals, see [Architecture](./architecture.md). For configuration
and deployment, see [Operations](./operations.md).

## Reliability contract

- A2A transport admits at most four concurrent calls per Worker isolate.
- Peer-token minting is single-flight and cached until shortly before expiry.
- Normal peer calls get up to two attempts; only transient failures retry.
- `message/stream` carries Task status and artifacts in one SSE subrequest.
- A disconnected accepted Task gets at most seven sparse `tasks/get` recovery
  checks; its prompt is not submitted a second time.
- All A2A calls share a 30-request budget, preserving 20 of Free Workers' 50
  external subrequests for input and other upstream work.
- Calls in one orchestration attempt share a 12-minute deadline, but each stage
  stops early enough to leave the reserves the later stages need, so stage 1
  cannot starve `ctx` or `synth`. Reserves are floors: an early stage 1 leaves
  the later stages their full per-call timeout, and debate widens the `ctx`
  reserve.
- An accepted Task that exceeds its budget is canceled best-effort; the same
  role is not immediately submitted again.
- A failed voting replica does not downgrade a role if another replica produced
  a real result.
- `sum` and `ctx` are critical. Their fallback on the first durable attempt
  triggers one whole-workflow retry.
- Unless the time budget, not the peer, caused it. A budget-limited fallback
  finishes the run degraded instead of retrying, because the retry would reach
  the same wall. This is what an over-subscribed graph (debate plus replicas
  plus high effort) now costs: one degraded role, not a doubled wait.
- `jargon`, `comments`, and `synth` may degrade without blocking a useful report.
- Degraded results remain visible but are never cached.

## Goals

1. Make quality and token-cost tradeoffs explicit.
2. Provide task-shaped presets without creating separate execution engines.
3. Let users tune the same graph directly through the office.

## Dependency graph

```text
                 ┌─ sum ──────┐
input ───────────┼─ comments ─┴─→ ctx ───┐
                 └─ jargon ──────────────┼─→ synth ─→ report
                                        ┘
```

`sum`, `jargon`, and `comments` read the raw input independently and normally
run in parallel. `ctx` consumes summary and comment context. `synth` integrates
all enabled sections.

## Orchestration primitives

| Primitive | Meaning |
|---|---|
| parallel | independent agents read the same input |
| relay | one group member hands output to the next |
| vote × N | replicas run independently and merge |
| enabled | include or skip a role |
| effort | low, medium, or high role budget |
| dependency edge | downstream role consumes upstream output |
| conditional edge | escalation runs a standby role only after a decision |
| debate | context runs pro/con arguments and adjudication |

## `GraphConfig` v2

```jsonc
{
  "v": 2,
  "nodes": {
    "sum":      { "enabled": true, "effort": "med" },
    "jargon":   { "enabled": true, "effort": "med", "replicas": 1 },
    "comments": { "enabled": true, "effort": "med" },
    "ctx":      { "enabled": true },
    "synth":    { "enabled": true }
  },
  "escalate": false,
  "debate": false,
  "audience": null,
  "edges": [["jargon", "ctx"]],
  "groups": [
    { "members": ["sum", "jargon"], "mode": "parallel" }
  ]
}
```

An absent graph uses the default parallel-reader topology. The backend
normalizes the submitted graph and emits the actual `workflow_plan`; the
browser never infers execution topology from layout alone.

## Effort and token estimates

The office uses these approximate values before execution. The backend replaces
the estimate with reported or character-based actual usage.

| Agent | Low | Medium | High |
|---|---:|---:|---:|
| sum | 2k | 4k | 6k |
| jargon | 5k | 10k | 16k |
| comments | 4k | 8k | 12k |
| ctx | 2k | 2k | 3k |
| synth | 4k | 4k | 5k |

Effort changes concrete prompt/output limits: summary depth, jargon windows and
term cap, and the comment input/camp budget. Replicas multiply the selected
role cost. Debate runs context approximately three times.

## Presets

| Preset | Graph shape | Expected result |
|---|---|---|
| ⚡ Quick scan | `sum(low) + ctx`; jargon/comments off | verdict and short summary |
| 📄 Standard | all medium, parallel | full report |
| 🎯 Jargon drill | `jargon(high) ×2 + ctx`; `sum(low)` | deeper glossary |
| 🔬 Deep read | all high, extra dependency | most complete report |
| 🛡️ Reliable | every reader ×2 | broader coverage through voting |
| 💸 Thrifty | `sum + ctx` first, conditional escalation | spend only when worthwhile |
| 🎭 Debate | pro/con context plus adjudication | more balanced verdict |

Presets and manual editing both produce the same `GraphConfig`; they do not
select separate backend implementations.

## Token reporting

Each agent call emits a `usage` event when possible. The final result stores:

```json
{
  "usage": {
    "total": 32000,
    "byAgent": {
      "sum": 4000,
      "jargon": 10000
    }
  }
}
```

If a provider omits usage, the Worker estimates tokens from input and output
characters. The Workflow Inspector groups usage by role, call, replica, and
whole-workflow attempt.
