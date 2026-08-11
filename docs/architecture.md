# Article Lens — architecture

This is the current reference for the Article Lens Worker. Article Lens is a
English article companion whose Manyfold A2A crew produces a
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
    health.ts          GET /api/health and on-demand agent probes
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
  controls.js          page-drawn listbox, switch, and tooltip
  pixel.js             pixel-office simulation and graph editor
  workflow-model.js    replay-safe client workflow reducer
  workflow-view.js     DAG and timeline renderer
  access.*             application access page
  settings.*           admin configuration page
```

Every user-facing string is plain English. The roles are prompted in English and
answer in English, so the result carries one language and no section can render
blank or half-translated while a translation is in flight.

This replaced a `BiStr = {en, zh}` field on every string, which the roles filled
Chinese-first while the browser fetched English lazily from `/api/translate`. That
arrangement had two visible failure modes and they were the same bug seen through
two different renderers: a value read through the JS `L()` helper fell back to the
Chinese side, so the report read as mixed language, while a value rendered as a
paired `.bi-zh`/`.bi-en` span had no fallback at all and rendered *blank* — which
is what the TL;DR and the key points did, for as long as the translate call took.
Both corrected themselves seconds later, when the round trip returned and the
report re-rendered, which made the report look like it was still loading after it
had finished.

`/api/translate` is gone with it. It was not a lookup: it called the Summariser
agent over A2A, so every uncached article paid a second hosted-agent round trip
before the reader could read the report in English. Two further faults died with
it — the request capped at 80 strings with no chunking, so a long report silently
left the overflow untranslated, and the response was accepted all-or-nothing, so
one length mismatch from the model left the entire report in Chinese.

`scripts/validate-repository.mjs` fails the build on non-Latin text in `src/`,
`public/`, `scripts/` and `docs/`, because one prompt asking for Chinese output is
enough to put mixed-language text back on the report. A line that genuinely needs
non-Latin characters — the sentence splitter has to recognise a CJK full stop,
since an article can be in any language — opts out with an `allow-non-english`
marker. `tests/` is exempt so a non-Latin fixture can prove the extractor and the
JSON repair survive an article that is not in English.

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
  full per-call timeout. Debate Verdict widens the verdict reserve, because it needs a
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
   agent. Those calls are reported as `budget_limited` in `agent_sources`, and
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
| `output_unparseable` | the agent answered, but the output could not be parsed | see below |
| neither | transport, timeout, or an offline sandbox | the agent or the network |

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
the backend-provided role-level DAG, an A2A-call timeline, and the Orchestrator's division of
labour. Agent prompts, progress, raw output, and exact errors remain in the Agent
Detail drawer; Activity remains the complete raw event log. The graph is
read-only—the pixel office remains the orchestration editor.

## Two surfaces, two questions

The result page is a demonstration of a multi-agent crew before it is a reading
tool, so the two surfaces are split by the question they answer and nothing
appears on both:

- the pixel office and the six report cards answer **what the crew found**;
- the Workbench (Workflow plus Activity) answers **how they found it**.

That is why the division of labour lives in the Workflow Inspector's Assignments
view rather than on the Orchestrator's card, and why that card is an overall report: the
verdict, then one synopsis per teammate, each linking to that teammate's own card.
The card is deliberately an outline rather than the full text — it is the first
card the reveal opens, so it has to stay scannable and leave the other five cards
something to show. Every card also carries its agent's job in one line and its
uniform colour down the left edge, because the office only reveals a role on
hover and neither a phone nor a demo audience can hover.

The office, the report column and the console are three stacked full-width bands,
so they share one outer edge: `main` is `calc(var(--workspace-width) + 40px)`, the
same variable the office and console use, plus that column's own padding. A column
with a width of its own made the band holding the most text the narrowest one, and
therefore the longest — the comment digest measured 1200px at 640px wide and 676px
at the office's 1040px, for the same result. The mobile rule had always done this;
only the desktop column had a number of its own. `width: 100%` is load-bearing
there: `main` is a flex item of the column `.app-shell`, and an `auto` cross-axis
margin opts it out of stretching, so without it the column sizes to its content and
the cap never applies. Prose does not inherit the card's new width — `--prose-measure`
keeps a paragraph to a line a reader can track back.

Inside the Comments card the camps are a deck, not five tinted blocks. The camps are the
role's primary finding, so they stay on the page as labelled strips that overlap by
5px, one open at a time, with the majority camp open by default; each closed strip
carries its name, its weight and one clipped line of its stance. Disputes, expert
corrections and spicy takes are secondary, and as four full-width tinted blocks with
one card per item they cost more height than the camps and the overview together.
Each is now one `<details>` row carrying its item count, because a collapsed row that
only says Disputes reads as an empty section while Disputes 2 does not. Collapsing the camps
too is shorter still and was rejected for the same reason the cards state their
agent's job: the first thing a reader or a demo audience sees would be nothing the
crew found.

The Assignments view holds two facts that arrive at different times, so it shows
two columns rather than one status chip. `briefing.assignments[].action` is the
order the Orchestrator gave and is known the moment the briefing arrives, while
`flags.agent_sources[].mode` is what the section turned out to be and exists only
on the finished result. One chip could only guess the second, so mid-run every row
claimed a real analysis while the route line above it said cache. An unknown fact
now says it is unknown, and a role told to run that came back on fallback is
legible instead of invisible. Output volume is absent from the table on purpose:
how many terms or camps a role produced is what the crew found, so it stays on the
cards and in the office hover detail.

`briefing.route` is no longer rendered anywhere. It is this table's assignment
column serialized onto one line, in a second vocabulary whose `running` and
`from cache` read as live state rather than as an order. The view carries no title
either, because the active tab already names it and neither Graph nor Timeline
titles itself. The same reasoning removed the division-of-labour list from the Orchestrator's
click-to-inspect panel: that panel is office-side, so it keeps the job description
and the output counts and nothing else.

The Workbench presents one view at a time through a single row of tabs: Graph,
Timeline, Assignments, Activity. Analyse is not one of them, because it is the
input needed before there is anything to inspect, so it stays open below the
chosen view. `WorkflowInspector` renders the first three inside one panel and is
told which to show through `setTab`; it does not own tabs or a collapse control.

## No OS-drawn controls

Nothing on the page may hand its rendering to the operating system. A native
`<select>` has its open list drawn by the OS, a native checkbox its tick, `title`
its tooltip, and `alert()` its dialog: none of them can be styled, none follow the
page's language toggle, and `title` never appears on a touch screen at all. Beside
a pixel office they read as someone else's software.

`public/controls.js` supplies the replacements: a listbox, a switch, and one
page-drawn tooltip fed by `data-tip`. Both controls keep the native contract on
purpose — a `value` or `checked` property and a bubbling `change` event — so call
sites read them exactly as they read the elements they replace. Colours come from
`--ui-control-*` variables declared on `:root`, which each surrounding context
overrides; declaring them on the control itself would beat the context's value.
Disclosure triangles, scrollbars, text selection, and Chrome's autofill wash are
overridden in `index.html` for the same reason.

`flags.curation` records what the Synthesiser's pass cut, per section, measured off the arrays
rather than inferred from the curator's keep-indices. That card reports the cut
rather than what survived: the other four cards already are what survived, so a
kept-count says nothing about the work this role did. The field is absent on
results cached before it existed and whenever the Synthesiser fell back, and the card then
says so instead of claiming that nothing was cut.

The current `analysis_id` is stored in the URL as `?analysis=...`. Reloading the
page replays the retained events once, resumes from the returned cursor, and
does not duplicate Activity entries or token totals. Temporary network failures
use capped exponential reconnect delays and do not mark the workflow failed.
Durable Object records expire after 24 hours; an expired URL returns safely to
the input state with an explicit message.

## Manyfold A2A

Agents are authorized through the Manyfold **connect** handshake, not
configured as ids. `src/connect.ts` runs it:

1. `POST {MANYFOLD_API_BASE_URL}/api/connect/a2a/start` returns a device code, a
   confirmation code, and an authorization URL;
2. the operator approves on Manyfold's own page, ticking which agents to share
   and choosing how many days the grant lasts;
3. `POST {MANYFOLD_API_BASE_URL}/api/connect/a2a/poll` returns one
   single-target External client bearer per approved agent, exactly once.

The device code and the agent bearers are AES-GCM sealed into `CACHE` under the
`connect` purpose and never reach the browser. Each `rpcUrl` Manyfold returns is
checked by `validateA2AUrl` before anything is stored: it must be https, carry
no userinfo, and not resolve to a private or link-local host. Every outbound
A2A request also sets `redirect: 'manual'`. Together those stop a spoofed or
compromised handshake response from replaying a bearer to another host.

There are five roles: `sum`, `ctx`, `synth`, `jargon`, `comments`. `/settings`
maps each to a connected agent; one agent may serve several.
`resolveRuntimeEnv` flattens that map back onto `env.AGENT_*`, so the
orchestrator reads the same fields it always did.

`src/a2a.ts` speaks the protocol and nothing else; `src/crew/mf.ts` holds the
policy. One call is:

1. JSON-RPC A2A `message/stream`, aggregating Task status and artifact updates
   from the SSE response;
2. only if that stream ends after the Task was accepted, recover the same Task
   with at most seven sparse `tasks/get` checks. Never resubmit the prompt
   merely because an accepted Task's stream disconnected — the turn is already
   being billed.

`messageId` is derived from the call id rather than generated per attempt, so a
transport retry cannot buy a second turn.

The Worker admits at most four A2A calls per isolate, below Cloudflare's six
simultaneous outbound-connection limit, and at most two against any single
agent. The per-agent limit exists because connect makes it normal for several
roles to share one agent, which the previous model made impossible. Permits are
taken per-agent first and global second: the other order lets calls queued
behind one saturated agent hold every global permit and stall an agent that
still has capacity. The value of 2 is provisional — `scripts/probe-agent-concurrency.mjs`
measures the real answer, and it bills real turns, so it is run by hand.

Free Workers allow 50 external subrequests per invocation. Each orchestration
gives all A2A calls one shared 30-request budget and reserves the other 20 for
article resolution and other upstream work. A call now costs one subrequest on
the happy path; under the old peer-mint model it cost two. Budget exhaustion is
an explicit agent failure, so the fallback/retry policy runs before Cloudflare
starts rejecting unrelated fetches. See Cloudflare's
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Wrangler limits configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits).

Calls default to two attempts with bounded exponential backoff and `Retry-After`
support. HTTP 408/409/425/429, 5xx, network errors, timeouts, and temporary
runtime failures retry; invalid requests and permanent protocol errors fail
fast. Calls use a 240-second per-attempt budget, based on observed hosted-agent
first-token latency.

A credential problem is terminal, not retryable. An HTTP 401 used to invalidate
a short-lived minted token and retry; a connect bearer is issued once, so
there is nothing to refresh. The agent is marked unverified for `/settings` and
the call throws `ReconnectRequiredError`, which `analysis-task.ts` recognises by
identity so the queue's 30 retries cannot hammer a revoked credential for hours.
A job whose critical roles hold a credential expiring within 30 minutes is
refused before it is queued, rather than spending twelve minutes producing an
all-fallback report.

Once a remote Task has been accepted, an application timeout does not submit a
duplicate: the exact Task is canceled best-effort and the role/workflow fallback
policy decides the next step.

Comments are ranked and token-capped locally, then sent to the reduce agent in
one call. The previous 8–12 map fan-out paid the hosted runtime startup latency
repeatedly and could exhaust the Queue invocation before verdict and synthesis
ran.

With no agents connected the app runs in mock mode and serves local fallback
results. That is the state immediately after a fresh deploy.

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
