# HN Lens — Handover

A bilingual (中-first / EN-on-demand) Hacker News reading companion, deployed as a
single Cloudflare Worker. A pixel-art "office" of agents reads a HN thread (or any
article URL / pasted text) and produces: a verdict, plain-language jargon, an article
summary, and a comment digest. This doc is for a second agent (e.g. Codex) picking up
the project alongside the original Claude agent.

**Live:** https://hn-lens.zack-chen.workers.dev
**Latest checkpoint:** v22 (`sprite-env checkpoints list` to see all; `restore <id>` to roll back)

---

## 1. Run / build / deploy

```bash
npm run typecheck          # tsc --noEmit (run before every deploy)
node --check public/app.js public/pixel.js   # front-end is plain JS, no bundler
npm run dev                # wrangler dev --port 8787 (local)

# Deploy (Cloudflare token lives in .env as CLOUDFLARE_API_TOKEN):
export $(grep -v '^#' .env | xargs)
npx wrangler deploy
```

- **Before deploying:** kill any running `wrangler dev` / `workerd` (deploy was OOM-killed
  once while dev was running).
- `public/*` are static assets served by the Worker; `src/*` is the Worker itself.
- There is **no test suite**. Verify by: typecheck, `node --check`, then `curl` the SSE
  endpoints (see §6) and open the live site.
- **No headless browser in this VM** — the canvas office can't be screenshotted here;
  pixel changes must be eyeballed by the human on the live site. Pathfinding/logic can be
  validated with small Node scripts (see git history / examples in chat).

## 2. Architecture

```
src/
  index.ts          router + handlers: GET /api/frontpage, GET /api/analyze (SSE),
                    POST /api/define, POST /api/translate; input resolution; KV caching
  hn.ts             Algolia fetch (item + front page), searchHNByUrl, parseHNUrl
  extract.ts        article readability extraction (extractArticle / extractFromUrl)
  schema.ts         all types: HNLensResult, BiStr, SSEEvent union, Env bindings
  stream.ts         SSE helpers (createSSEStream / sseResponse)
  crew/
    orchestrator.ts THE analysis pipeline (real Manyfold agents) — see §4
    mock.ts         offline fallback (authored glossary + heuristics from real HN data)
    mf.ts           how the stateless Worker calls Manyfold agents (mints per-peer token)
    json.ts         parseLoose() — tolerant JSON repair for LLM output
public/
  index.html        the 3-phase UI + all CSS (office stage, chat dock, report panels)
  app.js            phase state machine, SSE client, KB, office-control wiring, translate
  pixel.js          the canvas office: tilemap + A* + character FSM + sim + rendering
mockup/index.html   original static design reference
wrangler.toml       bindings: KV (CACHE), ASSETS, vars (agent ids, MF_API_URL, SPEC_VERSION)
```

**Data contract:** every user-facing string is `BiStr = {en, zh}`. Agents now fill **zh
only** (en starts `""`); English is fetched lazily client-side via `/api/translate`.

## 3. Deploy facts / secrets

- CF account `zack.chen@netmind.ai`. Worker `hn-lens`. KV `CACHE` id
  `6c7d1cf1c14042639cc5b9d13b09e013` (preview `66e881a0976b4ab0afeb88e7e5fccc6f`).
- `MF_API_TOKEN` is a **wrangler secret** (the agent identity token; needs `a2a:edit`
  granted via `mf auth ensure`). If absent, the app runs entirely on the mock adapter.
- Agent ids + `MF_API_URL` (`https://api-staging.manyfold.ai/api`) are vars in
  `wrangler.toml`. `MF_API_URL` already includes `/api` — do not double it.
- `SPEC_VERSION` is a cache-buster: **bump it in wrangler.toml** after changing
  result-generation logic to invalidate old cached analyses.

## 4. The analysis pipeline (`src/crew/orchestrator.ts`)

`orchestrateAnalysis(item, articleText, itemType, env, emit, opts)`:

1. emits `plan`.
2. **Stage 1 (parallel):** 小摘 summary · 小詞 jargon (KB-aware) · 小潛 comments.
3. **Stage 2:** 小導 verdict — runs AFTER stage 1 and is **fed the summary + comment
   overview** so the verdict reflects real content (not just point count).
4. **Synthesizer (統整):** integration + QA — reviews everything and PRUNES (drops
   non-jargon, near-duplicate camps, redundant key points) via keep-indices; never
   re-emits content (so it can't lose data). Writes `editor_note`.

Each agent emits, as soon as it finishes:
- `status` (running/done) — drives the pixel worker + ✓ animation
- `section` `{agent, data}` — the panel populates immediately (progressive streaming)
Then a final `result` replaces the streamed content with the curated version.

**KB as input:** the client sends saved terms (`?kb=` comma list); 小詞 skips terms the
user already knows and hard-filters them out.

**Comment input:** `topSubtrees` / `rankedCommentsText` prioritise high-signal comments
(replies + length + original position) and budget by **tokens** (~2.5 chars/token), not
fixed char counts.

**Fallback:** `index.ts` uses the real crew only if `MF_API_TOKEN` is set; on ANY throw it
falls back to `mockOrchestrate` (`mock.ts`) which builds a never-empty result from real HN
data + an authored bilingual glossary.

## 5. Caching (in `src/index.ts`)

Per input there is a `cacheKey` (HN id, or url-hash, or text-hash). Three KV entries:
- `${cacheKey}:shared`     → {summary, comment_digest, verdict}  (KB-independent)
- `${cacheKey}:j:${kbHash}` → jargon[]                            (KB-specific)
- `${cacheKey}:${kbHash}`   → full result                         (fast path)

On request: full-cache hit → replay instantly; else reuse cached shared/jargon and only
compute what's missing (orchestrator `opts.cachedShared` / `opts.cachedJargon`).

## 6. SSE / endpoints quick test

```bash
# analyze (text input, with KB): expect plan → section(sum/comments/ctx/jargon) → result
curl -sN --max-time 70 "https://hn-lens.zack-chen.workers.dev/api/analyze?text=...&kb=pgvector" \
  | grep -oE '"event":"[a-z]+"|"agent":"[a-z]+"'
# translate (zh→en)
curl -s -X POST .../api/translate -H 'Content-Type: application/json' -d '{"zh":["向量資料庫"]}'
# define a term (Ask 小詞)
curl -s -X POST .../api/define -H 'Content-Type: application/json' -d '{"term":"HNSW"}'
```

## 7. The pixel office (`public/pixel.js`) — orientation

Top-down tile office (20×12, TILE=16). Subsystems: tilemap + walkable grid, A* pathfinding,
per-character FSM (idle/walking/assigning/working/reporting/returning/presenting + ambient),
a `sim` controller that mirrors the real workflow, and a Y-sorted renderer.

- Stations (seat/desk/approach tiles) in `STATIONS`; 隊長 top-left, 合成 directly below it.
- Choreography: 隊長 assigns each worker → 小摘/小詞/小潛 hand drafts to 合成 → 合成 reviews →
  delivers final to 隊長 → 隊長 walks to the **whiteboard** (beside it) to "present", which
  triggers `presentHandler()` → app reveals the report.
- Office controls are folded into the scene via transparent focusable overlay buttons
  (`#kb-hit` = bookshelf → KB drawer; `#lang-hit` = wall sign → cycle 中/EN). Pointer +
  hover + title tooltip + keyboard + mobile all work.
- Public API: `init, setAgentState, setSpeechBubble, celebrate, startRun, setClickHandler,
  setSelected, setPresentHandler, setKbCount, setLang, flyBook, reset, agents`.
- Bottom-right "dining corner": coffee machine + water cooler + an **animated** yellow
  mascot plushie. Idle agents do ambient errands (coffee/snack/water/email/chat).
- `prefers-reduced-motion`: no walking; static state reflection.

## 8. UI flow (`public/app.js`)

`input` (chat dock under the office) → `running` (office only; choreography) → on first
`section`, the report reveals and panels populate live → `result` swaps in the curated
final. Office = navigation hub: clicking a teammate opens that section
(小摘→summary, 小詞→jargon, 小潛→comments, 小導→context/editor). Slim verdict bar is always
visible. Jargon = expandable pill chips; terms already in the KB show greyed + 已會.
Default language = 中; switching to EN lazily fetches translations and caches them
client-side (`transCache`).

## 9. Known state / open ideas (not bugs unless noted)

- English is on-demand; if `/api/translate` fails it echoes zh (so EN mode still shows
  text). The mock fallback is already bilingual.
- `comment_digest` rendered from a `section` (pre-result) passes `flags={}`; the final
  `result` re-render has real flags (e.g. `no_discussion`).
- Possible follow-ups discussed with the user: pre-warm cron for the front page, KB cloud
  sync, more office polish, Reddit/Lobsters sources.

## 10. Repo, deploy gate & collaboration

**Git repo:** https://github.com/tldr0810/article-lens (private, branch `main`). Clone it,
branch, open PRs — work off the repo, not by editing a shared workspace (two agents
editing the same file collided badly before).

**Safe deploy (use this, not bare `wrangler deploy`):**
- `npm run ship "message"` → runs `deploy.sh`: typecheck → `node --check` (front-end) →
  `wrangler deploy` → `npm run smoke` (live) → checkpoint. It **refuses to checkpoint if
  smoke fails**, so you can't silently ship a broken build.
- `npm run smoke [baseUrl]` → asserts `/api/analyze` (plan→result, ≥1 jargon term),
  `/api/translate`, `/api/define`, `/api/health`. Needs the analyze text to be ≥220 chars
  (the captain skips jargon on short/non-technical input — that's expected).
- `CLOUDFLARE_API_TOKEN` comes from `.env` (gitignored — set it locally).
- Bump `SPEC_VERSION` in `wrangler.toml` whenever you change result-generation logic, or
  old cached analyses keep serving (we hit this).

**Observability:** `GET /api/health` pings all 6 crew agents (up/down + latency), refreshed
by the cron; `?live=1` re-runs. Use it when an agent looks flaky.

**Coordination:** only one agent deploys at a time; say which files you're touching.
Product priorities (build spec): jargon explanation is the #1 feature; comment digest #2;
the live pixel office is a feature, not a loading screen; Chinese-first, English on demand.
