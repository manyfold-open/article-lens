# Article Lens — operations

This document covers local setup, runtime configuration, validation, production
deployment, and operational safeguards.

**Production:** https://mf-article-lens.netmind-ai.workers.dev

For runtime internals and APIs, see [Architecture](./architecture.md). For agent
graph behavior, see [Agent orchestration](./agent-orchestration.md).

## Local setup

Install dependencies and create the local secret file:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Set a long random `ADMIN_SETTINGS_PASSWORD` in `.dev.vars`, then open
`http://localhost:8787/settings`. The real `.dev.vars` is ignored by Git and
must never be committed.

## Runtime settings

`/settings` manages application-level values:

- the six-digit application access passcode;
- result `SPEC_VERSION`;
- the Manyfold connection: which agents are connected and which role each serves.

Cloudflare assets, KV, Durable Objects, and Queue bindings stay in
`wrangler.toml` and appear as read-only infrastructure in the UI.

The settings session lasts eight hours in an `HttpOnly`, `SameSite=Strict`
cookie. Writes are same-origin only. Saved values are AES-GCM encrypted in
`CACHE`; the encryption key is derived from `ADMIN_SETTINGS_PASSWORD`. Secret
fields are never returned to the browser.

Wrangler variables and secrets are bootstrap/fallback values. A saved setting
overrides its environment equivalent for HTTP and Queue work.
Clearing a saved field returns it to the environment fallback.

## Connecting Manyfold agents

A fresh deployment has no agents and serves local mock results. Analyses will
look plausible and be entirely local, so do this before trusting any output.

1. open `/settings` and sign in with `ADMIN_SETTINGS_PASSWORD`;
2. click **Connect Manyfold agents**. A Manyfold authorization page opens and
   the settings page shows a confirmation code;
3. **check that Manyfold displays the same confirmation code.** That comparison
   is the only anti-phishing check in this flow;
4. tick the agents to share and choose how long the grant lasts. Prefer a
   generous window: there is no refresh, and an expiring grant blocks new jobs;
5. approve. The page picks up the credentials within a couple of seconds and
   assigns the five roles;
6. review the role assignments. One agent may serve several roles, but note
   that five roles on one agent run slower against the same fixed 12-minute
   budget. The page says so when that is the case.

Agent bearers are AES-GCM sealed into `CACHE` and never reach the browser.

There is no migration from the old `agt_*` settings. A peer id from the
previous model and a connect agent id are different id spaces, so reusing the
saved values would fail at run time with a misleading cause.

### Reconnecting

An authorization that has expired, been revoked on Manyfold, or is rejected by
the agent cannot be refreshed from this side. `/settings` marks the agent
unverified, `GET /api/health` reports it down, and new jobs are refused with
`RECONNECT_REQUIRED` rather than being allowed to spend twelve minutes
producing an all-fallback report. Re-running the connect flow and approving the
same agent rotates its token in place.

### Password rotation

Changing `ADMIN_SETTINGS_PASSWORD` changes session signing, the settings
encryption key, **and the key that agent credentials are sealed with**. After
rotating it the stored credentials cannot be read and every agent must be
connected again. Before rotating it, ensure required values exist as Worker
secrets. After rotation, sign in to `/settings` and save all runtime values
again. Undecryptable saved settings are ignored with a warning.

## Application access

Article Lens enforces its six-digit `ACCESS_PASSCODE` server-side. Successful
entry creates a seven-day `HttpOnly`, `SameSite=Strict` cookie signed with
`ADMIN_SETTINGS_PASSWORD`. Changing the passcode immediately invalidates older
visitor sessions.

Failed entries are limited to five attempts per source address in ten minutes.
Unauthenticated APIs return JSON `401`; page navigation redirects to
`/access?next=...`. The lock button clears the visitor session.

## Validation commands

| Command | Scope |
|---|---|
| `npm run typecheck` | TypeScript contracts |
| `npm test` | access/settings security, A2A protocol, extraction, graph, and Workflow model |
| `npm run test:coverage` | Node source coverage for the exercised modules |
| `npm run check:repo` | Markdown links, public assets, duplicate IDs, DOM references |
| `npm run check:browser` | browser JavaScript syntax |
| `npm run check:scripts` | shell syntax |
| `npm run check` | all local checks above |
| `npm run check:worker` | Wrangler production bundle dry-run |
| `npm run smoke -- [url]` | deployed access, analysis, translation, definition, health |

After visual changes, inspect the pixel office manually on desktop and mobile.

The repository scripts have one responsibility each:

- [`scripts/validate-repository.mjs`](../scripts/validate-repository.mjs)
  performs deterministic local repository integrity checks without network
  access.
- [`scripts/smoke-production.sh`](../scripts/smoke-production.sh) verifies a
  deployed Worker. It never deploys.

To include authenticated endpoint checks:

```bash
ARTICLE_ACCESS_PASSCODE=123456 npm run smoke -- \
  https://mf-article-lens.netmind-ai.workers.dev
```

Without `ARTICLE_ACCESS_PASSCODE`, smoke still verifies the redirect, access
page, and server-side readiness, but skips protected endpoints.

## Cloudflare bindings

Bindings are declared in `wrangler.toml`:

- `ASSETS` — browser files;
- `CACHE` — result, health, rate-limit, and encrypted settings data;
- `ANALYSIS_JOBS` — `AnalysisJob` Durable Objects;
- `ANALYSIS_TASK_QUEUE` — producer for `mf-article-lens-analysis`;
- Queue consumer — batch size 1, maximum concurrency 2;
- `MANYFOLD_API_BASE_URL`, `ENVIRONMENT`, and `SPEC_VERSION` values.

## Production deployment

Production deployment is only through
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). A push to
`main` or a manual dispatch:

1. installs locked dependencies;
2. runs `npm run check` and `npm run check:worker`;
3. creates `mf-article-lens-analysis` if needed;
4. deploys `mf-article-lens`;
5. writes `ADMIN_SETTINGS_PASSWORD` through Wrangler standard input;
6. runs the production smoke test.

The GitHub `production` environment requires:

- `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID`;
- `ADMIN_SETTINGS_PASSWORD`;
- optionally, `ARTICLE_ACCESS_PASSCODE` for authenticated smoke checks.

Scope the Cloudflare token to the intended account with Workers Scripts,
Durable Objects, KV, and Queues permissions. The admin password must match the
value used to encrypt shared KV settings. The Workflow never writes secret
values to the repository or logs.

`mf-article-lens` has a separate Durable Object namespace and Queue from the
former `hn-lens-v2` deployment. It intentionally reuses the configured KV
namespace so settings and reusable caches can carry over. This repository does
not delete old cloud resources.

Do not restore local deploy scripts or an npm deploy command. Local commands
stop at `npm run check:worker`.

## Observability and safeguards

- `GET /api/health` probes each connected agent with a non-billing `tasks/get`;
  `?live=1` forces a refresh without starting model turns. It reports
  `total: 0` when nothing is connected, which means mock mode, not health.
- Keep Queue `max_concurrency` low until production latency, provider quotas,
  and backlog are measured.
- Bump `SPEC_VERSION` after result-generation changes so stale KV results are
  not reused.
- Never place admin passwords, Manyfold or Cloudflare tokens, article content,
  or agent output in TOML, logs, or Queue message bodies.
