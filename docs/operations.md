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
- Manyfold API URL, source agent, and API token;
- result `SPEC_VERSION`;
- all six role-agent IDs.

Cloudflare assets, KV, Durable Objects, and Queue bindings stay in
`wrangler.toml` and appear as read-only infrastructure in the UI.

The settings session lasts eight hours in an `HttpOnly`, `SameSite=Strict`
cookie. Writes are same-origin only. Saved values are AES-GCM encrypted in
`CACHE`; the encryption key is derived from `ADMIN_SETTINGS_PASSWORD`. Secret
fields are never returned to the browser.

Wrangler variables and secrets are bootstrap/fallback values. A saved setting
overrides its environment equivalent for HTTP and Queue work.
Clearing a saved field returns it to the environment fallback.

### Password rotation

Changing `ADMIN_SETTINGS_PASSWORD` changes both session signing and the settings
encryption key. Before rotating it, ensure required values exist as Worker
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
- `MF_API_URL`, `MF_AGENT_ID`, `AGENT_*`, and `SPEC_VERSION` bootstrap values.

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

- `GET /api/health` reports peer credential availability; `?live=1` forces a
  refresh without starting model turns.
- Keep Queue `max_concurrency` low until production latency, provider quotas,
  and backlog are measured.
- Bump `SPEC_VERSION` after result-generation changes so stale KV results are
  not reused.
- Never place admin passwords, Manyfold or Cloudflare tokens, article content,
  or agent output in TOML, logs, or Queue message bodies.
