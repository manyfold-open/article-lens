# HN Lens 📰

A bilingual (中-first / EN-on-demand) Hacker News & article reading companion,
deployed as a single Cloudflare Worker. Paste a HN link, any article URL, or some
text → a pixel-art "office" of agents reads it and produces a verdict, plain-language
jargon, a summary, and (for HN threads) a comment digest.

**Live:** https://hn-lens.zack-chen.workers.dev

## Quick start

```bash
npm install
cp .env.example .env        # then put your CLOUDFLARE_API_TOKEN in .env
npm run dev                 # local: wrangler dev on :8787
```

## Commands

| command | what it does |
|---|---|
| `npm run dev` | run locally (`wrangler dev`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run smoke` | hit the live endpoints and assert basic health |
| `npm run ship "msg"` | **safe deploy**: typecheck → check → deploy → smoke → checkpoint |

> Use `npm run ship`, not a bare `wrangler deploy` — it refuses to finish if the
> live smoke test fails. Bump `SPEC_VERSION` in `wrangler.toml` when you change
> result-generation logic (otherwise stale analyses stay cached).

## Layout

- `src/` — the Cloudflare Worker (router, HN/Algolia fetch, extraction, the agent
  crew in `src/crew/`, SSE streaming, schema).
- `public/` — the front-end: 3-phase UI (`index.html`/`app.js`) and the pixel office
  (`pixel.js`).
- `scripts/smoke.sh`, `deploy.sh` — the verify/deploy gate.

## Endpoints

`GET /api/analyze?id=|url=|text=` (SSE) · `POST /api/translate` · `POST /api/define` ·
`GET /api/frontpage` · `GET /api/health` (agent up/down + latency).

## More

See **[HANDOVER.md](./HANDOVER.md)** for the full architecture, the analysis pipeline,
caching, the pixel office, deploy details, and collaboration rules.
