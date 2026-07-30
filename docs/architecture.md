# Article Lens — architecture

This is the current reference for the Article Lens Worker. Article Lens is a
bilingual, Chinese-first article companion whose Manyfold A2A crew produces a
summary, jargon guide, verdict, and comment digest.

**Live:** https://mf-article-lens.netmind-ai.workers.dev

For environment setup, secrets, validation, and deployment, see
[Operations](./operations.md). For graph controls and presets, see
[Agent orchestration](./agent-orchestration.md).

## Runtime architecture

The deployment is one Cloudflare Worker using static assets, KV, a SQLite
Durable Object class, and a Queue. It does not use the Cloudflare Workflows
product.

```text
HTTP analysis request
  → initialize one AnalysisJob Durable Object
  → persist job state and publish {jobId}
  → ANALYSIS_TASK_QUEUE invokes the Queue consumer
  → consumer runs the application-owned Manyfold crew graph
  → streamed events and the result are persisted to AnalysisJob
  → SSE compatibility endpoint polls those persisted events
```

`src/workflow/analysis-job.ts` owns durable state, lease validation, retry
timing, event cursors, terminal state, alarms, and cleanup.
`src/workflow/analysis-task.ts` is the Queue consumer. It executes one coarse
analysis task because `src/crew/orchestrator.ts` already owns the tunable
multi-agent graph, including parallel branches, relay, replicas, escalation,
debate, and synthesis.

This separation keeps Cloudflare concerned with persistence and delivery while
the repository owns all workflow semantics.

## Source layout

```text
src/
  index.ts             HTTP and Queue dispatch; exports AnalysisJob
  admin/
    settings.ts        admin auth, encrypted config storage, runtime merge
  workflow/
    analysis-job.ts    durable workflow state machine
    analysis-task.ts   Queue consumer and event flush loop
  routes/
    analyze.ts         input resolution, job APIs, and cache orchestration
    frontpage.ts       GET /api/frontpage
    define.ts          POST /api/define
    translate.ts       POST /api/translate
    health.ts          GET /api/health and on-demand peer checks
  crew/
    orchestrator.ts    application-owned multi-agent DAG
    mf.ts              Manyfold token mint + A2A message/stream client
    mock.ts            offline/failure fallback
    json.ts            tolerant LLM JSON repair
  cache.ts             best-effort result cache
  hn.ts                HN input lookup
  extract.ts           article extraction
  schema.ts            contracts and Cloudflare bindings
  stream.ts            SSE helpers
public/
  index.html           main UI and styling
  app.js               analysis polling, results, Activity, KB, translation
  pixel.js             pixel-office simulation and graph editor
  workflow-model.js    replay-safe client workflow reducer
  workflow-view.js     DAG and timeline renderer
  access.*             application access page
  settings.*           admin configuration page
```

Every user-facing localized string uses `BiStr = {en, zh}`. Agents fill Chinese
first; English is requested lazily through `/api/translate`.

## Workflow behavior and recovery

- Queue delivery is treated as at-least-once. A consumer must acquire the
  current lease from `AnalysisJob`; stale completions are rejected.
- A job gets up to two workflow-owned attempts. The second attempt starts after
  10 seconds and emits a durable `retry` event so clients do not mistake the
  quiet period for a stuck run.
- The lease is 14 minutes, below the Queue consumer's 15-minute wall-time
  limit. A Durable Object alarm reconciles missing publications and expired
  leases every minute.
- The orchestrator gives all A2A calls in one attempt a shared 12-minute
  deadline. This leaves time for input resolution, durable event/result writes,
  and runtime jitter before the Queue invocation reaches its hard limit.
- Stages do not share that deadline equally. `src/crew/budget.ts` reserves time
  for the stages that still have to run: stage 1 stops at the deadline minus the
  verdict and synthesis reserves, the verdict stops at the deadline minus the
  synthesis reserve, and synthesis owns the remainder. Reserves are floors, not
  allocations, so when stage 1 finishes early the later stages still get their
  full per-call timeout. 辯論裁定 widens the verdict reserve, because it needs a
  second sequential round.
- Durable state and the alarm are written before Queue publication. A temporary
  Queue error therefore does not lose an accepted analysis.
- Events have monotonically increasing cursors. The object retains at most 400
  events and stores the final result separately.
- Terminal jobs are retained for 24 hours.
- The Queue consumer uses batch size 1 and maximum concurrency 2.

Manyfold recovery is layered:

1. each A2A call retries transient transport/runtime failures up to twice;
2. non-critical agents (`jargon`, `comments`, `synth`) may degrade without
   restarting an otherwise useful run;
3. on the first job attempt, a fallback from a critical agent (`sum` or `ctx`)
   stops downstream work and schedules the second durable attempt;
4. except when that fallback was caused by the time budget rather than by the
   peer. Those calls are reported as `budget_limited` in `agent_sources`, and
   they do not schedule a retry: a second attempt gets the same 12 minutes and
   would exhaust them the same way, making the reader wait twice for the same
   degraded report;
5. the final attempt may finish with explicit fallback sources, but degraded
   output is never written to the seven-day result cache.

A fallback is only one of three distinct failures, and they need different
fixes. `agent_sources` distinguishes them:

| Field | Meaning | Fix |
|---|---|---|
| `budget_limited` | the role ran out of its own time slice | rebalance the stage reserves |
| `output_unparseable` | the peer answered, but the output could not be parsed | see below |
| neither | transport, timeout, or an offline sandbox | the peer or the network |

`output_unparseable` carries its own classification, because a cut-off answer
and a malformed one are not the same problem: `truncated` means the role wrote
past its output cap, so the fix is to ask for less; `not_json` means the prompt
or output format is not landing; `empty` means nothing came back at all.

This matters most for `jargon`, which has the longest structured output of any
role (10–16 term objects against `sum`'s single summary) and is therefore the
likeliest to be cut off. Before this distinction existed, a truncated jargon
answer was reported to the reader as "did not respond in time", which pointed
the next fix at the timeout instead of at the output length.

The Durable Object currently stores events and the compact final result in one
SQLite-backed value. Keep it below the Durable Object value-size limit. If
results grow materially, put large payloads in KV or R2 and persist references.

## API

### Compatibility SSE API

```http
GET /api/analyze?id=...|url=...|text=...
```

This starts a durable job, then streams the job's persisted events. Closing the
browser no longer cancels the underlying analysis; the Queue consumer continues.

### Asynchronous API

```http
POST /api/analyses
Content-Type: application/json

{"url":"https://example.com/article"}
```

Exactly one of `id`, `url`, or `text` is required. Optional `kb` and `graph`
fields keep the same semantics as the SSE endpoint. The response is:

```json
{
  "analysis_id": "...",
  "phase": "queued",
  "status_url": "/api/analyses/.../status"
}
```

Read status with:

```http
GET /api/analyses/:id/status?after=<cursor>
```

Omit `after` for a full retained snapshot. Supplying the last processed cursor
returns only newer persisted events while preserving the existing response
shape. Each new event has a server timestamp. Older retained events without
`at` remain valid and the client assigns a safe receipt-time fallback.

The durable event stream also includes:

- `workflow_plan`: the normalized execution DAG used by the orchestrator,
  including node effort, replicas, groups, relay and conditional edges,
  escalation, debate, and audience metadata.
- `workflow_state`: `queued`, `running`, `retry_wait`, `done`, or `error` for a
  specific whole-workflow attempt.
- `status.mode`: optional `real`, `cache`, `fallback`, or `skipped` provenance.

Other endpoints:

- `GET /api/frontpage`
- `GET /api/health`
- `POST /api/translate`
- `POST /api/define`
- `GET /access` — six-digit application access gate
- `POST /api/access/login` and `/logout` — visitor session management
- `GET /settings` — password-gated runtime configuration UI

All application and API routes above, except `/access` and the admin Settings
routes, require a valid Article Lens access session. Security and configuration
details live in [Operations](./operations.md).

## Workflow Inspector and recovery

The main browser UI creates work with `POST /api/analyses` and polls the status
endpoint incrementally. The compatibility SSE route remains available for
existing integrations.

During a run and on the result page, the embedded Workflow Inspector renders
the backend-provided role-level DAG and an A2A-call timeline. Agent prompts,
progress, raw output, and exact errors remain in the Agent Detail drawer;
Activity remains the complete raw event log. The graph is read-only—the pixel
office remains the orchestration editor.

The current `analysis_id` is stored in the URL as `?analysis=...`. Reloading the
page replays the retained events once, resumes from the returned cursor, and
does not duplicate Activity entries or token totals. Temporary network failures
use capped exponential reconnect delays and do not mark the workflow failed.
Durable Object records expire after 24 hours; an expired URL returns safely to
the input state with an explicit message.

## Manyfold A2A

`src/crew/mf.ts` calls each role peer in three steps:

1. mint a short-lived peer token from
   `MF_API_URL/agent-self/a2a/peers/{targetAgentId}/token?agentId={sourceAgentId}`;
2. send JSON-RPC A2A `message/stream` and aggregate Task status plus artifact
   updates from its SSE response;
3. only when that stream ends after the Task was accepted, recover the same
   Task with at most seven sparse `tasks/get` checks. Never resubmit the prompt
   merely because an accepted Task's stream disconnected.

The source identity is `MF_AGENT_ID`; peer targets are the six `AGENT_*`
settings. `MF_API_TOKEN` is the source identity's runtime secret and needs
`a2a:read`. Each target agent must grant that source identity peer access.

Credential minting is single-flight per peer, so concurrent fan-out does not
stampede the token endpoint. The Worker admits at most four A2A calls per
isolate, below Cloudflare's six simultaneous outbound-connection limit.

Free Workers allow 50 external subrequests per invocation. Each orchestration
therefore gives all A2A calls one shared 30-request application budget and
reserves the other 20 for article resolution and other upstream work. The
normal path costs one stream per agent plus a token mint when the peer
credential is not cached, instead of one `tasks/get` request per second. Budget
exhaustion is an explicit agent failure, so the fallback/retry policy runs
before Cloudflare starts rejecting unrelated fetches. See Cloudflare's
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Wrangler limits configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits).

Calls default to two attempts with bounded exponential backoff and `Retry-After`
support. HTTP 408/409/425/429, 5xx, network errors, timeouts, and temporary
runtime failures retry; invalid requests and permanent protocol errors fail
fast. A peer HTTP 401 invalidates only the short-lived peer token before
retrying. Once a remote Task has been accepted, an application timeout does
not submit a duplicate: the exact Task is canceled best-effort and the
role/workflow fallback policy decides the next step. Calls use a 240-second
per-attempt budget, based on observed hosted-agent first-token latency.

Comments are ranked and token-capped locally, then sent to the reduce peer in
one call. The previous 8–12 peer map fan-out paid the hosted runtime startup
latency repeatedly and could exhaust the Queue invocation before verdict and
synthesis ran.

## Analysis graph

The default logical graph is:

1. emit the plan;
2. run summary, jargon, and comment analysis in parallel;
3. run context/verdict after it has summary and comment context;
4. run the synthesizer to integrate and prune the result;
5. emit the final result.

User graph settings can enable relay, replicas, conditional escalation, debate,
audience tone, and effort controls. See
[Agent orchestration](./agent-orchestration.md) for those semantics.

## Caching

Each input produces a cache key based on HN ID, URL hash, or text hash. Stable
cache keys include a quality-policy suffix so entries from the old fallback
policy are not replayed. The Worker stores:

- `${cacheKey}:shared...` — summary, comment digest, and verdict;
- `${cacheKey}:j:${kbHash}...` — KB-specific jargon;
- `${cacheKey}:${kbHash}...` — complete result.

A full cache hit replays events through the same durable job. Partial hits are
passed into the crew so it computes only missing sections. Results containing
any fallback agent, or results without attributable real/cache/skipped sources
for the four primary roles, are not cached.

`SPEC_VERSION` is the result cache version. Change it from `/settings` whenever
result-generation behavior changes; the Wrangler value is the bootstrap
fallback.
