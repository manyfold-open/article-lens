# Article Lens 📰

A bilingual (中-first / EN-on-demand) article reading companion,
deployed as a single Cloudflare Worker. Paste a HN link, any article URL, or some
text → a pixel-art "office" of agents reads it and produces a verdict, plain-language
jargon, a summary, and (for HN threads) a comment digest.

Long-running analysis uses an application-owned workflow engine: a per-job
Durable Object persists state and leases, while a Queue consumer executes the
Manyfold A2A crew. It does not depend on Cloudflare Workflows.

**Live:** https://mf-article-lens.netmind-ai.workers.dev

## Quick start

```bash
npm install
npm run dev
```

For local access to the admin configuration page, copy `.dev.vars.example` to
an uncommitted `.dev.vars` file and replace the placeholder:

```dotenv
ADMIN_SETTINGS_PASSWORD=choose-a-long-random-password
```

Then open `http://localhost:8787/settings`. Runtime Manyfold and agent settings
can be managed there; set the required six-digit **Application access
passcode** before opening the main app. Existing Wrangler variables remain
initial/fallback values.

## Commands

| command | what it does |
|---|---|
| `npm run dev` | run locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | run deterministic unit and integration-style tests |
| `npm run test:coverage` | run tests with Node's source coverage report |
| `npm run check` | typecheck, tests, docs links, browser syntax, and repository integrity |
| `npm run check:worker` | build the Worker with Wrangler without publishing |
| `npm run smoke` | verify the access gate and, with `ARTICLE_ACCESS_PASSCODE`, the live endpoints |

Production deployment is owned by
[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml): a push to `main`
or a manual workflow dispatch validates and deploys the Worker, then runs the
live smoke checks. The GitHub `production` environment must provide
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
`ADMIN_SETTINGS_PASSWORD`. There is no local production deploy script.

Bump `SPEC_VERSION` in `wrangler.toml` when changing generated results so old
KV entries are not reused.

## Layout

- `src/index.ts` — small Cloudflare Worker entrypoint and route dispatch only.
- `src/routes/` — one module per API concern: analysis, front page, definitions,
  translation, and agent health.
- `src/crew/` — Manyfold A2A client, orchestration, JSON repair, and offline fallback.
- `src/workflow/` — durable job state machine and Queue task consumer.
- `src/admin/` — password session, encrypted runtime settings, and config merge.
- `src/cache.ts`, `src/http.ts`, `src/hash.ts` — shared infrastructure helpers.
- `src/hn.ts`, `src/extract.ts`, `src/stream.ts`, `src/schema.ts` — data sources,
  extraction, SSE transport, and contracts.
- `public/` — browser UI, Workflow Inspector, access/settings pages, and pixel office.
- `docs/` — architecture, agent orchestration, and operations references.
- `scripts/validate-repository.mjs` — local docs/public integrity checks.
- `scripts/smoke-production.sh` — deployed endpoint verification.
- `.github/workflows/deploy.yml` — the only production deployment entrypoint.

## Endpoints

`GET /api/analyze?id=|url=|text=` (SSE) · `POST /api/analyses` ·
`GET /api/analyses/:id/status` · `POST /api/translate` · `POST /api/define` ·
`GET /api/frontpage` · `GET /api/health` (agent up/down + latency). Application
and API routes require the access session created by `POST /api/access/login`.

The six-digit visitor gate is available at `GET /access`. Its passcode is
configured in the password-protected admin UI at `GET /settings`.

## More

See the **[documentation index](./docs/README.md)** for architecture, caching,
orchestration, the pixel office, and deployment details.
