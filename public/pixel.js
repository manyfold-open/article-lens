/**
 * pixel.js — HN Lens pixel office simulation (top-down)
 *
 * A living Metro-City-style office rendered procedurally on a Canvas (no asset
 * files). Four subsystems:
 *   1. Tilemap      — floor / walls / furniture / walkable grid.
 *   2. A* pathfind  — characters route through corridors, avoiding furniture.
 *   3. Character FSM — idle → walking → assigning → working → reporting → returning.
 *   4. Task sim      — real SSE task-state drives one closed loop:
 *        Leader walks to 小词, assigns, returns; 小词 works; on done walks to the
 *        Leader, reports, returns to its seat. Hybrid pacing: movement runs on
 *        the sim clock, "working" ends on the real `done` event but never before
 *        MIN_WORK frames, so cached (~260ms) and live (~5-12s) both play fully.
 *   The other three workers stay seated and reflect their own SSE state.
 *
 * Exports window.pixelAgents (init/setAgentState/setSpeechBubble/celebrate/reset/
 * startRun/agents).
 */
(function () {
  'use strict';

  // ─── i18n ───────────────────────────────────────────────────────────────────
  // langMode is only ever 'en' or 'zh' in practice (see LANG_CYCLE in app.js —
  // "no bilingual"); default to 'en' for any stale/unexpected value.
  // NOTE: named LZ (not L) because `L` is used pervasively below as a local
  // alias for the orchestrator character (`const L = chars.orch`) — a same-name
  // helper would be shadowed silently in those scopes.
  function LZ(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v[langMode] ?? v.zh ?? v.en ?? '';
  }

  // ─── Grid / layout ──────────────────────────────────────────────────────────
  const SCALE = 3;
  const TILE  = 16;
  const COLS  = 20;
  const ROWS  = 12;
  const WALL  = 2;                       // top rows = wall
  const LOGICAL_W = COLS * TILE;          // 320
  const LOGICAL_H = ROWS * TILE;          // 192

  const SPEED  = 1.03;                    // idle/ambient walking speed
  const WORK_SPEED = 1.38;                // task deliveries + final presentation move with intent
  const RUSH_SPEED = 2.15;                // new assignment: everyone hustles back (~+13% over original 1.9)
  const ASSIGN = 70;                      // frames a talk holds
  const REPORT = 80;
  const MIN_WORK = 150;                   // min visible "working" frames

  // Ambient "office life" when no analysis is running (game-NPC behaviour).
  const KITCHEN_TILE = [17, 8];           // stand here for coffee (dining corner)
  const SNACK_TILE   = [15, 10];          // by the dining table
  const COOLER_TILE  = [17, 9];           // by the water cooler (dining corner)
  const AMB_MIN = 260, AMB_RAND = 620;    // frames between ambient actions
  const AMB_DO  = 130;                    // frames spent doing an action

  // ─── Palette ────────────────────────────────────────────────────────────────
  const FLOOR='#D9BA92', FLOOR2='#D0AE83', SEAM='#BE9669';
  const WALLC='#C7BBA6', WALLHI='#D7CDBB', WALLLO='#B0A488', BASEB='#8C7C5E';
  const WOOD='#B98C5A', WOODHI='#D2A974', WOODLO='#90683D';
  const DESK='#C49A6B', DESKHI='#DCBA8B', DESKLO='#9C7445';
  const MON='#23201C', SKIN='#F1C9A1', SKINSH='#D8A578', DARK='#241F1B';
  const LABEL='#6B6256', ACCENT='#FF6600';
  const RUG='#6FB7AE', RUGE='#3E8C84', SOFA='#7C8AA6', SOFAHI='#9AA6BE';
  const SHADOW='rgba(0,0,0,0.13)';

  // ─── Roles + stations (seat tile; desk = seat+below; approach = beside) ──────
  const ROLE = {
    orch:     { name:{ zh:'队长', en:'Orchestrator' }, shirt:'#FF6600', hair:'#3F3F46', acc:'lead',    role:{ zh:'分派任务、最后带你看报告', en:'Assigns tasks, walks you through the report at the end' } },
    sum:      { name:{ zh:'小摘', en:'Summariser' },   shirt:'#3B82F6', hair:'#5B3A29', acc:'doc',     role:{ zh:'抓文章重点与 TL;DR', en:'Extracts key points & TL;DR' } },
    jargon:   { name:{ zh:'小词', en:'Jargon' },       shirt:'#F59E0B', hair:'#6B4423', acc:'bulb',    role:{ zh:'挑出术语，白话解释', en:'Picks out jargon, explains it plainly' }, glasses:true },
    comments: { name:{ zh:'小潜', en:'Comments' },     shirt:'#14B8A6', hair:'#1F2937', acc:'phones',  role:{ zh:'潜入留言，整理派系', en:'Dives into comments, sorts the factions' } },
    ctx:      { name:{ zh:'小导', en:'Context' },      shirt:'#8B5CF6', hair:'#7C2D12', acc:'stamp',   role:{ zh:'帮你判断这篇该略读、速读还是深读', en:'Helps you decide: skim, skip, or dive deep' } },
    synth:    { name:{ zh:'合成', en:'Synthesiser' },  shirt:'#EC4899', hair:'#4B5563', acc:'printer', role:{ zh:'校稿整合，删掉杂讯', en:'Proofreads & integrates, cuts the noise' } },
  };
  const STATIONS = [
    { id:'orch',     seat:[3,3],  approach:[4,3]  },
    { id:'sum',      seat:[8,3],  approach:[9,3]  },
    { id:'jargon',   seat:[12,3], approach:[13,3] },
    { id:'comments', seat:[8,7],  approach:[9,7]  },
    { id:'ctx',      seat:[12,7], approach:[13,7] },
    { id:'synth',    seat:[3,7],  approach:[4,7]  },   // directly below 队长
  ];
  const deskOf = s => [s.seat[0], s.seat[1] + 1];

  // ─── Layout engine zones (spec → office arrangement) ────────────────────────
  // The office is DERIVED from the workflow spec: agents are auto-arranged into a
  // left→right pipeline so you can read the workflow at a glance. Bands are given
  // as [col,row] tile centres on the 20×12 grid; positions are converted to the
  // logical-px worker centre (tile*TILE + 8). These are tuned to sit in the open
  // floor (rows 3–7) and dodge the wall furniture / dining corner on the right.
  //
  //   [休息区 rest]  [读者区 readers]  [裁定 ctx]  [校对 synth]  [白板 board]
  //     cols 1–3        cols 5–9        col 11       col 14        col 17
  //
  // Scope note: FIRST BATCH only — parallel (separate desks), group (shared
  // table), disabled (sleep), L→R zones, doc-flow, effort desk size. Hooks are
  // left for later (relay conveyor / vote-clone / conditional-escalate).
  const ZONE = {
    rest:    { cols: [1, 3],   row: 9  },   // sofa area; benched agents sleep here
    readers: { cols: [5, 9],   row: 5  },   // stage-1: sum / jargon / comments
    ctx:     { col: 11,        row: 5  },   // 裁定 verdict desk
    synth:   { col: 14,        row: 5  },   // 校对 QA desk
    board:   { col: 12,        row: 2  },   // whiteboard (to the right of 队长)
    orchseat:{ col: 9,         row: 2  },   // 队长 overseer spot, center-top
  };
  // Rest-area slots for benched/disabled agents. The rest area IS the bottom-right
  // dining corner now (no separate 休息区). The first two slots are the two
  // 按摩椅 (massage chairs) — a resting agent naps in a chair; extra slots spread
  // nearby so multiple benched agents don't stack. Chosen to dodge the coffee
  // counter [18,8]/cooler [18,9], sofa [14-16,9], table [16,10], plushie/dog/cat
  // [14,10]/[17,10]/[18,10] and the plant [11,10].
  const MASSAGE_CHAIRS = [[12, 10], [13, 10]];   // 按摩椅 tiles (dining corner)
  // Enough distinct nap spots that every sleeper (benched + escalate-standby, up
  // to all 5 workers) gets its OWN tile — no two assigned the same slot, so
  // sleepers never stack. The extra row-11 slots spread along the corner floor.
  const REST_SLOTS = [[12, 10], [13, 10], [12, 11], [13, 11], [14, 11], [15, 11]];
  const centreOf = (col, row) => ({ x: col * TILE + 8, y: row * TILE + 8 });

  // Blocking floor furniture (besides seats/desks).
  const BLOCKED = [
    [15,2],[16,2],[17,2],[18,2],          // kitchen counter
    [14,9],[15,9],[16,9],                 // sofa
    [16,10],                              // coffee table
    [1,10],[6,10],[18,3],[11,10],         // plants
    [18,8],[18,9],                        // dining corner: coffee counter + water cooler
    [12,2],                               // whiteboard easel (beside 队长)
  ];
  const WB_TILE = [12, 2];                // whiteboard easel sits to 队长's right
  const WB_APPROACH = [11, 2];            // 队长 stands beside it to present
  const SHELF_APPROACH = [2, 3];          // 队长 stands here to look up the wordbook

  // ─── Walkable grid ──────────────────────────────────────────────────────────
  const walkable = [];
  for (let r = 0; r < ROWS; r++) { walkable[r] = []; for (let c = 0; c < COLS; c++) walkable[r][c] = r >= WALL; }
  BLOCKED.forEach(([c,r]) => { walkable[r][c] = false; });
  STATIONS.forEach(s => { walkable[s.seat[1]][s.seat[0]] = false; const d = deskOf(s); walkable[d[1]][d[0]] = false; });

  // ─── A* (4-neighbour, Manhattan) ────────────────────────────────────────────
  function h(a, b) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }
  function findPath(start, goal) {
    const key = (c,r) => c + ',' + r;
    const open = [{ c:start[0], r:start[1], g:0, f:h(start,goal), p:null }];
    const closed = new Set();
    while (open.length) {
      let bi = 0; for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur.c === goal[0] && cur.r === goal[1]) {
        const path = []; let n = cur; while (n) { path.unshift([n.c, n.r]); n = n.p; } return path;
      }
      closed.add(key(cur.c, cur.r));
      for (const [dc,dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nc = cur.c + dc, nr = cur.r + dr;
        if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
        if (!walkable[nr][nc] || closed.has(key(nc,nr))) continue;
        const ng = cur.g + 1;
        const ex = open.find(o => o.c === nc && o.r === nr);
        if (ex && ng >= ex.g) continue;
        const node = { c:nc, r:nr, g:ng, f:ng + h([nc,nr], goal), p:cur };
        if (ex) Object.assign(ex, node); else open.push(node);
      }
    }
    return null;
  }

  // ─── Entities ───────────────────────────────────────────────────────────────
  const chars = {};
  STATIONS.forEach(s => {
    chars[s.id] = {
      id: s.id, role: ROLE[s.id], station: s,
      x: s.seat[0]*TILE + 8, y: s.seat[1]*TILE + 8, tile: s.seat.slice(),
      path: null, onArrive: null, facing: 'down', state: 'idle',
      timer: 0, onTimer: null, workStart: 0, bubble: '', statusText: '', _report: '',
    };
  });
  const taskState = {};          // id → 'idle'|'typing'|'reading'|'done'
  const sim = { active: false };
  const runDocs = [];            // result icons flying worker → 合成 (custom run)

  // ─── Edit-office mode (drag workers → pods/modes → graphConfig) ──────────────
  // The user drags the four editable workers, clusters {sum,jargon,comments}
  // into pods, sets each pod's collaboration mode, and benches workers to
  // disable them. The arrangement is serialized into a graphConfig (v1) that the
  // backend consumes. When the layout equals the default (all enabled, the three
  // stage-1 workers in one parallel group), getGraphConfig() returns null and the
  // office behaves byte-for-byte as today.
  const EDITABLE = ['sum', 'jargon', 'comments', 'ctx']; // spec-editable workers (bench/graphConfig source)
  // Which agents the user can freely DRAG in edit mode. This is a SUPERSET of
  // EDITABLE: orch (队长) and synth (合成) are also draggable, but purely for
  // COSMETIC placement — moving them is layout-only and never touches
  // getGraphConfig()/the spec/enabled/hasCustomLayout()'s graph decision (they're
  // infra, not spec nodes). Their positions still persist in localStorage so the
  // office remembers where you put them.
  const DRAGGABLE = ['sum', 'jargon', 'comments', 'ctx', 'orch', 'synth'];
  // Infra agents: draggable + persisted, but not spec nodes (no enable/disable,
  // no bench, excluded from the graphConfig decision).
  const INFRA = ['orch', 'synth'];
  const STAGE1 = ['sum', 'jargon', 'comments'];          // can be podded
  const POD_DIST = TILE * 1.2;                            // cluster radius (logical px)
  const BADGE_DRAG_THRESH = 4;                            // px the badge must move before a click becomes a group-drag
  const GRAPH_LS_KEY = 'alens.graph';
  // Which workers expose an effort knob (low/med/high). ctx/synth have no effort.
  const EFFORT_NODES = ['sum', 'jargon', 'comments'];
  const EFFORT_LEVELS = ['low', 'med', 'high'];
  // Which workers expose a replicas knob (vote ×N: run N times + merge). Only the
  // three stage-1 readers; ctx/synth have no replicas. 1–3, default 1.
  const REPLICA_NODES = ['sum', 'jargon', 'comments'];
  const MAX_REPLICAS = 3;
  const editMode = {
    on: false,
    dragId: null,                 // id currently being dragged
    dragGroup: [],                // other pod members translated with a group drag
    dragLast: null,               // dragged agent's last clamped pos (for delta calc)
    badgeDrag: null,              // active pod-badge grab: {key, members:[ids], moved:bool} — the group move-handle
    badgeDragStart: null,         // {x,y} pointer-down pos, for the click-vs-drag threshold
    bench: Object.create(null),   // id → true when disabled (benched)
    podModes: Object.create(null),// "a,b,c" (sorted) → 'parallel' | 'relay'
    groups: [],                   // fixed multi-agent pods captured when leaving edit mode
    layout: Object.create(null),  // id → {x,y} custom positions (config source of truth)
    effort: Object.create(null),  // id → 'low' | 'med' | 'high' (default 'med')
    replicas: Object.create(null),// id → 2 | 3 (default 1; only stored when >1)
    escalate: false,              // 💸 thrifty: run sum+ctx first, escalate to jargon+comments only if worth it
    escalateCandidates: ['jargon', 'comments'],   // the "on standby" workers in escalate mode
    debate: false,                // 🥊 辩论裁定: 小导 runs 正方/反方 then adjudicates (~3× ctx cost)
    audience: null,               // 受众语气: null=默认(中阶) | 'beginner'=新手 | 'expert'=老手 (orthogonal to presets)
    badges: [],                   // per-frame clickable mode badges {x,y,w,h,key}
    effortBadges: [],             // per-frame clickable effort badges {x,y,w,h,id}
    replicaBadges: [],            // per-frame clickable replica badges {x,y,w,h,id}
  };
  function effortOf(id) { return editMode.effort[id] || 'med'; }
  // Replicas for a node (1 default). Clamped to 1..MAX_REPLICAS; only stage-1
  // readers can carry >1, everything else is always 1.
  function replicasOf(id) {
    if (!REPLICA_NODES.includes(id)) return 1;
    const n = editMode.replicas[id] | 0;
    return n >= 2 ? Math.min(MAX_REPLICAS, n) : 1;
  }

  // ─── Token cost model + meter ───────────────────────────────────────────────
  // Live estimate (before/while tuning) vs actual (accumulated from usage SSE).
  // Calibrated 2026-07-02 against real v2 runs (usage = (prompt+response chars)/2.5,
  // the same basis the meter reports as "actual"). Observed medians on full HN
  // items: sum ~2.4k (text-rich; link-only posts far less), jargon ~3.5k (rich
  // articles up to ~10k), comments ~8k (spot-on), ctx ~0.5k, synth ~1.1k. Prior
  // numbers over-estimated everything but comments by 5–10×, so the meter dropped
  // sharply from estimate→actual. low/high scaled ~proportionally to med.
  const TOKEN_COST = {
    sum:      { low: 1200, med: 2400, high: 3600 },
    jargon:   { low: 2500, med: 5000, high: 8000 },
    comments: { low: 4000, med: 8000, high: 12000 },
    ctx:      { low: 600,  med: 600,  high: 1000 },
    synth:    { low: 1200, med: 1200, high: 1600 },
  };
  // Meter state: 'estimate' shows the live cost model total; 'actual' accumulates
  // the per-agent usage SSE and finalizes from result.usage.total.
  const meter = { mode: 'estimate', actual: 0, byAgent: Object.create(null) };
  // Sum of every enabled node's cost at its current effort. synth counts when the
  // spec would keep it (we treat synth as always enabled here — the FE never
  // benches it), ctx counts when not benched.
  function estimateTokens() {
    let total = 0;
    for (const id of EFFORT_NODES) {
      if (editMode.bench[id]) continue;
      // 💸 escalate: jargon+comments are runtime candidates — exclude them from the
      // cheap floor (they only cost tokens if the backend decides to escalate).
      if (editMode.escalate && editMode.escalateCandidates.includes(id)) continue;
      // vote ×N: running an agent N times costs ~N× its per-run tokens.
      total += TOKEN_COST[id][effortOf(id)] * replicasOf(id);
    }
    // ctx: effort n/a. 🥊 辩论裁定 runs it ~3× (正方 + 反方 + 首席裁判合议).
    if (!editMode.bench.ctx) total += TOKEN_COST.ctx.med * (editMode.debate ? 3 : 1);
    total += TOKEN_COST.synth.med;                          // synth: always on
    return total;
  }
  function fmtK(n) { return '~' + Math.round(n / 1000) + 'k'; }
  function fmtKPlain(n) { return Math.round(n / 1000) + 'k'; }
  // Position used for pod/config math: the user's custom layout if set, else the
  // live entity position. Decoupled from the running sim, which moves chars.
  function posOf(id) { return editMode.layout[id] || chars[id]; }
  // True when the user has any custom arrangement saved that affects the SPEC
  // (positions of spec-node workers / bench / modes / effort / replicas /
  // escalate). Infra agents (orch/synth) may carry drag-position overrides in
  // editMode.layout too, but those are cosmetic-only and MUST NOT count here —
  // otherwise merely nudging 队长/合成 would flip getGraphConfig() non-null and
  // start emitting &graph. So we only look at EDITABLE layout overrides.
  function hasCustomLayout() {
    return EDITABLE.some(id => !!editMode.layout[id])
      || Object.keys(editMode.bench).length > 0
      || Object.keys(editMode.podModes).length > 0
      || EFFORT_NODES.some(id => effortOf(id) !== 'med')    // non-default effort counts
      || REPLICA_NODES.some(id => replicasOf(id) > 1)       // vote ×N counts
      || editMode.escalate                                  // 💸 thrifty escalate mode counts
      || editMode.debate                                    // 🥊 debate verdict counts
      || !!editMode.audience;                               // 受众语气 (新手/老手) counts
  }
  // Latched per-run so the choreography stays consistent for the whole run even
  // if state changes mid-run; set in startRun(). customRunActive() gates the
  // run LOGIC (finish detection, asleep guards) and is true only while active;
  // customRunView() gates the RENDERING (traveling desks, pods, docs) and stays
  // true through the present finale so placement doesn't snap back mid-reveal.
  function customRunActive() { return sim.active && sim.customRun; }
  function customRunView() { return !!sim.customView; }
  // The office is now ALWAYS spec-driven: desks/nameplates/pods travel with the
  // agents' computed positions (not fixed furniture tiles), whether idle,
  // reshuffling, or mid-run. layoutView() is the master switch the renderer uses.
  // (customRunView stays for the run finale's doc/pod extras.)
  function layoutView() { return true; }
  // Disable drop-zone: a small rectangle around the two 按摩椅 (massage chairs) in
  // the bottom-right dining corner. A worker dropped on/near here is disabled and
  // naps in a chair; dropped anywhere else it's just placed (enabled). Chairs sit
  // at MASSAGE_CHAIRS tiles [12,10]/[13,10]; the zone spans those two tiles plus a
  // little margin so an imprecise drop still lands. Logical (px) coords.
  const REST_ZONE = {
    x: T(MASSAGE_CHAIRS[0][0]) - 6,
    y: T(MASSAGE_CHAIRS[0][1]) - 8,
    w: (MASSAGE_CHAIRS[1][0] - MASSAGE_CHAIRS[0][0] + 1) * TILE + 12,
    h: TILE + 14,
  };
  function inRestZone(x, y) {
    return x >= REST_ZONE.x && x <= REST_ZONE.x + REST_ZONE.w
        && y >= REST_ZONE.y && y <= REST_ZONE.y + REST_ZONE.h;
  }
  const pets = {
    pika: { id:'pika', kind:'pika', x:T(18)+8, y:T(10)+10, tile:[18,10], path:null, onArrive:null, facing:'left', state:'idle', timer:80, onTimer:null, bubble:'', card:'' },
    dog:  { id:'dog',  kind:'dog',  x:T(17)+8, y:T(10)+8,  tile:[17,10], path:null, onArrive:null, facing:'left', state:'idle', timer:120, onTimer:null, bubble:'', card:'' },
    cat:  { id:'cat',  kind:'cat',  x:T(14)+8, y:T(10)+8,  tile:[14,10], path:null, onArrive:null, facing:'right', state:'idle', timer:160, onTimer:null, bubble:'', card:'' },
  };
  const PET_LOUNGE = [[18,10],[17,10],[14,10],[15,10],[17,8],[17,9],[2,8],[6,9],[11,9],[13,10]];
  const petQueue = [];

  // ─── Movement ───────────────────────────────────────────────────────────────
  function slideTo(e, tile, cb) { e.path = [tile]; e.onArrive = cb || null; }
  function walkTo(e, destTile, cb) {
    const p = findPath(e.tile, destTile);
    if (!p) { if (cb) cb(); return; }
    e.path = p; e.onArrive = cb || null;
  }
  function faceToward(e, tile) {
    const dx = tile[0] - e.tile[0], dy = tile[1] - e.tile[1];
    e.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }
  function moving(e) { return !!e.walkXY || (e.path && e.path.length > 0); }
  // Free-floating straight-line walk toward a logical-px point (tx,ty). Unlike
  // walkTo (A* over the tile grid) this works from/to the arbitrary computed
  // positions agents occupy during an in-place custom run. pace: idle/task/rush.
  function walkXY(e, tx, ty, cb, pace) {
    e.path = null; e.onArrive = null;
    e.walkXY = { tx, ty, cb: cb || null, pace: pace || 'idle' };
  }

  // ─── Lightweight character collision (no full traffic sim) ──────────────────
  // Two knobs: SEP_DIST is how close two standing/idle sprites may get before we
  // gently push them apart (soft separation); STEER_LOOKAHEAD/STEER_RADIUS govern
  // when a WALKER detours around a *stationary* body sitting in its path. All
  // nudges are small + capped so nothing can be launched off-grid or into walls,
  // and — crucially — every mover (walkXY / A* path / layout walkTarget)
  // recomputes its heading from its LIVE position each frame, so a nudge never
  // breaks convergence: the agent simply resumes its straight line afterwards.
  const SEP_DIST   = 9;     // ~half a tile+; closer than this → push apart
  const SEP_MAX    = 0.7;   // max px a sprite is pushed per frame (smooth)
  const STEER_LOOK = 12;    // px ahead a walker looks for a blocker
  const STEER_RADIUS = 8;   // how close (perp) a body must be to count as in-path
  const STEER_PUSH = 0.9;   // perpendicular velocity added while detouring
  // A character participates in collision only when it's a "real body" on the
  // floor: not asleep (benched/standby nap in the corner as furniture) and not
  // the one being dragged in edit mode.
  function collides(e) { return e && !e.asleep && editMode.dragId !== e.id; }
  // Is `e` effectively holding still this frame (a body to avoid / separate from)?
  function isStationary(e) { return !e.walkXY && !(e.path && e.path.length) && !e.walkTarget; }

  // Steering: while `e` walks along heading (hx,hy) (unit vector), if a stationary
  // body sits just ahead and off to one side, return a small perpendicular {dx,dy}
  // to sidestep it. Returns null when the path is clear. Transient (per-frame) —
  // it never changes the target, so the agent re-converges once past the blocker.
  function steerAround(e, hx, hy) {
    let best = null, bestFwd = Infinity;
    for (const id in chars) {
      const o = chars[id];
      if (o === e || !collides(o) || !isStationary(o)) continue;
      const rx = o.x - e.x, ry = o.y - e.y;
      const fwd = rx * hx + ry * hy;                 // distance ahead along heading
      if (fwd <= 0 || fwd > STEER_LOOK) continue;    // behind us or too far
      const perp = rx * -hy + ry * hx;               // signed sideways offset
      if (Math.abs(perp) > STEER_RADIUS) continue;   // not really in the lane
      if (fwd < bestFwd) { bestFwd = fwd; best = perp; }
    }
    if (best === null) return null;
    // Steer to the side the body ISN'T on (push perp away from it); if dead-centre
    // pick a deterministic side (toward open floor) so two agents don't oscillate
    // into a lock. perp>0 = body to our left → sidestep right, and vice-versa.
    const side = best > 0 ? -1 : (best < 0 ? 1 : (e.x < LOGICAL_W / 2 ? 1 : -1));
    return { dx: -hy * side * STEER_PUSH, dy: hx * side * STEER_PUSH };
  }

  // Soft separation: after everyone has moved, gently push apart any pair of live
  // bodies overlapping within SEP_DIST so nobody ever fully sits on top of another
  // (standing, idle, queued, or mid-handoff). Each pair contributes at most SEP_MAX
  // px of push, split between the two — and a MOVING agent is pushed less than a
  // stationary one so movers keep their line (the stationary body yields). Nudges
  // are clamped to the room so no one is shoved into a wall or off-grid; because
  // every mover re-aims from its live position, this can't cause a soft-lock.
  function separateChars() {
    if (editMode.on) return;
    const ids = Object.keys(chars);
    for (let i = 0; i < ids.length; i++) {
      const a = chars[ids[i]];
      if (!collides(a)) continue;
      for (let j = i + 1; j < ids.length; j++) {
        const b = chars[ids[j]];
        if (!collides(b)) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= SEP_DIST) continue;
        // Overlapping (or exactly coincident): pick a deterministic axis if d≈0.
        if (d < 0.01) { dx = (i < j ? -1 : 1); dy = 0; d = 1; }
        const overlap = SEP_DIST - d;
        const push = Math.min(SEP_MAX, overlap * 0.5);   // gentle, capped
        const nx = dx / d, ny = dy / d;
        // Weight the push toward whichever agent is holding still.
        const aMove = !isStationary(a), bMove = !isStationary(b);
        let aw = 0.5, bw = 0.5;
        if (aMove && !bMove) { aw = 0.15; bw = 0.85; }
        else if (!aMove && bMove) { aw = 0.85; bw = 0.15; }
        a.x = clampX(a.x - nx * push * aw * 2); a.y = clampY(a.y - ny * push * aw * 2);
        b.x = clampX(b.x + nx * push * bw * 2); b.y = clampY(b.y + ny * push * bw * 2);
      }
    }
  }

  function stepEntity(e) {
    if (e.timer > 0) { e.timer--; if (e.timer === 0 && e.onTimer) { const t = e.onTimer; e.onTimer = null; t(); } }
    // Free-floating straight-line walk (used for in-place custom-run human
    // deliveries where positions aren't tile-locked so A* can't be used).
    if (e.walkXY) {
      const w = e.walkXY;
      const dx = w.tx - e.x, dy = w.ty - e.y, d = Math.hypot(dx, dy);
      const sp = w.pace === 'rush' ? RUSH_SPEED : (w.pace === 'task' ? WORK_SPEED : SPEED);
      if (d <= sp) {
        e.x = w.tx; e.y = w.ty; e.tile = [Math.round((e.x - 8) / TILE), Math.round((e.y - 8) / TILE)];
        e.walkXY = null; const cb = w.cb; if (cb) cb();
      } else {
        e.x += dx / d * sp; e.y += dy / d * sp;
        const av = steerAround(e, dx / d, dy / d);           // detour around a body ahead
        if (av) { e.x = clampX(e.x + av.dx); e.y = clampY(e.y + av.dy); }
        e.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      }
      return;
    }
    if (!e.path || !e.path.length) return;
    const [tc, tr] = e.path[0];
    const tx = tc*TILE + 8, ty = tr*TILE + 8;
    const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy);
    const speed = e.state === 'recall' ? RUSH_SPEED : SPEED;
    if (d <= speed) {
      e.x = tx; e.y = ty; e.tile = [tc, tr]; e.path.shift();
      if (!e.path.length) { const cb = e.onArrive; e.onArrive = null; if (cb) cb(); }
    } else {
      e.x += dx / d * speed; e.y += dy / d * speed;
      e.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
  }

  function queuePetCard(agentId, label) {
    petQueue.push({ agentId, label });
    tryPetJobs();
  }

  function tryPetJobs() {
    if (!petQueue.length) return;
    const dog = pets.dog;
    if (moving(dog) || dog.state === 'carry' || dog.state === 'deliver') return;
    const job = petQueue.shift();
    const target = chars[job.agentId];
    if (!target) return;
    dog.state = 'carry'; dog.card = job.label; dog.bubble = LZ({ zh:'汪！', en:'Woof!' });
    walkTo(dog, target.station.approach, () => {
      faceToward(dog, target.station.seat);
      const ackMsg = LZ({ zh:'收到', en:'Got it' });
      dog.state = 'deliver'; dog.bubble = job.label; target.bubble = ackMsg;
      dog.timer = 55;
      dog.onTimer = () => {
        dog.card = ''; dog.bubble = ''; if (target.bubble === ackMsg) target.bubble = ''; dog.state = 'idle';
        dog.timer = 40 + Math.floor(Math.random() * 80);
        tryPetJobs();
      };
    });
  }

  function petTick() {
    tryPetJobs();
    Object.values(pets).forEach(p => {
      if (moving(p) || p.state === 'carry' || p.state === 'deliver') return;
      if (p.timer > 0) return;
      // In a custom run workers sit at arbitrary placed tiles (not their seat
      // approach), so skip the seat-targeted work visit and just let pets wander.
      if (sim.active && !customRunActive() && p.kind !== 'dog') startWorkPetVisit(p);
      else startPetAmbient(p);
    });
  }

  function startWorkPetVisit(p) {
    const active = ALL_WORKERS.filter(id => chars[id].state === 'working' || chars[id].state === 'waiting');
    if (!active.length) { startPetAmbient(p); return; }
    const target = chars[active[Math.floor(Math.random() * active.length)]];
    p.state = 'visit'; p.bubble = p.kind === 'cat' ? LZ({ zh:'喵？', en:'Meow?' }) : 'pika!';
    walkTo(p, target.station.approach, () => {
      faceToward(p, target.station.seat);
      const visitMsg = p.kind === 'cat' ? LZ({ zh:'等等～', en:'Hold on~' }) : LZ({ zh:'有灵感', en:'Got inspired' });
      if (!target.bubble) target.bubble = visitMsg;
      p.timer = 75;
      p.onTimer = () => {
        p.bubble = '';
        if (target.bubble === visitMsg) target.bubble = '';
        p.state = 'idle'; p.timer = 80 + Math.floor(Math.random() * 120);
      };
    });
  }

  function startPetAmbient(p) {
    const dest = PET_LOUNGE[Math.floor(Math.random() * PET_LOUNGE.length)];
    p.state = 'wander';
    if (Math.random() < 0.28) p.bubble = p.kind === 'dog' ? LZ({ zh:'汪', en:'Woof' }) : p.kind === 'cat' ? LZ({ zh:'喵', en:'Meow' }) : 'pika';
    walkTo(p, dest, () => {
      p.bubble = '';
      p.timer = 90 + Math.floor(Math.random() * 220);
      p.onTimer = () => { p.state = 'idle'; p.timer = 80 + Math.floor(Math.random() * 180); };
    });
  }

  // ─── The workflow, staged to mirror the real pipeline ──────────────────────
  //   小摘/小词/小潜  ──► 合成 (collects, reviews) ──► 队长 (final)
  //   小导           ─────────────────────────────► 队长 (direct)
  // A single 合成 desk and a single 队长 desk each serialize their visitors so
  // nobody piles up.  Backend runs all workers in parallel; the sim paces it.
  const ALL_WORKERS = ['sum', 'jargon', 'comments', 'ctx'];
  const TO_SYNTH = ['sum', 'jargon', 'comments'];   // these hand off to 合成
  const SYNTH_REVIEW = 130;                          // min frames 合成 spends curating
  const ASSIGNMENTS = {
    sum:      { order:{ zh:'小摘抓重点', en:'Summariser, hit the highlights' }, ack:{ zh:'收到！', en:'Got it!' },      card:{ zh:'摘要中', en:'Summarising' } },
    jargon:   { order:{ zh:'小词找难词', en:'Jargon, find the tricky terms' },  ack:{ zh:'收到！', en:'Got it!' },      card:{ zh:'找术语', en:'Finding terms' } },
    comments: { order:{ zh:'小潜看留言', en:'Comments, dive into the thread' }, ack:{ zh:'我去潜水', en:'Diving in' },   card:{ zh:'留言中', en:'Reading comments' } },
    ctx:      { order:{ zh:'小导判读',   en:'Context, make the call' },        ack:{ zh:'交给我', en:'Leave it to me' }, card:{ zh:'判读中', en:'Assessing' } },
    synth:    { order:{ zh:'合成校稿',   en:'Synthesiser, proofread' },        ack:{ zh:'收到稿', en:'Got the draft' },  card:{ zh:'整合中', en:'Integrating' } },
  };

	  function startRun() {
	    if (editMode.on) exitEditMode();   // a run is mutually exclusive with editing
	    if (reducedMotion) {
	      // No sim under reduced-motion, but still reflect escalate standby statically:
	      // the candidates show asleep until an escalate 'go' decision wakes them.
	      sim.escalate = !!editMode.escalate;
	      sim.escalateDecided = false;
	      sim.escalateStandby = new Set(
	        sim.escalate ? editMode.escalateCandidates.filter(id => ALL_WORKERS.includes(id) && !editMode.bench[id]) : []
	      );
	      sim.escalateStandby.forEach(id => { if (chars[id]) { chars[id].asleep = true; chars[id].bubble = LZ({ zh:'💤 待命', en:'💤 Standby' }); } });
	      if (sim.escalate) render();
	      return;
	    }
	    if (sim.recalling) { sim.pendingStart = true; return; }
	    if (sim.active) return;
	    cancelAmbientAndSideJobs();
	    // Meter switches to "actual" for the run and starts accumulating usage SSE.
	    meter.mode = 'actual'; meter.actual = 0; meter.byAgent = Object.create(null);
	    sim.active = true; sim.presented = false; sim.boardActive = false;
	    sim.pendingStart = false;
	    sim.kbOpen = null;
	    sim.synthQueue = []; sim.synthBusy = false; sim.handed = 0;
	    sim.leaderQueue = []; sim.leaderBusy = false;
	    sim.handoff = false; sim.handoffStart = 0;   // synth→队长 report hand-off phase
	    sim.delivering = false; sim.delivered = false; sim.deliverTarget = null;  // opening task-delivery tour phase
	    sim.collecting = false;                      // collector integration phase not yet begun
	    // Relay pods: each becomes a conveyor line — the doc is carried person→
	    // person in podOrder, and the LAST member delivers the combined doc to the
	    // collector. Snapshot the chains once so the choreography stays stable for
	    // the whole run. relayState[chainKey] tracks the moving cursor per chain.
	    sim.relayChains = relayChainsSnapshot();
	    sim.relayState = Object.create(null);
	    sim.relayMembers = new Set();
	    sim.relayChains.forEach((chain, ci) => {
	      chain.forEach(id => sim.relayMembers.add(id));
	      // i = index of the member currently HOLDING the doc; busy = a carry is in
	      // flight; delivered = the final leg to the collector has completed.
	      sim.relayState[ci] = { i: 0, busy: false, delivered: false };
	    });
	    runDocs.length = 0;
	    // 💸 escalate: latch which candidates start "on standby" (asleep in the
	    // dining corner) for THIS run. They are enabled but deferred — excluded from
	    // finish/carrier expectations until an `escalate` decision wakes them (go)
	    // or the run wraps without them (stop). Snapshot once so mid-run spec edits
	    // can't change the choreography.
	    sim.escalate = !!editMode.escalate;
	    sim.escalateDecided = false;
	    sim.escalateStandby = new Set(
	      sim.escalate ? editMode.escalateCandidates.filter(id => ALL_WORKERS.includes(id) && !editMode.bench[id]) : []
	    );
	    // The office is now always spec-driven: every run works IN PLACE at the
	    // computed layout (readers‖ → ctx → synth → whiteboard), with docs flying
	    // left→right. This unifies the old default+custom paths behind one engine.
	    sim.customRun = true;
	    startCustomRun();
	  }
	  // True while `id` is an escalate candidate still on standby (asleep, deferred)
	  // this run — treated like "temporarily benched" for finish/carrier logic.
	  function isStandby(id) { return !!(sim.escalateStandby && sim.escalateStandby.has(id)); }

	  // 💸 escalate decision from the backend (SSE `escalate` event), forwarded by
	  // app.js. 'go' → wake the standby candidates: they get up from the dining
	  // corner and WALK into their reader slots, then work + deliver normally.
	  // 'stop' → they stay asleep; the run wraps up with just the already-working
	  // agents (sum+ctx→synth→队长→whiteboard). Robust to being called never / twice /
	  // after the run has moved on: no-ops safely and never leaves anyone stuck.
	  function escalateDecision(decision) {
	    if (reducedMotion) { escalateDecisionReduced(decision); return; }
	    if (!sim.active || !sim.escalate) return;      // not an escalate run: ignore
	    if (sim.escalateDecided) return;               // decision is one-shot per run
	    sim.escalateDecided = true;
	    const standby = Array.from(sim.escalateStandby || []);
	    if (decision === 'go') wakeEscalateCandidates(standby);
	    // 'stop' (or anything else): leave them asleep. They're already excluded from
	    // carrier/finish expectations, so the run wraps with just the active agents.
	    else standby.forEach(id => { const e = chars[id]; if (e && e.asleep) e.bubble = ''; });
	  }
	  // Wake the given standby workers: clear their standby flag so they count as
	  // carriers again, then walk each from the corner to its computed reader slot
	  // and start working in place (SSE `status` events then drive them as usual).
	  function wakeEscalateCandidates(ids) {
	    ids.forEach(id => {
	      const e = chars[id];
	      if (!e) return;
	      if (sim.escalateStandby) sim.escalateStandby.delete(id);   // now a real carrier
		      e.path = null; e.onArrive = null; e.timer = 0; e.onTimer = null;
		      e._queuedDeliver = false; e._returningToDesk = false; e.ambKind = null; e.carryDoc = false;
	      e.asleep = false; e.bubble = LZ({ zh:'值得读，开工！', en:"Worth a read, let's go!" });
	      e.state = 'delivering';   // transient "moving" state so nothing else grabs it
	      const t = targetPos(id);  // its computed reader slot (all-enabled escalate spec)
	      walkXY(e, t.x, t.y, () => {
	        e.x = t.x; e.y = t.y; e.tile = [Math.round((e.x - 8) / TILE), Math.round((e.y - 8) / TILE)];
	        e.facing = 'down'; e.bubble = '';
	        e.state = 'working'; e.workStart = tick;   // work in place; SSE drives the monitor
	      }, 'rush');
	    });
	  }
	  // Reduced-motion escalate: no walking — reflect states statically. 'go' wakes
	  // the candidates into a working state in place; 'stop' leaves them asleep.
	  function escalateDecisionReduced(decision) {
	    if (!sim.escalate || sim.escalateDecided) return;
	    sim.escalateDecided = true;
	    const standby = Array.from(sim.escalateStandby || []);
	    standby.forEach(id => {
	      const e = chars[id]; if (!e) return;
	      if (decision === 'go') {
	        if (sim.escalateStandby) sim.escalateStandby.delete(id);
	        e.asleep = false; e.state = 'working'; e.workStart = tick; e.bubble = '';
	      }
	    });
	  }

	  // Spec-driven run: workers stay at their COMPUTED positions (targetPos) and
	  // work in place — no recall to fixed seats. Disabled workers sleep in the
	  // rest area. Finished workers fly a result doc rightward down the pipeline.
	  // Smoothly move an agent from wherever it currently stands to a run position,
	  // then run `onArrive`. This is the anti-teleport primitive for run start: an
	  // agent finishes/aborts its current micro-step (ambient errands are already
	  // cancelled by cancelAmbientAndSideJobs) and WALKS to its slot, so there's no
	  // one-frame state cut. If it's already essentially there, walkXY completes on
	  // the first frame (no visible snap). Reduced-motion never reaches here.
	  function walkIntoRun(e, tx, ty, onArrive, pace) {
	    e.path = null; e.onArrive = null; e.walkTarget = null;
	    e.timer = 0; e.onTimer = null; e.ambKind = null;
	    e.state = 'delivering';   // transient "moving" state so run logic won't grab it mid-walk
	    walkXY(e, tx, ty, () => {
	      e.x = tx; e.y = ty; e.tile = [Math.round((e.x - 8) / TILE), Math.round((e.y - 8) / TILE)];
	      e.facing = 'down';
	      onArrive();
	    }, pace || 'rush');
	  }

	  function startCustomRun() {
	    relayoutActive = false;   // freeze any in-flight reshuffle; the run owns motion now
	    computed = computeLayout(specSnapshot());   // ensure targets reflect the current spec
	    sim.customView = true;   // keep traveling desks/pods/docs rendered through the finale
	    const L = chars.orch;
	    sim.delivering = false; sim.delivered = false;
	    // 队长 WALKS from its current spot to the overseer slot, then hands the task
	    // out to the active readers (a brisk opening-delivery tour) before settling
	    // as overseer. The delivery is purely the leader's route — readers already
	    // start working on arrival at their slots (below), so the leader never gates
	    // them behind reality (SSE running arriving first just means the hand-off is
	    // a quick catch-up gesture). No teleport.
	    { const t = targetPos('orch');
	      L.bubble = LZ({ zh:'各组就位，开工！', en:"Everyone's in position, let's go!" });
	      walkIntoRun(L, t.x, t.y, () => {
	        L.state = 'idle'; L.facing = 'down';
	        L.timer = 90; L.onTimer = () => { if (sim.active && !sim.delivering) L.bubble = ''; };
	        beginTaskDelivery();
	      }); }
	    // Rest-corner slots for anyone sleeping this run (benched OR escalate-standby),
	    // assigned in a stable order so nobody stacks on the same chair (each gets a
	    // DISTINCT slot — see REST_SLOTS).
	    let restIdx = 0;
	    ALL_WORKERS.forEach(id => {
	      const e = chars[id];
	      e._queuedDeliver = false; e._returningToDesk = false;
	      if (editMode.bench[id]) {
	        // Benched → disabled: walk to the rest corner, then nap (greyed, asleep,
	        // never assigned, no handoff). Walking (not snapping) keeps it smooth.
	        const slot = REST_SLOTS[restIdx++ % REST_SLOTS.length]; const rc = centreOf(slot[0], slot[1]);
	        e.bubble = '';
	        walkIntoRun(e, rc.x, rc.y, () => {
	          e.tile = slot.slice(); e.asleep = true; e.state = 'idle'; e.bubble = ''; e.facing = 'down';
	        }, 'idle');
	        delete taskState[id];
	      } else if (isStandby(id)) {
	        // 💸 escalate candidate on standby: walk to the dining corner and sleep
	        // ("待命"), deferred until the backend's escalate decision.
	        const slot = REST_SLOTS[restIdx++ % REST_SLOTS.length]; const rc = centreOf(slot[0], slot[1]);
	        e.bubble = '';
	        walkIntoRun(e, rc.x, rc.y, () => {
	          e.tile = slot.slice(); e.asleep = true; e.state = 'idle'; e.bubble = LZ({ zh:'💤 待命', en:'💤 Standby' }); e.facing = 'down';
	        }, 'idle');
	        delete taskState[id];
	      } else {
	        // Active worker: WALK from its current position to its computed slot, then
	        // start working IN PLACE on arrival (workStart set then, so MIN_WORK is
	        // honoured even if the SSE `done` already landed while walking in).
	        const p = targetPos(id);
	        e.asleep = false; e.bubble = '';
	        walkIntoRun(e, p.x, p.y, () => {
	          e.state = 'working'; e.workStart = tick;   // work in place; SSE drives the monitor
	        });
	      }
	    });
	    // 合成 also WALKS to its computed 校对 desk, then idles there (no teleport).
	    const S = chars.synth;
	    S._queuedDeliver = false; S._returningToDesk = false;
	    { const t = targetPos('synth');
	      S.bubble = '';
	      if (editMode.bench.synth) {
	        walkIntoRun(S, t.x, t.y, () => { S.asleep = true; S.state = 'idle'; S.facing = 'down'; });
	      } else {
	        walkIntoRun(S, t.x, t.y, () => { S.state = 'idle'; S.facing = 'down'; });
	      }
	    }
	  }

	  // ─── Opening delivery: 队长 hands the task to the active readers ─────────────
	  // Bubbles 队长 says as it hands over the task (📋) at the start of a run.
	  const DELIVER_ORDERS = [
	    { zh:'这篇交给你', en:'This one is yours' },
	    { zh:'开始啰', en:"Here we go" },
	    { zh:'麻烦你了', en:'Over to you' },
	    { zh:'就靠你了', en:"Counting on you" },
	  ];
	  const DELIVER_HOLD = 22;   // frames 队长 pauses at each reader for the hand-off beat

	  // Which agents 队长 delivers to, once per group: the FIRST member (podOrder) of
	  // each active reader pod, plus every active solo reader, plus ctx when active.
	  // Skips benched + escalate-standby workers. Robust to 1–3 readers, relay pods
	  // (delivers to the first member), quick-scan/escalate (only the active ones).
	  function deliveryTargets() {
	    const activeReader = id => !editMode.bench[id] && !isStandby(id);
	    const targets = [];
	    const claimed = new Set();
	    // One stop per reader pod (first in run order), so a pod is kicked off once.
	    workflowPods().forEach(pod => {
	      const members = podOrder(pod).filter(activeReader);
	      if (!members.length) return;
	      targets.push(members[0]);
	      members.forEach(id => claimed.add(id));
	    });
	    // Any active reader not captured by a pod (defensive; computePods already
	    // returns singletons as length-1 pods, so this is a belt-and-braces sweep).
	    STAGE1.forEach(id => { if (activeReader(id) && !claimed.has(id)) targets.push(id); });
	    // ctx is a solo pipeline node — give it its task too when active.
	    if (activeReader('ctx')) targets.push('ctx');
	    // Only real, present entities that aren't the leader itself.
	    return targets.filter(id => id !== 'orch' && chars[id]);
	  }

	  // Kick off the brisk hand-off tour: 队长 carries a 📋 to each delivery target,
	  // pauses for a beat with a bubble (which reads as "kicking off" that reader),
	  // then returns to its overseer spot. This NEVER changes reader work state —
	  // readers already start on arrival / SSE — so it can't hold anyone behind
	  // reality, and it can't soft-lock (each step is guarded + always converges).
	  function beginTaskDelivery() {
	    if (!sim.active || sim.handoff || sim.presented) return;
	    if (sim.delivered) return;
	    const targets = deliveryTargets();
	    sim.delivering = true;
	    deliverTaskStep(targets, 0);
	  }
	  // Return 队长 to its overseer slot and settle it as the room's overseer.
	  function endTaskDelivery() {
	    const L = chars.orch;
	    sim.delivering = false; sim.delivered = true; sim.deliverTarget = null;
	    L.carryDoc = false;
	    if (!sim.active || sim.handoff || sim.presented) return;   // finale owns L now
	    const t = targetPos('orch');
	    L.state = 'delivering';
	    walkXY(L, t.x, t.y, () => {
	      // Don't stomp the finale if it began while we were walking back.
	      if (sim.handoff || sim.presented) return;
	      L.state = 'idle'; L.facing = 'down'; L.bubble = LZ({ zh:'各组开工，我盯著', en:"Everyone's working, I've got eyes on it" });
	      L.timer = 70; L.onTimer = () => { if (sim.active && !sim.delivering) L.bubble = ''; };
	    }, 'task');
	  }
	  function deliverTaskStep(targets, i) {
	    const L = chars.orch;
	    // Abort cleanly if the run moved on (finished fast / entered the finale) — the
	    // finale (beginHandoff/startPresentInPlace) takes over 队长 from here.
	    if (!sim.active || sim.handoff || sim.presented) { sim.delivering = false; L.carryDoc = false; return; }
	    if (i >= targets.length) { endTaskDelivery(); return; }
	    const w = chars[targets[i]];
	    // Target vanished / benched mid-tour (e.g. spec churn): skip to the next.
	    if (!w || editMode.bench[targets[i]] || isStandby(targets[i])) { deliverTaskStep(targets, i + 1); return; }
	    sim.deliverTarget = targets[i];   // lights the 队长→this-reader flow connector
	    L.carryDoc = true;   // 队长 carries the 📋 task on its route
	    L.bubble = '';
	    const spot = handoffSpotFor(w);
	    L.state = 'delivering';
	    walkXY(L, spot.x, spot.y, () => {
	      if (!sim.active || sim.handoff || sim.presented) { sim.delivering = false; L.carryDoc = false; sim.deliverTarget = null; return; }
	      faceToward(L, w.tile);
	      L.state = 'assigning';
	      L.bubble = LZ(DELIVER_ORDERS[i % DELIVER_ORDERS.length]);
	      // A brief acknowledging bubble on the reader if it isn't mid-talking.
	      const ackMsg = LZ({ zh:'收到！', en:'Got it!' });
      if (w.state === 'working' && !w.bubble) w.bubble = ackMsg;
	      L.timer = DELIVER_HOLD;
	      L.onTimer = () => {
	        L.bubble = '';
	        if (w.bubble === ackMsg) w.bubble = '';
	        sim.deliverTarget = null;
	        deliverTaskStep(targets, i + 1);
	      };
	    }, 'task');
	  }

	  // New analysis incoming: instead of recalling everyone to fixed seats, the
	  // office RE-ARRANGES into the current spec's pipeline (agents walk to their
	  // computed slots; disabled ones head to the rest area). startRun() latches
	  // pendingStart and fires once the reshuffle settles, so the run begins from
	  // a clean, spec-shaped office.
	  function receiveTask() {
	    if (editMode.on) exitEditMode();   // a run is mutually exclusive with editing
	    if (reducedMotion) { window.pixelAgents.reset(); return; }
	    hardStopSideJobs();
	    sim.active = false; sim.recalling = true; sim.pendingStart = false;
	    sim.presented = false; sim.boardActive = false; sim.kbOpen = null;
	    sim.customView = false; runDocs.length = 0;   // drop any custom-run rendering
	    sim.synthQueue = []; sim.synthBusy = false; sim.handed = 0;
	    sim.leaderQueue = []; sim.leaderBusy = false;
	    sim.handoff = false; sim.handoffStart = 0; sim.collecting = false;
	    selected = null;
	    const L = chars.orch;
	    L.bubble = LZ({ zh:'各组就位，准备开工！', en:"Everyone's in position, get ready!" });
	    // Clear per-agent leftovers, then walk to the computed layout.
	    Object.values(chars).forEach(e => {
		      e.timer = 0; e.onTimer = null; e._queuedDeliver = false; e._returningToDesk = false;
		      e.ambKind = null; e.statusText = ''; e._report = ''; e.workStart = 0; e.carryDoc = false;
	      delete taskState[e.id];
	    });
	    relayout();   // reshuffle into the spec pipeline (walk; snaps under reduced-motion)
	    sim.recalling = false;
	    // Fire the pending run now; startCustomRun freezes the reshuffle and pins
	    // positions, so the run begins immediately while agents are (visually)
	    // still settling into place — reads as "getting to work".
	    if (sim.pendingStart) startRun();
	  }

  function assignTour(i) {
    const L = chars.orch;
    if (i >= ALL_WORKERS.length) {                   // done assigning → become receiver
      L.state = 'returning';
      L.bubble = LZ({ zh:'各组开工', en:'Everyone, get to work' });
      walkTo(L, L.station.approach, () => slideTo(L, L.station.seat, () => {
        L.state = 'idle'; L.facing = 'down'; L.bubble = ''; tryLeader();
      }));
      return;
    }
    const w = chars[ALL_WORKERS[i]];
    const task = ASSIGNMENTS[w.id] || { order:{ zh:'交给你！', en:'This one is yours!' }, ack:{ zh:'收到！', en:'Got it!' }, card:{ zh:'处理中', en:'Working' } };
    L.state = 'walking_to_employee';
    walkTo(L, w.station.approach, () => {
      faceToward(L, w.station.seat);
      L.state = 'assigning'; L.bubble = LZ(task.order); w.state = 'called'; w.bubble = LZ(task.ack);
      queuePetCard(w.id, LZ(task.card));
      L.timer = ASSIGN; L.onTimer = () => {
        L.bubble = ''; w.bubble = '';
        w.state = 'working'; w.workStart = tick;
        assignTour(i + 1);
      };
    });
  }

  // A worker walks to `target`, plays an interaction, then returns to its seat.
  function deliver(w, target, sayW, sayT, after) {
    w.state = 'walking_to_leader'; w.bubble = '';
    slideTo(w, w.station.approach, () => walkTo(w, target.station.approach, () => {
      faceToward(w, target.station.seat);
      w.state = 'reporting'; w.bubble = sayW; if (sayT) target.bubble = sayT;
      w.timer = REPORT; w.onTimer = () => {
        w.bubble = ''; if (sayT) target.bubble = '';
        w.state = 'returning';
        walkTo(w, w.station.approach, () => slideTo(w, w.station.seat, () => {
          w.state = 'done'; w.facing = 'down'; after();
        }));
      };
    }));
  }

	  // Stage 1: 小摘/小词/小潜 hand their drafts to 合成 (serialized at its desk).
	  function trySynth() {
	    if (sim.synthBusy || !sim.synthQueue.length) return;
	    const S = chars.synth;
	    if (!isSeated(S)) {
	      ensureAtDesk(S, () => trySynth());
	      return;
	    }
	    const w = chars[sim.synthQueue.shift()];
	    sim.synthBusy = true;
	    deliver(w, S, w._report || LZ({ zh:'交稿！', en:'Draft delivered!' }), LZ({ zh:'收到', en:'Got it' }), () => {
	      sim.synthBusy = false; sim.handed++;
	      if (sim.handed >= TO_SYNTH.length) {
        S.state = 'reviewing'; S.workStart = tick; queuePetCard('synth', ASSIGNMENTS.synth.card);
      }  // start curating
	      trySynth();
	    });
	  }

	  function isSeated(e) {
	    return e.tile[0] === e.station.seat[0] && e.tile[1] === e.station.seat[1] && !moving(e);
	  }

	  function ensureAtDesk(e, cb) {
	    if (e._returningToDesk) return;
	    e._returningToDesk = true;
	    e.path = null; e.onArrive = null; e.timer = 0; e.onTimer = null;
	    e.bubble = e.id === 'synth' ? LZ({ zh:'先回电脑前', en:'Back to my desk first' }) : '';
	    e.state = 'recall';
	    const done = () => {
	      e._returningToDesk = false;
	      e.state = 'idle'; e.bubble = ''; e.facing = 'down';
	      if (cb) cb();
	    };
	    const sit = () => slideTo(e, e.station.seat, done);
	    if (e.tile[0] === e.station.approach[0] && e.tile[1] === e.station.approach[1]) sit();
	    else walkTo(e, e.station.approach, sit);
	  }

  // Stage 2: 队长 receives 小导's direct report and 合成's final draft (serialized).
  function tryLeader() {
    const L = chars.orch;
    if (sim.leaderBusy || L.state !== 'idle' || !sim.leaderQueue.length) return;
    const job = sim.leaderQueue.shift();
    sim.leaderBusy = true;
    const w = chars[job];
    const say = job === 'synth' ? LZ({ zh:'最终稿！', en:'Final draft!' }) : (w._report || LZ({ zh:'完成！', en:'Done!' }));
    deliver(w, L, say, '✓', () => {
      sim.leaderBusy = false; maybeFinish(); tryLeader();
    });
  }
  function maybeFinish() {
    if (ALL_WORKERS.every(id => chars[id].state === 'done') && chars.synth.state === 'done') {
      sim.active = false;
      if (!sim.presented) { sim.presented = true; startPresent(); }
    }
  }

  // Everyone's done → 队长 walks to the whiteboard to present, then the report
  // expands (the app reveals it via the present handler).
  function startPresent() {
    const L = chars.orch;
    L.state = 'walking_to_employee'; L.bubble = ''; L.carryDoc = true;
    const spot = centreOf(WB_APPROACH[0], WB_APPROACH[1]);
    walkXY(L, spot.x, spot.y, () => {
      L.tile = WB_APPROACH.slice();
      faceToward(L, WB_TILE); L.carryDoc = false; L.state = 'presenting'; L.bubble = LZ({ zh:'📊 来看报告！', en:'📊 Come see the report!' });
      sim.boardActive = true;
      if (presentHandler) presentHandler();
      L.timer = 120; L.onTimer = () => settleAfterReport();
    }, 'task');
  }

  function settleAfterReport() {
    const L = chars.orch;
    Object.values(chars).forEach(e => {
      if (e.id !== 'orch' && e.state === 'done') e.state = 'idle';
      e.statusText = ''; e._report = ''; e.workStart = 0;
      e._queuedDeliver = false;
      delete taskState[e.id];
      e.idleTimer = 40 + Math.floor(Math.random() * 120);
    });
    L.bubble = ''; L.state = 'returning';
    walkTo(L, L.station.approach, () => slideTo(L, L.station.seat, () => finishAmbient(L)));
  }

	  function cancelAmbientAndSideJobs() {
	    ambLocks.kitchen = ambLocks.snack = ambLocks.cooler = false;
	    petQueue.length = 0;
    Object.values(chars).forEach(e => {
      if (e.state === 'amb_walk' || e.state === 'amb_do' || e.state === 'kb_search') {
        e.state = 'idle'; e.bubble = ''; e.onTimer = null; e.timer = 0; e.ambKind = null;
        e.path = null; e.onArrive = null;
      }
    });
    Object.values(pets).forEach(p => {
      p.path = null; p.onArrive = null; p.onTimer = null; p.card = ''; p.bubble = '';
	      p.state = 'idle'; p.timer = 30 + Math.floor(Math.random() * 80);
	    });
	  }

	  function hardStopSideJobs() {
	    ambLocks.kitchen = ambLocks.snack = ambLocks.cooler = false;
	    petQueue.length = 0;
	    Object.values(pets).forEach(p => {
	      p.path = null; p.onArrive = null; p.onTimer = null;
	      p.card = ''; p.bubble = ''; p.state = 'idle';
	      p.timer = 50 + Math.floor(Math.random() * 90);
	    });
	  }

  function fetchWordbook(cb) {
    const open = typeof cb === 'function' ? cb : null;
    if (reducedMotion || sim.active) { if (open) open(); return; }
    const L = chars.orch;
    if (sim.kbOpen) { sim.kbOpen = open; return; }
    sim.kbOpen = open;
    if (L.state === 'amb_walk' || L.state === 'amb_do') {
      L.state = 'idle'; L.bubble = ''; L.path = null; L.onArrive = null; L.timer = 0; L.onTimer = null; L.ambKind = null;
    }
    L.bubble = '';
    walkTo(L, SHELF_APPROACH, () => {
      faceToward(L, [2, 2]);
      L.state = 'kb_search'; L.bubble = LZ({ zh:'找单词本…', en:'Looking up the wordbook…' }); L.timer = 85;
      L.onTimer = () => {
        L.bubble = LZ({ zh:'找到了', en:'Found it' });
        if (sim.kbOpen) sim.kbOpen();
        sim.kbOpen = null;
        L.timer = 35;
        L.onTimer = () => {
          L.bubble = ''; L.state = 'idle';
          // Return to the computed overseer slot (free-floating) via the layout lerp.
          L.walkTarget = { x: targetPos('orch').x, y: targetPos('orch').y, benched: false };
          relayoutActive = true;
        };
      };
    });
  }

  // ─── Ambient office life (game-NPC idle behaviour) ──────────────────────────
  const ambLocks = { kitchen: false, snack: false, cooler: false };
  const CHATS = [
    { zh:'🙂 歇会', en:'🙂 Break' }, '🥱', '💤 zzz', '🎧',
    { zh:'摸个鱼', en:'Slacking off' }, '🤔', '☕?',
  ];

  // The agent's "home" tile = its current computed layout slot (drag override or
  // spec-derived), rounded to the grid so A* can route to/from it. This replaces
  // the old fixed-seat base so ambient errands return the agent to wherever the
  // layout engine actually placed it.
  function homeTileOf(id) {
    const t = targetPos(id);
    let col = Math.round((t.x - 8) / TILE), row = Math.round((t.y - 8) / TILE);
    col = Math.max(0, Math.min(COLS - 1, col));
    row = Math.max(WALL, Math.min(ROWS - 1, row));
    // If the home tile is non-walkable (furniture), nudge to a walkable neighbour
    // so the A* return trip always has a valid goal (nothing may throw).
    if (!walkable[row][col]) {
      const nb = [[0,0],[1,0],[-1,0],[0,1],[0,-1]].map(([dc,dr]) => [col+dc, row+dr])
        .find(([nc,nr]) => nc>=0 && nr>=0 && nc<COLS && nr<ROWS && walkable[nr][nc]);
      if (nb) { col = nb[0]; row = nb[1]; }
    }
    return [col, row];
  }

  function ambientTick(e) {
    // The office is spec-driven, so ambient errands are now HOME-RELATIVE: an idle
    // agent walks from its computed slot to an errand tile and A*-walks back to
    // that same slot (homeTileOf). Only runs when nothing is being analysed.
    if (e.walkTarget || relayoutActive) return;                 // mid-reshuffle: don't interfere
    if (sim.active || e.asleep || e.state !== 'idle' || moving(e)) return;
    if (e.id === 'orch' && sim.kbOpen) return;                  // 队长 busy fetching the wordbook
    if (e.idleTimer == null) e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND);
    if (--e.idleTimer > 0) return;
    startAmbient(e);
  }
  function finishAmbient(e) {
    e.state = 'idle'; e.bubble = ''; e.facing = 'down'; e.ambKind = null;
    e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND);
  }
  // Walk out to a tile, do a thing for a beat, then A*-walk back to the agent's
  // home slot (its computed layout position — not a fixed seat).
  function ambientTrip(e, tile, lock, say, release) {
    e.state = 'amb_walk'; e.ambKind = 'trip'; e.bubble = '';
    const home = homeTileOf(e.id);
    const goHome = () => walkTo(e, home, () => {
      if (release) ambLocks[release] = false;
      finishAmbient(e);
    });
    walkTo(e, tile, () => {
      // A run may have started while walking — bail cleanly back home.
      if (sim.active) { if (release) ambLocks[release] = false; finishAmbient(e); return; }
      e.facing = 'up'; e.state = 'amb_do'; e.bubble = say; e.timer = AMB_DO;
      e.onTimer = () => { e.bubble = ''; goHome(); };
    });
  }
  function startAmbient(e) {
    const roll = Math.random();
    if (roll < 0.26 && !ambLocks.kitchen) { ambLocks.kitchen = true; ambientTrip(e, KITCHEN_TILE, 'kitchen', '☕', 'kitchen'); }
    else if (roll < 0.44 && !ambLocks.snack) { ambLocks.snack = true; ambientTrip(e, SNACK_TILE, 'snack', '🍪', 'snack'); }
    else if (roll < 0.56 && !ambLocks.cooler) { ambLocks.cooler = true; ambientTrip(e, COOLER_TILE, 'cooler', '💧', 'cooler'); }
    else if (roll < 0.80) {                                  // answer email at the desk
      e.state = 'amb_do'; e.ambKind = 'email'; e.bubble = LZ({ zh:'✉️ 回信', en:'✉️ Replying' }); e.timer = AMB_DO + 60;
      e.onTimer = () => finishAmbient(e);
    } else {                                                 // a little idle chatter
      e.state = 'amb_do'; e.ambKind = 'chat'; e.bubble = LZ(CHATS[Math.floor(Math.random() * CHATS.length)]);
      e.timer = 90; e.onTimer = () => finishAmbient(e);
    }
  }

  // ─── Per-frame update ───────────────────────────────────────────────────────
  function update() {
    if (editMode.on) return;   // edit mode freezes the sim; the user drives positions
    stepLayout();              // advance any in-flight spec-driven reshuffle walk
    Object.values(chars).forEach(stepEntity);
    Object.values(pets).forEach(stepEntity);
    separateChars();           // gentle push-apart so bodies never fully overlap
    if (customRunActive()) { updateCustomRun(); petTick(); return; }
    if (relayoutActive) { petTick(); return; }   // don't fight the reshuffle with ambient/seat logic
    // hybrid work gate: a worker moves on only after its real `done` AND min time.
    for (const id of ALL_WORKERS) {
      const w = chars[id];
      if (w.state === 'working' && !moving(w) && taskState[id] === 'done' && (tick - w.workStart) >= MIN_WORK) {
        w.state = 'waiting';
        if (id === 'ctx') { sim.leaderQueue.push('ctx'); tryLeader(); }   // 小导 → 队长 direct
        else { sim.synthQueue.push(id); trySynth(); }                     // others → 合成
      }
    }
	    // 合成 finishes curating → walks the final draft to 队长.
	    const S = chars.synth;
	    if (S.state === 'reviewing' && isSeated(S) && (tick - S.workStart) >= SYNTH_REVIEW && !S._queuedDeliver) {
	      S._queuedDeliver = true; S.state = 'waiting';
	      sim.leaderQueue.push('synth'); tryLeader();
	    }
    // ambient office life while nothing is being analysed
    Object.values(chars).forEach(ambientTick);
    petTick();
  }

  // Who produces the final report to hand to 队长. Normally 合成; if 合成 is
  // disabled we fall back to the last active downstream stage (裁定, else the
  // right-most enabled reader), so the hand-off is robust to a benched synth.
  function lastProducerId() {
    if (!editMode.bench.synth) return 'synth';
    if (!editMode.bench.ctx) return 'ctx';
    const readers = STAGE1.filter(id => !editMode.bench[id]);
    if (readers.length) return readers.slice().sort((a, b) => chars[b].x - chars[a].x)[0];
    return 'orch';
  }
  // Snapshot the current relay chains: for every stage-1 pod whose mode is
  // 'relay' AND that has ≥2 ENABLED members, return the enabled members in
  // podOrder (left→right run order, matching the 1→2→… badges). Single-member
  // or parallel pods are excluded (they keep the independent-carry behaviour).
  // Read once at run start so the chain stays stable for the whole run.
  function relayChainsSnapshot() {
    const chains = [];
    workflowPods().forEach(pod => {
      if (pod.length < 2) return;                       // singletons: not a relay line
      if (podModeOf(pod) !== 'relay') return;           // parallel pods: unchanged
      const chain = podOrder(pod).filter(id => !editMode.bench[id]);
      if (chain.length >= 2) chains.push(chain);        // need ≥2 enabled to convey
    });
    return chains;
  }
  // Where a carrier stands to hand a document to `target` (just to its left, or
  // right if the target sits near the left edge). A small offset so the two
  // sprites don't overlap during the beat.
  function handoffSpotFor(target) {
    const leftOK = target.x - 14 > TILE;             // stand to the left unless near the wall
    return { x: target.x + (leftOK ? -14 : 14), y: target.y };
  }
  // Draft/handover bubbles readers say when they set a doc down at 合成.
  const DELIVER_SAYS = [
    { zh:'交给你了', en:'Here you go' },
    { zh:'这是我的部分', en:'This is my part' },
    { zh:'我的稿子', en:'My draft' },
    { zh:'整理好了', en:'All sorted' },
  ];

  // In-place custom run: PEOPLE carry documents. Each enabled worker finishes
  // (real `done` + MIN_WORK) → queues to walk its draft to the collector (合成,
  // or a fallback producer if 合成 is benched), hands it over, and walks back to
  // its slot → done. Deliveries are SERIALIZED so carriers don't pile up. When
  // every enabled worker has delivered, the collector integrates, then walks the
  // final report to 队长, who walks to the whiteboard and presents.
  function updateCustomRun() {
    // The collector everyone delivers to. If 合成 is benched, deliveries route to
    // the fallback producer instead (which itself later carries to 队长).
    const synthOn = !editMode.bench.synth;
    const collectorId = synthOn ? 'synth' : lastProducerId();
    const carriers = ALL_WORKERS.filter(id => id !== collectorId);   // exclude the collector itself

    for (const id of carriers) {
      if (editMode.bench[id]) continue;   // disabled: never finishes, never delivers
      if (isStandby(id)) continue;        // 💸 escalate candidate on standby: deferred until 'go'
      // Relay-pod members are driven by the conveyor (stepRelayChains), not the
      // independent carry-to-collector path — skip them here.
      if (sim.relayMembers && sim.relayMembers.has(id)) continue;
      const w = chars[id];
      if (w.state === 'working' && taskState[id] === 'done' && (tick - w.workStart) >= MIN_WORK
          && !w._queuedDeliver) {
        w._queuedDeliver = true;
        w.state = 'waiting'; w.bubble = '';
        sim.synthQueue.push(id);
        tryCarryToSynth();
      }
    }

    // Advance any relay conveyor lines (doc carried member→member; last member
    // carries the combined doc to the collector).
    stepRelayChains(collectorId);

    // Standby escalate candidates are excluded until woken — otherwise the run
    // would wait on workers that may never start (decision:'stop').
    const enabledCarriers = carriers.filter(id => !editMode.bench[id] && !isStandby(id));
    // Cosmetic-delivery bookkeeping: every carrier has walked its draft over and
    // returned. This is now FLAVOUR ONLY — it no longer gates whether the
    // collector may start integrating (the real SSE status does). Kept so we can
    // OPTIONALLY start integrating on delivery completion even when there is no
    // SSE-driven collector work (e.g. a plain reader/ctx fallback with no synth).
    const allDelivered = enabledCarriers.every(id => chars[id].state === 'done')
      && sim.handed >= enabledCarriers.length && !sim.synthBusy;

    const S = chars[collectorId];
    // Does the collector do REAL SSE-driven work of its own? synth always does;
    // a reader/ctx fallback does; 队长 as a last-resort producer does not.
    const collectorSSE = ALL_WORKERS.includes(collectorId) || collectorId === 'synth';
    // The collector's real work has STARTED per SSE (running/typing/reading/done).
    const collectorStarted = collectorSSE
      && (taskState[collectorId] === 'typing' || taskState[collectorId] === 'reading'
          || taskState[collectorId] === 'done');
    // The collector's real work is DONE per SSE.
    const collectorDoneSSE = collectorSSE && taskState[collectorId] === 'done';

    // ── Start integrating: track REAL progress, don't wait on the delivery
    // animation. 合成 enters 整合中 the moment its SSE status arrives (running or
    // even already-done if we were behind); a non-SSE fallback producer (no synth,
    // collector is 队长-only) has no status of its own, so it falls back to
    // starting once the cosmetic deliveries have landed. Either way, once started
    // it plays a visible integrate beat before it may finish.
    const canStart = collectorStarted || (!collectorSSE && allDelivered);
    if (canStart && !sim.collecting && !sim.handoff && S
        && S.state !== 'reviewing' && S.state !== 'delivering' && S.state !== 'done') {
      sim.collecting = true;
      S.state = 'reviewing'; S.workStart = tick;
      S.asleep = false;
      S.bubble = (collectorId === 'synth' && synthOn) ? LZ(ASSIGNMENTS.synth.card) : LZ({ zh:'汇整中', en:'Consolidating' });
      if (collectorId === 'synth' && synthOn && taskState.synth !== 'done') taskState.synth = 'typing';
    }

    // ── Finish integrating → hand off. The collector must have been visibly
    // integrating for at least SYNTH_REVIEW frames (so it always shows working
    // before it hands off, even if the SSE `done` already arrived while we were
    // catching up), AND its real work must be done. A non-SSE fallback producer
    // has no `done` event, so its own visible beat is the gate.
    const beatDone = (tick - S.workStart) >= SYNTH_REVIEW;
    const realDone = collectorSSE ? collectorDoneSSE : true;
    if (sim.collecting && S && S.state === 'reviewing' && beatDone && realDone && !sim.handoff) {
      S.state = 'done'; S.bubble = ''; if (collectorId === 'synth') taskState.synth = 'done';
      beginHandoff(collectorId);
    }
  }
  const HANDOFF_MIN = 26;   // min frames 队长 holds the report before presenting

  // Serialized reader→collector delivery: one carrier walks its draft to the
  // collector at a time, pauses (bubble), then walks back to its slot → done.
  function tryCarryToSynth() {
    if (sim.synthBusy || !sim.synthQueue.length) return;
    const collectorId = !editMode.bench.synth ? 'synth' : lastProducerId();
    const S = chars[collectorId];
    const w = chars[sim.synthQueue.shift()];
    if (!w || !S || w === S) { sim.handed++; tryCarryToSynth(); return; }
    sim.synthBusy = true;
    const home = { x: w.x, y: w.y };                 // its computed slot, to return to
    const spot = handoffSpotFor(S);
    w.state = 'delivering'; w.bubble = '';
    walkXY(w, spot.x, spot.y, () => {
      faceToward(w, S.tile);
      w.state = 'reporting';   // stand + talk during the hand-over beat
      w.bubble = LZ(DELIVER_SAYS[Math.floor(Math.random() * DELIVER_SAYS.length)]);
      const ackMsg = LZ({ zh:'收到', en:'Got it' });
      if (!S.bubble) S.bubble = ackMsg;
      w.timer = REPORT;
      w.onTimer = () => {
        w.bubble = ''; if (S.bubble === ackMsg) S.bubble = '';
        w.state = 'delivering';
        walkXY(w, home.x, home.y, () => {
          w.state = 'done'; w.facing = 'down';
          sim.synthBusy = false; sim.handed++;
          tryCarryToSynth();
        }, 'task');
      };
    }, 'task');
  }

  // Bubbles a relay member says as it hands the growing doc to the next person.
  const RELAY_PASS_SAYS = [
    { zh:'接著换你', en:'Your turn next' },
    { zh:'换你了', en:'Your turn' },
    { zh:'传给你', en:'Passing to you' },
    { zh:'交棒', en:'Passing the baton' },
  ];

  // ── Relay conveyor ─────────────────────────────────────────────────────────
  // A relay pod is a CONVEYOR LINE: the document is carried person→person in
  // podOrder. Member i works, then walks the doc to member i+1 (who "works" with
  // it), … and the LAST member carries the combined doc to the collector (合成,
  // or the fallback producer). This reads as clearly sequential — one moving doc
  // travelling down the line — vs. a parallel pod where each reader independently
  // carries its own draft to 合成 at the same time.
  //
  // Serialized per chain via relayState[ci].busy so a chain never has two carries
  // in flight. MIN_WORK still gates each member before it may pass the doc along,
  // keeping the beats watchable. Under reduced-motion the whole custom run never
  // starts, so this is only ever reached in the animated path.
  function stepRelayChains(collectorId) {
    const chains = sim.relayChains || [];
    for (let ci = 0; ci < chains.length; ci++) {
      const chain = chains[ci];
      const st = sim.relayState[ci];
      if (!st || st.busy || st.delivered) continue;
      const h = st.i;                                  // index currently holding the doc
      const id = chain[h];
      const w = chars[id];
      if (!w) { st.delivered = true; continue; }
      // The holder must finish its OWN work (real done + MIN_WORK) before it may
      // pass the doc forward — this is what keeps the relay watchably sequential.
      const worked = taskState[id] === 'done' && (tick - w.workStart) >= MIN_WORK;
      if (w.state !== 'working' || !worked) continue;

      if (h < chain.length - 1) {
        carryRelayToNext(ci, h);                       // → next member down the line
      } else {
        carryRelayToCollector(ci, h, collectorId);     // last member → collector
      }
    }
  }

  // Member `h` in chain `ci` carries the doc to member `h+1`, hands it over, then
  // returns to its slot → done. The next member becomes the new holder.
  function carryRelayToNext(ci, h) {
    const chain = sim.relayChains[ci];
    const st = sim.relayState[ci];
    const w = chars[chain[h]];
    const nxt = chars[chain[h + 1]];
    if (!nxt) { carryRelayToCollector(ci, h, null); return; }
    st.busy = true;
    const home = { x: w.x, y: w.y };
    // Stand just short of the next member (members sit close in the conveyor line,
    // so a small offset keeps the hop visible without the sprites overlapping).
    const side = nxt.x >= w.x ? -1 : 1;
    const spot = { x: nxt.x + side * 8, y: nxt.y };
    w.state = 'delivering'; w.bubble = '';
    walkXY(w, spot.x, spot.y, () => {
      faceToward(w, nxt.tile);
      w.state = 'reporting';                           // hand-over beat
      w.bubble = LZ(RELAY_PASS_SAYS[Math.floor(Math.random() * RELAY_PASS_SAYS.length)]);
      const takeMsg = LZ({ zh:'接手', en:'Taking over' });
      if (!nxt.bubble) nxt.bubble = takeMsg;
      w.timer = REPORT;
      w.onTimer = () => {
        w.bubble = ''; if (nxt.bubble === takeMsg) nxt.bubble = '';
        w.state = 'delivering';
        walkXY(w, home.x, home.y, () => {
          w.state = 'done'; w.facing = 'down';         // this member is finished
          st.i = h + 1;                                // doc now held by the next member
          st.busy = false;                             // release the chain for the next hop
        }, 'task');
      };
    }, 'task');
  }

  // Last member `h` in chain `ci` carries the COMBINED doc to the collector,
  // hands it over, returns → done. Counts as all chain members' contributions
  // (sim.handed += chain.length) so the run's allDelivered gate closes. If the
  // collector IS this member (synth+ctx both benched, chain right-most), the
  // member just holds the report in place (no extra leg).
  function carryRelayToCollector(ci, h, collectorId) {
    const chain = sim.relayChains[ci];
    const st = sim.relayState[ci];
    const w = chars[chain[h]];
    const cid = collectorId || (!editMode.bench.synth ? 'synth' : lastProducerId());
    const S = chars[cid];
    // Collector is this very member (fallback producer): it already holds the
    // combined doc — settle it and account for the whole chain.
    if (!S || cid === chain[h]) {
      st.busy = false; st.delivered = true;
      w.state = 'done'; w.facing = 'down';
      sim.handed += chain.length;
      return;
    }
    // Serialize the final leg through the shared synth lane so relay + parallel
    // carriers never collide at the collector.
    if (sim.synthBusy) return;                         // wait our turn; retried next frame
    sim.synthBusy = true; st.busy = true;
    const home = { x: w.x, y: w.y };
    const spot = handoffSpotFor(S);
    w.state = 'delivering'; w.bubble = '';
    walkXY(w, spot.x, spot.y, () => {
      faceToward(w, S.tile);
      w.state = 'reporting';
      w.bubble = LZ(DELIVER_SAYS[Math.floor(Math.random() * DELIVER_SAYS.length)]);
      const ackMsg = LZ({ zh:'收到', en:'Got it' });
      if (!S.bubble) S.bubble = ackMsg;
      w.timer = REPORT;
      w.onTimer = () => {
        w.bubble = ''; if (S.bubble === ackMsg) S.bubble = '';
        w.state = 'delivering';
        walkXY(w, home.x, home.y, () => {
          w.state = 'done'; w.facing = 'down';
          sim.synthBusy = false;
          st.delivered = true; st.busy = false;
          sim.handed += chain.length;                  // whole chain accounted for
          tryCarryToSynth();                            // let any queued parallel carrier proceed
        }, 'task');
      };
    }, 'task');
  }

  // Report hand-off: the collector (producer) carries the integrated report to
  // 队长, hands it over ("报告好了"), then 队长 walks to the whiteboard to present.
  function beginHandoff(producerId) {
    // Keep sim.active TRUE through the hand-off so updateCustomRun keeps ticking
    // and can advance; it flips false when 队长 starts presenting.
    sim.handoff = true; sim.handoffStart = tick;
    const L = chars.orch;
    // The finale owns 队长 now: cancel any in-flight opening-delivery walk/timer so
    // its callbacks can't fight the hand-off (its own guards also bail on sim.handoff).
    sim.delivering = false; sim.delivered = true;
    L.walkXY = null; L.path = null; L.onArrive = null; L.timer = 0; L.onTimer = null;
    L.carryDoc = false; L.bubble = '';
    const producer = producerId || lastProducerId();
    const F = chars[producer];
    if (!F || producer === 'orch') {
      // Producer IS 队长 (nothing enabled downstream) → 队长 already holds it.
      L.bubble = LZ({ zh:'拿到报告了', en:'Got the report' });
      L.timer = HANDOFF_MIN;
      L.onTimer = () => { if (!sim.presented) { sim.presented = true; startPresentInPlace(); } };
      return;
    }
    const home = { x: F.x, y: F.y };
    const spot = handoffSpotFor(L);
    F.state = 'delivering'; F.bubble = '';
    walkXY(F, spot.x, spot.y, () => {
      faceToward(F, L.tile);
      F.state = 'reporting';   // stand + talk during the hand-over beat
      F.bubble = LZ({ zh:'报告好了', en:'Report is ready' }); L.bubble = LZ({ zh:'拿到报告了', en:'Got the report' });
      F.timer = REPORT;
      F.onTimer = () => {
        F.bubble = '';
        F.state = 'delivering';
        walkXY(F, home.x, home.y, () => { F.state = 'done'; F.facing = 'down'; }, 'task');
        L.timer = HANDOFF_MIN;
        L.onTimer = () => { if (!sim.presented) { L.bubble = ''; sim.presented = true; startPresentInPlace(); } };
      };
    }, 'task');
  }

  // Finale: 队长 walks over to the whiteboard, presents (triggering the report
  // reveal), then returns to its overseer spot and settles everyone. Walking to
  // the board keeps the "boss presents the report" beat and anchors the board as
  // the pipeline's output. The synth→board doc lands just before this.
  function present_settle() {
    const L = chars.orch;
    Object.values(chars).forEach(e => {
      e.statusText = ''; e._report = ''; e._queuedDeliver = false; e.walkXY = null; e.carryDoc = false;
    });
    L.bubble = ''; L.state = 'returning';
    // Walk 队长 back to its overseer slot (free-floating target, via the layout lerp).
    L.walkTarget = { x: targetPos('orch').x, y: targetPos('orch').y, benched: false };
    relayoutActive = true;
    ALL_WORKERS.concat('synth').forEach(id => { if (!editMode.bench[id]) delete taskState[id]; });
    sim.customView = false;   // finale settled → desks/pods revert to default rendering
    runDocs.length = 0;
  }
  function startPresentInPlace() {
    const L = chars.orch;
    sim.active = false;   // hand-off complete → run logic ends; the present finale begins
    // The hand-off is done; clear the producer's "交给队长" bubble (legacy guard —
    // no current code path sets this bubble text, but kept for safety).
    const handoffMsg = LZ({ zh:'报告交给队长', en:'Report handed to the Orchestrator' });
    Object.values(chars).forEach(e => { if (e.id !== 'orch' && e.bubble === handoffMsg) e.bubble = ''; });
    // Walk 队长 to the whiteboard easel, face it, then present.
    L.state = 'walking_to_employee'; L.bubble = ''; L.carryDoc = true;
    L.walkTarget = null;
    const spot = centreOf(WB_APPROACH[0], WB_APPROACH[1]);
    walkXY(L, spot.x, spot.y, () => {
      L.tile = WB_APPROACH.slice();
      faceToward(L, WB_TILE);
      L.carryDoc = false;
      L.state = 'presenting'; L.bubble = LZ({ zh:'📊 来看报告！', en:'📊 Come see the report!' });
      sim.boardActive = true;
      if (presentHandler) presentHandler();
      L.timer = 120; L.onTimer = present_settle;
    }, 'task');
  }

  // ─── Visual mode resolution ─────────────────────────────────────────────────
  const CHOREO = new Set(['orch', 'sum', 'jargon', 'comments', 'ctx', 'synth']);
  function vmode(e) {
	    const visualStates = new Set([
	      'walking_to_employee', 'called', 'assigning', 'working', 'waiting',
	      'walking_to_leader', 'reporting', 'returning', 'reviewing',
	      'presenting', 'amb_walk', 'amb_do', 'kb_search', 'recall',
    ]);
    const fsmDriven = !reducedMotion && CHOREO.has(e.id) && (sim.active || visualStates.has(e.state));
    if (!fsmDriven) {
      const t = taskState[e.id];
      if (t === 'done') return 'done';
      if (t === 'typing' || t === 'reading') return 'working';
      return 'idle';
    }
    switch (e.state) {
      case 'idle': return 'idle';
      case 'working': case 'reviewing': return 'working';
      case 'waiting': return 'done';                 // finished, queued at its desk
      case 'assigning': case 'reporting': case 'presenting': case 'kb_search': case 'called': return 'talking';
	      case 'done': return 'done';
	      case 'amb_walk': case 'recall': return 'walking';
      case 'amb_do': return e.ambKind === 'email' ? 'working' : 'idle';
      default: return 'walking';
    }
  }

  // ─── Pixel helpers ──────────────────────────────────────────────────────────
  let canvas, c, animId, reducedMotion = false, tick = 0, clickHandler = null, hoverHandler = null, selected = null, presentHandler = null, onSpecChange = null;
  let kbCount = 0, langMode = 'en', fly = null;   // shelf count, language sign, flying-book anim
  function chan(hx,i){ return parseInt(hx.slice(1+i*2,3+i*2),16); }
  function rgba(hx,a){ return `rgba(${chan(hx,0)},${chan(hx,1)},${chan(hx,2)},${a})`; }
  function shade(hx,f){ const r=Math.max(0,Math.min(255,Math.round(chan(hx,0)*f))),g=Math.max(0,Math.min(255,Math.round(chan(hx,1)*f))),b=Math.max(0,Math.min(255,Math.round(chan(hx,2)*f))); return `rgb(${r},${g},${b})`; }
  function px(n){ return Math.round(n)*SCALE; }
  function rect(x,y,w,h2,color){ c.fillStyle=color; c.fillRect(px(x),px(y),px(w),px(h2)); }
  function dot(x,y,color){ c.fillStyle=color; c.fillRect(px(x),px(y),SCALE,SCALE); }
  function T(t){ return t*TILE; }

  // ─── Background: floor, rug, walls, wall furniture, chairs ──────────────────
  function drawBackground() {
    const wy = WALL * TILE;
    for (let r = WALL; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) rect(col*TILE, r*TILE, TILE, TILE, (col+r)%2 ? FLOOR2 : FLOOR);
      rect(0, r*TILE, LOGICAL_W, 1, SEAM);
    }
    drawRug();
    rect(0, 0, LOGICAL_W, wy, WALLC);
    rect(0, 0, LOGICAL_W, 2, WALLHI);
    rect(0, wy-5, LOGICAL_W, 1, WALLLO);
    rect(0, wy-1, LOGICAL_W, 1, BASEB);
    rect(0, wy, LOGICAL_W, 1, rgba('#000000',0.07));
    drawBookshelf(1,5); drawWindow(6,4); drawLangSign(); drawPoster(11); drawClock(13); drawKitchen(15,4);
    // Chairs are no longer drawn at fixed seats — each agent carries its own
    // workstation (drawDeskSprite travels with the worker), so fixed chairs at the
    // old STATIONS seats were orphaned clutter once the layout became spec-driven.
  }
  // Wall sign that switches the language (双语 / 中 / EN), next to the HN LENS sign.
  function drawLangSign() {
    const x=T(10), y=4, w=14, hh=11;
    rect(x-1,y-1,w+2,hh+2,'#5A4A38');
    rect(x,y,w,hh,'#2F6F4E'); rect(x,y,w,1,'#3F8A63');
    const label = langMode==='en' ? 'EN' : '中';
    c.save();
    c.fillStyle='#FFFFFF'; c.font=`${11}px system-ui, sans-serif`;
    c.textAlign='center'; c.textBaseline='middle';
    c.fillText(label, px(x+w/2), px(y+hh/2)+1);
    c.restore();
    dot(x+1,y+1,'#FFE07A');
  }

  function drawRug() {
    const rx=T(14)+2, ry=T(9)+2, rw=T(6)-4, rh=T(3)-6;
    rect(rx,ry,rw,rh,RUG); rect(rx,ry,rw,1,shade(RUG,1.15));
    c.strokeStyle=RUGE; c.lineWidth=SCALE; c.strokeRect(px(rx+1),px(ry+1),px(rw-2),px(rh-2));
  }
  // The bookshelf is the knowledge base: it fills with more books as the saved
  // term count grows, and shows that count on a little plaque.
  function drawBookshelf(col0, span) {
    const x=T(col0), y=3, w=T(span), hh=TILE+3;
    rect(x,y,w,hh,WOODLO); rect(x,y,w,1,WOODHI);
    const books=['#B23A48','#E0A458','#5B8C5A','#4A6FA5','#8A5BA6','#C97B3A','#6B8E23','#A23E5C'];
    const shown = Math.max(0, Math.min(36, kbCount));        // books visible scale with KB size
    let placed = 0;
    for(let s=0;s<3;s++){ const sy=y+2+s*5; let bx=x+2,i=(s*3)%books.length;
      while(bx<x+w-2){
        const bw=1+(i%2);
        if (placed < shown) rect(bx,sy,bw,4,books[i%books.length]);  // filled book
        else rect(bx,sy+1,bw,3,rgba('#000000',0.06));               // empty slot
        bx+=bw+1; i++; placed++;
      }
      rect(x,sy+4,w,1,WOOD);
    }
    // count plaque on the shelf's bottom edge
    c.save();
    rect(x+w-13, y+hh-4, 12, 5, '#3A2E22'); rect(x+w-13, y+hh-4, 12, 1, '#5A4A38');
    c.fillStyle='#FFE07A'; c.font=`${10}px monospace`; c.textAlign='center'; c.textBaseline='middle';
    c.fillText('📚'+kbCount, px(x+w-7), px(y+hh-1.5));
    c.restore();
  }
  function drawWindow(col0, span) {
    const x=T(col0),y=3,w=T(span),hh=TILE-1;
    rect(x-1,y-1,w+2,hh+2,'#8A7F6A');
    const sky=['#BFE3F2','#CDE9F4','#DCEFF7','#EAF5FB'];
    for(let i=0;i<4;i++) rect(x,y+i*Math.ceil(hh/4),w,Math.ceil(hh/4),sky[i]);
    rect(x,y+hh-3,w,3,'#CFE8D2');
    c.fillStyle='#FFE08A'; c.beginPath(); c.arc(px(x+w-5),px(y+4),px(2.4),0,Math.PI*2); c.fill();
    rect(x+Math.floor(w/2),y,1,hh,'#8A7F6A'); rect(x,y+Math.floor(hh/2),w,1,'#8A7F6A');
  }
  function drawPoster(col) {
    const x=T(col),y=4,w=TILE+4,hh=11;
    rect(x-1,y-1,w+2,hh+2,'#7A6B52'); rect(x,y,w,hh,ACCENT); rect(x,y,w,1,shade(ACCENT,1.2));
    c.save(); c.fillStyle='#FFFFFF'; c.font=`${10}px monospace`; c.textAlign='center'; c.textBaseline='middle';
    c.fillText('HN',px(x+w/2),px(y+4)); c.fillText('LENS',px(x+w/2),px(y+8)); c.restore();
  }
  function drawClock(col) {
    const x=T(col)+8,y=8;
    c.fillStyle='#FFFFFF'; c.beginPath(); c.arc(px(x),px(y),px(3.6),0,Math.PI*2); c.fill();
    c.strokeStyle='#7A6B52'; c.lineWidth=SCALE; c.stroke();
    const a=(tick/240)%(Math.PI*2); c.strokeStyle=DARK; c.lineWidth=SCALE;
    c.beginPath(); c.moveTo(px(x),px(y)); c.lineTo(px(x)+Math.cos(a)*SCALE*2.2,px(y)+Math.sin(a)*SCALE*2.2); c.stroke();
    c.beginPath(); c.moveTo(px(x),px(y)); c.lineTo(px(x)+Math.cos(a*12)*SCALE*1.3,px(y)+Math.sin(a*12)*SCALE*1.3); c.stroke();
  }
  function drawKitchen(col0, span) {
    const x=T(col0),y=4,w=T(span);
    rect(x,3,w,6,'#A8895E'); rect(x,3,w,1,'#C2A372');
    for(let cx=x+3;cx<x+w;cx+=5) rect(cx,4,1,4,WOODLO);
    rect(x,y+5,w,6,'#E7E2D8'); rect(x,y+5,w,1,'#FFFFFF'); rect(x,y+10,w,1,'#B9B2A2');
    // storage jars on the counter (the coffee machine moved to the dining corner)
    rect(x+3,y+2,2,3,'#A3B18A'); rect(x+7,y+2,2,3,'#CBB994'); rect(x+11,y+2,2,3,'#B08968');
  }
  // Desk origin (logical px tile-origin) for a worker. By default the desk sits
  // at the fixed furniture tile (deskOf) so the default run looks byte-for-byte
  // as today (workers walk away while the desk stays put). In a custom-layout
  // run the desk TRAVELS with the worker: origin derived from the worker's
  // current centre with the same offset as the seat→desk relationship
  // (x-8, y+8 maps a worker centred on its seat back onto its desk tile).
  function deskOriginFor(s) {
    if (layoutView()) { const e = chars[s.id]; return [e.x - 8, e.y + 8]; }
    const d = deskOf(s); return [T(d[0]), T(d[1])];
  }
  // ─── Desk (with monitor reflecting its worker's mode) + props ───────────────
  // Effort shows as desk richness: low = compact 1-monitor desk, med = today's,
  // high = a wider, busier 2-monitor desk with a subtle "busy" glow.
  function drawDeskSprite(s) {
    // A benched (disabled) worker has no active workstation — it sleeps in the
    // rest area, so skip drawing a desk for it entirely.
    if (editMode.bench[s.id]) return;
    const [x, y] = deskOriginFor(s);
    const mode = vmode(chars[s.id]);
    const eff = effortDeskSize(s.id);
    const dw = eff.w;                                        // desk width by effort
    // "busy" glow behind a high-effort desk.
    if (eff.glow && mode === 'working') {
      c.save(); c.fillStyle = rgba(chars[s.id].role.shirt, 0.12 + 0.06 * (Math.floor(tick/12)%2));
      roundRect(px(x-1), px(y-1), px(dw+2), px(TILE+1), SCALE); c.fill(); c.restore();
    }
    rect(x+1,y,dw-2,TILE-1,DESK); rect(x+1,y,dw-2,1,DESKHI); rect(x+1,y+TILE-2,dw-2,1,DESKLO);
    rect(x+3,y+1,Math.min(10,dw-6),2,'#9CA3AF');            // keyboard
    rect(x+4,y+1,1,1,'#6B7280'); rect(x+7,y+1,1,1,'#6B7280'); rect(x+10,y+1,1,1,'#6B7280');
    const mx=x+4,my=y+5;                                     // primary monitor
    rect(mx-1,my-1,10,8,'#34302A'); rect(mx,my,8,6,MON);
    drawScreen(mx+1,my+1,6,4,mode,chars[s.id].role.shirt);
    if (eff.monitors >= 2) {                                 // high effort: 2nd monitor
      const m2=x+dw-6; rect(m2-1,my-1,7,8,'#34302A'); rect(m2,my,5,6,MON);
      drawScreen(m2+1,my+1,3,4,mode,chars[s.id].role.shirt);
    }
    drawDeskProp(s,x,y,mode);
  }
  function drawScreen(x,y,w,hh,mode,shirt) {
    if (mode==='done') { rect(x,y,w,hh,rgba('#16A34A',0.6)); c.strokeStyle='#FFFFFF'; c.lineWidth=SCALE*0.8;
      c.beginPath(); c.moveTo(px(x+2),px(y+2)); c.lineTo(px(x+3),px(y+3)); c.lineTo(px(x+5),px(y+1)); c.stroke(); return; }
    if (mode==='working') { rect(x,y,w,hh,rgba(shirt,0.85)); const off=Math.floor(tick/5)%3;
      for(let r=0;r<3;r++) rect(x+1,y+r,2+((r+off)%3),1,'#FFFFFF'); return; }
    rect(x,y,w,hh,rgba(shirt,0.22));
  }
  function drawDeskProp(s,x,y,mode) {
    if (s.id==='orch') { rect(x+1,y+4,4,4,'#A8A29E'); rect(x+1,y+4,4,1,'#D6D3D1'); rect(x+2,y+3,2,1,'#FFFFFF'); }
    if (s.id==='synth') { const pxx=x+TILE,pyy=y;
      rect(pxx+1,pyy+3,9,7,'#9CA3AF'); rect(pxx+1,pyy+3,9,1,'#CBD5E1'); rect(pxx+2,pyy+5,7,1,'#475569');
      if(mode==='done'){ rect(pxx+2,pyy,7,4,'#FFFFFF'); rect(pxx+3,pyy+1,5,1,ACCENT); rect(pxx+3,pyy+2,5,1,'#CBD5E1'); }
    }
  }

  // ─── Floor decor sprites (y-sorted) ─────────────────────────────────────────
  function plantSprite(col,row){ return { baseY:T(row)+14, draw(){ drawPlant(col,row); } }; }
  function drawPlant(col,row){
    const x=T(col)+3,y=T(row)+2;
    rect(x+1,y+7,7,5,'#B07A45'); rect(x,y+8,9,1,'#8A5E32'); rect(x+1,y+11,7,1,WOODLO);
    rect(x+3,y+2,2,6,'#4D7C0F'); rect(x,y+3,4,3,'#65A30D'); rect(x+5,y+2,4,3,'#84CC16'); rect(x+2,y,4,3,'#A3E635');
  }
  // Two massage chairs (按摩椅) in the bottom-right dining corner — this is the
  // rest area now (the old bottom-left 休息区 is gone). Benched/disabled agents
  // walk here and nap in a chair (setAsleep/drawAsleep 💤). Drawn as permanent
  // dining-corner furniture so the corner always reads as a lounge.
  function drawMassageChair(col, row){
    const x = T(col)+2, y = T(row)+1;
    // recliner base + padded back/seat, dark leather with a teal head cushion.
    rect(x, y+3, 12, 9, '#3B3A42'); rect(x, y+3, 12, 1, '#55535E');   // back
    rect(x+1, y+9, 10, 3, '#2C2B32');                                 // seat lip
    rect(x+2, y+1, 8, 3, RUG); rect(x+2, y+1, 8, 1, shade(RUG,1.15)); // head cushion
    rect(x-1, y+5, 2, 5, '#2C2B32'); rect(x+11, y+5, 2, 5, '#2C2B32');// armrests
    dot(x+9, y+5, ACCENT);                                            // control light
  }
  function drawMassageChairs(){
    MASSAGE_CHAIRS.forEach(([col, row]) => drawMassageChair(col, row));
    // Small "休息区" label above the chairs so the corner reads as the rest area.
    c.save(); c.fillStyle = rgba('#1C1917', 0.35);
    c.font = `${9}px system-ui, sans-serif`; c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillText(LZ({ zh:'休息区', en:'Rest area' }), px(T(MASSAGE_CHAIRS[0][0])+2), px(T(MASSAGE_CHAIRS[0][1])-3)); c.restore();
  }
  function drawSofa(){ const sx=T(14),sy=T(9)+1,sw=T(3);
    rect(sx,sy,sw,4,SOFA); rect(sx,sy,sw,1,SOFAHI); rect(sx,sy+4,sw,3,SOFAHI);
    rect(sx,sy+4,1,3,SOFA); rect(sx+sw-1,sy+4,1,3,SOFA); rect(sx+sw/2,sy+4,1,3,shade(SOFA,0.85)); }
  function drawTable(){ const x=T(16)+2,y=T(10); rect(x,y,TILE-2,5,WOOD); rect(x,y,TILE-2,1,WOODHI); dot(x+5,y+2,'#FFFFFF'); }
  // A shared BIG desk for a grouped reader pod ("一起做"): one wide wooden slab
  // centred on the table centre, with the members seated around it. Signals
  // collaboration (vs. separate side-by-side desks = parallel).
  function drawSharedTable(tbl){
    // Draw from the layout's fixed home positions, not live carrier positions.
    // Otherwise a shared table stretches/follows a person when they walk to 合成.
    const homes = tbl.members.map(id => targetPos(id)).filter(Boolean);
    if (!homes.length) return;
    let sx = 0, sy = 0, minX = Infinity, maxX = -Infinity;
    homes.forEach(p => { sx += p.x; sy += p.y; minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); });
    const cx = sx / homes.length, cy = sy / homes.length;
    const w = Math.max(26, (maxX - minX) + 16), h = 12, x = cx - w/2, y = cy - h/2;
    rect(x, y, w, h, WOOD); rect(x, y, w, 1, WOODHI); rect(x, y+h-1, w, 1, WOODLO);
    rect(x+2, y+2, w-4, h-4, shade(WOOD, 1.08));            // tabletop inset
    rect(cx-1, cy-1, 3, 4, '#FFFFFF');                      // shared papers in the middle
    // Each member's small monitor stays at their home seat on the shared slab.
    tbl.members.forEach(id => {
      const e = chars[id], p = targetPos(id);
      if (!e || !p) return;
      const mode = vmode(e);
      const mx = p.x - 4, my = p.y - 8;
      rect(mx-1, my-1, 6, 6, '#34302A'); rect(mx, my, 4, 4, MON);
      drawScreen(mx+0.5, my+0.5, 3, 3, mode, e.role.shirt);
    });
  }
  function drawCooler(){ const x=T(18)+4,y=T(9)+2; rect(x,y+4,7,8,'#E5E7EB'); rect(x,y+4,7,1,'#FFFFFF');
    rect(x+1,y,5,5,rgba('#3B82F6',0.55)); rect(x+1,y,5,1,'#93C5FD'); rect(x+2,y+7,3,1,'#2563EB'); }
  // Coffee machine on a small counter (dining corner).
  function drawCoffeeCounter(){
    const x=T(18),y=T(8);
    rect(x+1,y+9,14,3,'#C9A27A'); rect(x+1,y+9,14,1,'#DCBA8B');   // counter
    rect(x+4,y+2,8,7,'#3F3F46'); rect(x+4,y+2,8,1,'#52525B');     // machine body
    rect(x+5,y+5,6,1,ACCENT);                                     // accent strip
    rect(x+6,y+7,4,2,'#1C1917');                                  // spout / cup well
    if(tick%80<40){ dot(x+8,y+1,rgba('#FFFFFF',0.5)); dot(x+8,y,rgba('#FFFFFF',0.3)); } // steam
    rect(x+1,y+6,2,2,'#EC4899');                                  // a mug
  }
  function drawPet(p) {
    if (p.kind === 'dog') drawDog(p);
    else if (p.kind === 'cat') drawCat(p);
    else drawPika(p);
    if (p.card) drawPetCard(p);
  }
  function petBob(p) {
    return moving(p) ? ((Math.floor(tick/7)%2) ? -1 : 0) : ((Math.floor(tick/45)%2) ? -1 : 0);
  }
  function drawPetCard(p) {
    const label = shortLine(p.card, 4);
    const x = p.x + 5, y = p.y - 5 + petBob(p);
    rect(x,y,13,8,'#FFF7D6'); rect(x,y,13,1,'#F0C078'); rect(x,y+7,13,1,'#D6B36A');
    c.save(); c.fillStyle=DARK; c.font=`${9}px system-ui, sans-serif`; c.textAlign='center'; c.textBaseline='middle';
    c.fillText(label, px(x+6.5), px(y+4)+1); c.restore();
  }
  // A little yellow electric-mouse office mascot (original homage, not the exact sprite).
  function drawPika(p){
    const bob = (Math.floor(tick/40)%2) ? -1 : 0;                  // gentle idle bob
    const x=p.x-4, y=p.y-6+bob;
    const twL = (tick%150 < 10) ? -1 : 0;                          // left ear twitch
    const twR = (tick%190 > 120 && tick%190 < 130) ? -1 : 0;       // right ear twitch
    rect(x,y-3+twL,2,3,'#F2C200'); rect(x+5,y-3+twR,2,3,'#F2C200');// ears
    rect(x,y-3+twL,2,1,'#3A3A3A'); rect(x+5,y-3+twR,2,1,'#3A3A3A');// black ear tips
    rect(x-1,y,9,7,'#FFD23F'); rect(x-1,y,9,1,'#FFE07A');          // body + highlight
    rect(x+6,y,2,7,'#E6B800');                                     // shade
    const blink = (tick%170 > 162 && tick%170 < 168);
    if (blink) { rect(x+1,y+2,1,1,'#1C1917'); rect(x+5,y+2,1,1,'#1C1917'); }
    else {
      dot(x+1,y+2,'#1C1917'); dot(x+5,y+2,'#1C1917');              // eyes
      c.fillStyle='#FFFFFF'; c.fillRect(px(x+1)+SCALE,px(y+2),1,1); c.fillRect(px(x+5)+SCALE,px(y+2),1,1);
    }
    dot(x,y+3,'#E23B3B'); dot(x+6,y+3,'#E23B3B');                  // rosy cheeks
    rect(x+3,y+4,1,1,'#1C1917');                                   // mouth
    rect(x,y+7,2,1,'#E6B800'); rect(x+5,y+7,2,1,'#E6B800');        // feet
    if (tick%220 < 12) { dot(x-2,y+1,'#FDE047'); dot(x+8,y+2,'#FDE047'); } // ⚡ spark
  }
  function drawDog(p){
    const bob = petBob(p), x=p.x-6, y=p.y-5+bob;
    rect(x+1,y+3,12,6,'#B8793A'); rect(x+1,y+3,12,1,'#D49A5A');
    rect(x+9,y,6,6,'#A86F35'); rect(x+10,y+1,5,1,'#C58B4B');
    rect(x+14,y+2,2,2,'#241F1B'); dot(x+12,y+2,'#241F1B');
    rect(x+10,y-2,2,3,'#6B4423'); rect(x+14,y-1,2,3,'#6B4423');
    rect(x+2,y+8,2,3,'#6B4423'); rect(x+9,y+8,2,3,'#6B4423');
    const wag = Math.floor(tick/8)%2 ? -1 : 1;
    rect(x-1,y+3+wag,3,1,'#6B4423');
  }
  function drawCat(p){
    const bob = petBob(p), x=p.x-5, y=p.y-5+bob;
    rect(x+1,y+3,10,6,'#6B7280'); rect(x+1,y+3,10,1,'#9CA3AF');
    rect(x+7,y,6,6,'#4B5563');
    rect(x+8,y-2,2,3,'#4B5563'); rect(x+11,y-2,2,3,'#4B5563');
    dot(x+9,y+2,'#FDE047'); dot(x+12,y+2,'#FDE047'); rect(x+11,y+4,1,1,'#111827');
    rect(x+2,y+8,2,2,'#374151'); rect(x+8,y+8,2,2,'#374151');
    const curl = Math.floor(tick/18)%2;
    rect(x-1,y+2,2,1,'#4B5563'); rect(x-2,y+1-curl,1,2,'#4B5563');
  }
  // Whiteboard easel — blank until 队长 presents, then it fills with a "report".
  function drawWhiteboard(){
    const x=T(WB_TILE[0]), y=T(WB_TILE[1]);
    rect(x+3,y+12,2,3,WOODLO); rect(x+11,y+12,2,3,WOODLO);   // easel legs
    rect(x+1,y,14,12,'#FFFFFF'); rect(x+1,y,14,1,'#E5E7EB'); // board
    c.strokeStyle='#9CA3AF'; c.lineWidth=SCALE; c.strokeRect(px(x+1),px(y),px(14),px(12));
    if (sim.boardActive) {
      rect(x+3,y+2,8,1,ACCENT);                              // title line
      rect(x+3,y+4,7,1,'#3B82F6'); rect(x+3,y+6,9,1,'#14B8A6'); rect(x+3,y+8,6,1,'#8B5CF6');
      // tiny bar chart
      rect(x+11,y+9,1,2,'#3B82F6'); rect(x+12,y+8,1,3,'#F59E0B'); rect(x+13,y+7,1,4,'#EC4899');
    } else {
      rect(x+4,y+5,6,1,'#E5E7EB'); rect(x+4,y+7,4,1,'#E5E7EB');
    }
  }

  // ─── Vote ×N clones (draw-time ghosts; no real sim entities) ────────────────
  // When a stage-1 reader has replicas>1 we draw N-1 faint duplicate silhouettes
  // beside it during idle+work, plus a "×N" tag, to read as "run N times & merge".
  // They MERGE back into one (slide to zero offset, then vanish) once the agent is
  // done. Reduced-motion → static (fixed spread, no slide). Robust: pure drawing,
  // wrapped so it can never throw into the render loop.
  const CLONE_OFFSETS = [                 // per extra clone: [dx, dy] logical px
    [-9, 3], [9, 4],                      // N=2 → 1 ghost (uses first); N=3 → 2 ghosts
  ];
  // A faint, simplified copy of the worker's body+head at (gx feet-centre, gy feet).
  function drawGhostBody(e, cx, feetY, alpha) {
    const shirt = e.role.shirt, hair = e.role.hair;
    const top = feetY - 15;
    c.save();
    c.globalAlpha = alpha;
    // shadow
    c.fillStyle = SHADOW; c.beginPath();
    c.ellipse(px(cx), px(feetY + 1), px(4), px(1.6), 0, 0, Math.PI * 2); c.fill();
    const by = top + 7;
    rect(cx - 5, by, 10, 6, shirt); rect(cx - 5, by, 1, 6, shade(shirt, 1.18));
    rect(cx - 5, top, 10, 5, hair); rect(cx - 4, top - 1, 8, 1, hair);
    rect(cx - 3, top + 5, 6, 3, SKIN);
    c.restore();
  }
  function drawClones(e, mode) {
    let n;
    try { n = replicasOf(e.id); } catch (_) { return; }
    if (n <= 1 || editMode.bench[e.id]) return;
    if (mode === 'done') return;            // finished → clones have merged into one
    const ghosts = Math.min(n - 1, CLONE_OFFSETS.length);
    const feetY = e.y + 6;
    const wob = reducedMotion ? 0 : (Math.floor(tick / 10) % 2 ? 1 : 0);
    for (let i = 0; i < ghosts; i++) {
      const off = CLONE_OFFSETS[i];
      const gx = e.x + off[0];
      const gy = feetY + off[1] + (i % 2 ? wob : -wob);
      drawGhostBody(e, gx, gy, 0.28);
    }
  }
  // The "×N" tag floating above a replicated worker (drawn with the sprite).
  function drawReplicaTag(e) {
    let n;
    try { n = replicasOf(e.id); } catch (_) { return; }
    if (n <= 1 || editMode.bench[e.id]) return;
    const label = '×' + n;
    const x = e.x + 6, y = e.y - 15 - 7;
    c.save();
    c.fillStyle = rgba(e.role.shirt, 0.92);
    roundRect(px(x - 6), px(y - 4), px(13), px(9), SCALE); c.fill();
    c.fillStyle = '#FFFFFF';
    c.font = `${9}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, px(x + 0.5), px(y) + 1);
    c.restore();
  }

  // ─── Character sprite (4 facings + walk) ────────────────────────────────────
  function drawCharacter(e) {
    const mode = e.asleep ? 'idle' : vmode(e);              // asleep → calm, dim, no activity
    if (!editMode.on) drawClones(e, mode);                  // ghosts behind the real sprite
    const isMoving = !e.asleep && moving(e);
    let bob = 0;
    if (e.asleep) bob = 0;
    else if (isMoving) bob = (Math.floor(tick/8)%2) ? -1 : 0;
    else if (mode==='idle') bob = (Math.floor(tick/45)%2) ? -1 : 0;
    else if (mode==='working') bob = (Math.floor(tick/7)%2) ? -1 : 0;
    else if (mode==='done') bob = (Math.floor(tick/20)%2) ? -1 : 0;

    const cx = e.x, feetY = e.y + 6, top = feetY - 15 + bob;
    const shirt = e.role.shirt, hair = e.role.hair, f = e.facing;

    // shadow
    c.fillStyle = SHADOW; c.beginPath();
    c.ellipse(px(cx), px(feetY+1), px(5), px(2), 0, 0, Math.PI*2); c.fill();

    // legs / feet (walk cycle)
    const step = isMoving ? (Math.floor(tick/8)%2 ? 1 : -1) : 0;
    rect(cx-3+ (step<0?-1:0), feetY-3, 2, 3, shade(shirt,0.7));
    rect(cx+1+ (step>0?1:0),  feetY-3, 2, 3, shade(shirt,0.7));

    // body
    const by = top + 7;
    rect(cx-5, by, 10, 6, shirt);
    rect(cx+3, by, 2, 6, shade(shirt,0.8));
    rect(cx-5, by, 1, 6, shade(shirt,1.18));
    if (f!=='up') rect(cx-1, by, 2, 2, '#FFFFFF');           // collar (front)

    drawArms(e, cx, by, mode, isMoving);
    if (e.carryDoc) drawHeldReport(cx, by, e.facing);

    // hair crown
    rect(cx-5, top, 10, 5, hair); rect(cx-4, top-1, 8, 1, hair); rect(cx-5, top, 10, 1, shade(hair,1.25));
    rect(cx-5, top+5, 2, 2, hair); rect(cx+3, top+5, 2, 2, hair);

    // face by facing
    if (f==='down') {
      rect(cx-3, top+5, 6, 3, SKIN); rect(cx+2, top+5, 1, 3, SKINSH);
      rect(cx-4, top+5, 1, 2, SKIN); rect(cx+3, top+5, 1, 2, SKIN);
      drawFaceDown(e, cx, top, mode);
    } else if (f==='up') {
      rect(cx-3, top+5, 6, 2, hair);                          // back of head, no face
    } else {
      const dir = f==='right' ? 1 : -1;
      rect(cx-3, top+5, 6, 3, SKIN);
      rect(cx + (dir>0?2:-3), top+5, 1, 3, SKINSH);
      dot(cx + dir*1, top+6, DARK);                           // single eye
      if (e.role.glasses) { c.strokeStyle=DARK; c.lineWidth=1; c.strokeRect(px(cx+dir*1-0.5),px(top+5),px(2),px(2)); }
    }

    if (e.asleep) drawAsleep(cx, top); else drawHeadDecor(e, cx, top, mode);
    if (!editMode.on) drawReplicaTag(e);                    // "×N" tag for vote-N workers
  }

  // A teammate whose agent runtime failed: closed eyes + a drifting 💤.
  function drawAsleep(cx, top) {
    // overdraw closed eyes
    rect(cx-3, top+6, 2, 1, DARK); rect(cx+1, top+6, 2, 1, DARK);
    const f = Math.floor(tick/26) % 3;
    c.save();
    c.fillStyle = '#6B7280'; c.font = `${9}px system-ui, sans-serif`;
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText('z', px(cx+4), px(top-2) - f*SCALE*2);
    c.fillText('z', px(cx+6), px(top-4) - f*SCALE*2);
    c.restore();
  }

  function drawHeldReport(cx, by, facing) {
    const side = facing === 'left' ? -1 : 1;
    const x = cx + side * 6, y = by + 1;
    rect(x - 2, y - 2, 5, 7, '#FFFFFF');
    rect(x - 2, y - 2, 5, 1, ACCENT);
    rect(x - 1, y, 3, 1, '#9CA3AF');
    rect(x - 1, y + 2, 3, 1, '#CBD5E1');
  }

  function drawArms(e, cx, by, mode, isMoving) {
    const shirt = e.role.shirt;
    if (isMoving) {
      const sw = Math.floor(tick/8)%2 ? 1 : -1;
      rect(cx-6, by+1+(sw>0?1:0), 1, 3, shirt); rect(cx+5, by+1+(sw<0?1:0), 1, 3, shirt);
    } else if (mode==='working') {
      const alt = Math.floor(tick/7)%2;
      rect(cx-6, by+2, 1, 3, shirt); rect(cx+5, by+2, 1, 3, shirt);
      rect(cx-6, by+5-(alt?1:0), 2, 1, SKIN); rect(cx+5, by+5-(alt?0:1), 2, 1, SKIN);
    } else if (mode==='talking') {
      const g = Math.floor(tick/10)%2;
      rect(cx-6, by, 1, 3, shirt); rect(cx+5, by-(g?1:0), 1, 3, shirt);  // a gesturing arm
      rect(cx+5, by-1-(g?1:0), 2, 1, SKIN);
    } else {
      rect(cx-6, by+1, 1, 4, shirt); rect(cx+5, by+1, 1, 4, shirt);
      rect(cx-6, by+4, 2, 1, SKIN); rect(cx+5, by+4, 2, 1, SKIN);
    }
  }

  function drawFaceDown(e, cx, top, mode) {
    const ey = top + 6;
    const blink = (mode!=='done') && (tick%150 > 142 && tick%150 < 147);
    if (mode==='done') {
      dot(cx-2,ey-1,DARK); dot(cx-3,ey,DARK); dot(cx+1,ey-1,DARK); dot(cx+2,ey,DARK);
      rect(cx-1,ey+1,3,1,'#A14A4A');
    } else if (blink) { rect(cx-2,ey,1,1,DARK); rect(cx+1,ey,1,1,DARK); }
    else {
      dot(cx-2,ey,DARK); dot(cx+1,ey,DARK);
      c.fillStyle='#FFFFFF'; c.fillRect(px(cx-2)+SCALE,px(ey),1,1); c.fillRect(px(cx+1)+SCALE,px(ey),1,1);
    }
    if (e.role.glasses) { c.strokeStyle=DARK; c.lineWidth=1; c.strokeRect(px(cx-3),px(ey-1),px(2),px(2)); c.strokeRect(px(cx),px(ey-1),px(2),px(2)); dot(cx-1,ey-1,DARK); }
  }

  function drawHeadDecor(e, cx, top, mode) {
    if (e.role.acc==='lead' && e.facing!=='up') {
      rect(cx-6,top+1,1,3,'#3F3F46'); rect(cx+5,top+1,1,3,'#3F3F46'); rect(cx-6,top,12,1,'#52525B'); dot(cx-6,top+4,ACCENT);
    }
    if (e.role.acc==='phones') { rect(cx-6,top+2,1,3,e.role.shirt); rect(cx+5,top+2,1,3,e.role.shirt); rect(cx-6,top+1,12,1,shade(e.role.shirt,0.8)); }
    if (mode==='working') {
      drawThinkDots(cx-3, top-7, e.role.shirt);
      // tiny progress bar for choreographed workers (have a workStart)
      if (CHOREO.has(e.id) && e.id!=='orch' && e.workStart) { const p=Math.min((tick-e.workStart)/MIN_WORK,1);
        rect(cx-4,top-2,8,1,rgba('#000000',0.15)); rect(cx-4,top-2,Math.max(1,8*p),1,e.role.shirt); }
    } else if (e.state==='waiting') {
      drawWaitIcon(cx, top-8);                        // finished, queued to report
    } else if (mode==='done') {
      if (e.id==='jargon') drawBulb(cx-1, top-9); else drawSparkle(cx, top-8, e.role.shirt);
    }
  }
  function drawWaitIcon(x, y) {                        // little clock = waiting in line
    c.fillStyle='#FFFFFF'; c.beginPath(); c.arc(px(x),px(y+1),px(3),0,Math.PI*2); c.fill();
    c.strokeStyle='#6B7280'; c.lineWidth=SCALE*0.7; c.stroke();
    const a=(tick/30)%(Math.PI*2); c.strokeStyle=DARK; c.lineWidth=SCALE*0.7;
    c.beginPath(); c.moveTo(px(x),px(y+1)); c.lineTo(px(x)+Math.cos(a)*SCALE*1.6,px(y+1)+Math.sin(a)*SCALE*1.6); c.stroke();
    c.beginPath(); c.moveTo(px(x),px(y+1)); c.lineTo(px(x),px(y+1)-SCALE*1.1); c.stroke();
  }
  function drawThinkDots(x,y,color){ rect(x-1,y,9,4,'#FFFFFF'); rect(x-1,y,9,1,rgba(color,0.4));
    const lit=Math.floor(tick/6)%3; for(let i=0;i<3;i++) rect(x+i*2,y+1,1,2,i===lit?color:rgba(color,0.25)); }
  function drawBulb(x,y){ const p=Math.floor(tick/14)%2,col=p?'#FDE047':'#F59E0B';
    c.fillStyle=rgba('#FDE68A',p?0.6:0.3); c.beginPath(); c.arc(px(x+2),px(y+2),px(4.5),0,Math.PI*2); c.fill();
    rect(x,y,4,3,col); rect(x-1,y+1,6,2,col); rect(x,y+3,4,1,'#92400E'); rect(x+1,y+4,2,1,'#78350F'); dot(x+1,y+1,'#FEF9C3');
    if(p){ dot(x-3,y,col); dot(x+6,y,col); dot(x+1,y-2,col); } }
  function drawSparkle(x,y,color){ const p=Math.floor(tick/18)%2,b=p?color:rgba(color,0.55);
    rect(x,y-1,1,3,b); rect(x-1,y,3,1,b); dot(x-1,y-1,rgba(color,0.4)); dot(x+1,y-1,rgba(color,0.4)); dot(x-1,y+1,rgba(color,0.4)); dot(x+1,y+1,rgba(color,0.4)); }

  // ─── Overlays: name plates + speech bubbles ─────────────────────────────────
  // Nameplates drawn this frame, so a plate whose box would collide with an
  // already-drawn one (English names run much wider than the original 2-char
  // Chinese ones, so neighbouring desks can now sit closer than the text is
  // wide) can drop to a second line instead of getting painted over.
  const drawnPlateRects = [];
  function drawNamePlate(s) {
    const e = chars[s.id], mode = vmode(e);
    // A benched (disabled) worker has no desk; it sleeps in the rest area with a
    // 💤, so its desk-anchored nameplate is omitted.
    if (editMode.bench[s.id]) return;
    const [dx, dy] = deskOriginFor(s);
    const cx = dx+8, ly = dy+TILE-2;
    const bx = dx+1;
    if (mode==='done') { rect(bx,ly+1,4,4,'#16A34A'); dot(bx+1,ly+2,'#FFFFFF'); dot(bx+2,ly+3,'#FFFFFF'); dot(bx+3,ly+1,'#FFFFFF'); }
    else if (mode==='working') { const p=Math.floor(tick/10)%2; rect(bx,ly+1,4,4,p?e.role.shirt:rgba(e.role.shirt,0.45)); }
    else rect(bx,ly+1,4,4,'#CFC4B4');
    c.save(); c.font=`${13}px monospace`; c.textAlign='center'; c.textBaseline='middle';
    const nameStr = LZ(e.role.name);
    const w=c.measureText(nameStr).width;
    // English names (e.g. "Synthesizer") run much wider than the original 2-char
    // Chinese names, so desks near the grid edge can push the plate past the
    // canvas boundary — clamp its centre so the whole plate stays on-screen.
    const plateCx = Math.max(w/2+2+SCALE, Math.min(px(cx), canvas.width-w/2-2-SCALE));
    let plateTop = px(ly) - 1;
    const plateH = px(5);
    const left = plateCx - w/2 - 2, right = plateCx + w/2 + 2;
    // If this box's x-range overlaps a plate already drawn at ~the same row,
    // drop it to the next line down so the two stay legible instead of one
    // painting over the other.
    for (const r of drawnPlateRects) {
      if (Math.abs(r.top - plateTop) < plateH && left < r.right && right > r.left) {
        plateTop = r.top + plateH + 1;
      }
    }
    drawnPlateRects.push({ left, right, top: plateTop });
    c.fillStyle=rgba('#FFFFFF',0.72); c.fillRect(left, plateTop, w+4, plateH);
    c.fillStyle=(mode==='idle')?'#9C9384':(e.id==='jargon'?e.role.shirt:LABEL);
    c.fillText(nameStr, plateCx+SCALE, plateTop+plateH/2+1.5); c.restore();
  }
  function drawBubble(e) {
    // talk bubbles (assign/report) take priority; while working, show the live
    // SSE status so you can read what this agent is doing right now.
    const isLive = !e.bubble && vmode(e) === 'working';
    const raw = e.bubble || (isLive ? e.statusText : '');
    if (!raw) return;

    const fs = 13;
    c.save();
    c.font = `${fs}px system-ui, sans-serif`;
    // Talk bubbles stay short (1 line); live status wraps to up to 2 lines so
    // longer step text ("通读全文 2 段…", "聚类派别分析中…") is readable. Character
    // budgets are per-language: English needs ~3x the characters Chinese does to
    // say the same thing, so a Chinese-calibrated budget clips English mid-word.
    const shortMax = langMode === 'en' ? 26 : 8;
    const wrapPerLine = langMode === 'en' ? 22 : 11;
    const lines = isLive ? wrapBubble(raw, wrapPerLine, 2) : [shortLine(raw, shortMax)];
    const padX = 5, padY = 3, lh = fs + 2;
    let tw = 0; for (const ln of lines) tw = Math.max(tw, c.measureText(ln).width);
    const bW = tw + padX * 2, bH = lines.length * lh + padY * 2 - 2;
    let bx = px(e.x) - bW / 2; bx = Math.max(SCALE, Math.min(bx, canvas.width - bW - SCALE));
    const yTop = px(e.y + 6 - 15) - bH - SCALE * 2;

    c.fillStyle = '#FFFFFF'; c.strokeStyle = '#D1D5DB'; c.lineWidth = SCALE * 0.6;
    roundRect(bx, yTop, bW, bH, SCALE * 1.6); c.fill(); c.stroke();
    const mid = px(e.x);
    c.beginPath(); c.moveTo(mid - SCALE * 1.5, yTop + bH - 1); c.lineTo(mid, yTop + bH + SCALE * 2.5); c.lineTo(mid + SCALE * 1.5, yTop + bH - 1); c.closePath();
    c.fillStyle = '#FFFFFF'; c.fill();
    c.fillStyle = DARK; c.textAlign = 'left'; c.textBaseline = 'top';
    lines.forEach((ln, i) => c.fillText(ln, bx + padX, yTop + padY + i * lh));
    c.restore();
  }
  function shortLine(s, max) {
    const a = [...s];
    if (a.length <= max) return s;
    const cut = a.slice(0, max - 1).join('');
    // Prefer breaking at a word boundary (latin text) so words aren't cut mid-way;
    // Chinese has no spaces so this always falls through to the hard character cut.
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
  }
  function wrapBubble(s, perLine, maxLines) {
    // Latin text (has spaces): greedy word-wrap so words don't split across lines.
    if (s.includes(' ')) {
      const words = s.split(' '), lines = [];
      let cur = '';
      for (const word of words) {
        const candidate = cur ? cur + ' ' + word : word;
        if ([...candidate].length > perLine && cur) { lines.push(cur); cur = word; }
        else cur = candidate;
        if (lines.length === maxLines) break;
      }
      if (lines.length < maxLines && cur) lines.push(cur);
      if (lines.length === maxLines && [...lines.join(' ')].length < [...s].length) {
        lines[maxLines - 1] = shortLine(lines[maxLines - 1], perLine);
      }
      return lines;
    }
    // CJK text (no spaces): hard character-slice per line, same as before.
    const a = [...s], lines = [];
    for (let i = 0; i < a.length && lines.length < maxLines; i += perLine) lines.push(a.slice(i, i + perLine).join(''));
    if (a.length > perLine * maxLines) lines[maxLines - 1] = [...lines[maxLines - 1]].slice(0, perLine - 1).join('') + '…';
    return lines;
  }
  function roundRect(x,y,w,h2,r){ c.beginPath(); c.moveTo(x+r,y); c.arcTo(x+w,y,x+w,y+h2,r); c.arcTo(x+w,y+h2,x,y+h2,r); c.arcTo(x,y+h2,x,y,r); c.arcTo(x,y,x+w,y,r); c.closePath(); }

  // ─── Render (Y-sorted) ──────────────────────────────────────────────────────
  function render() {
    if (!canvas || !c) return;
    c.imageSmoothingEnabled = false;
    c.clearRect(0,0,canvas.width,canvas.height);
    drawBackground();
    if (editMode.on) drawEditUnderlay();   // bench + pod rects read under the characters

    // Spec-driven pods: draw the shared-table cluster outline + 平行/接力 badge
    // under the characters (subtler than edit mode) so teaming stays readable in
    // the idle office as well as during a run.
    if (!editMode.on && layoutView()) drawRunPods();
    // The one meaningful dependency edge (小词→小导), under the sprites.
    if (SHOW_DEP_EDGE && !editMode.on && layoutView()) drawDepEdge();
    const sprites = [];
    // Shared big tables for grouped reader pods (drawn as floor furniture, y-sorted).
    computed.tables.forEach(tbl => {
      const homes = tbl.members.map(id => targetPos(id)).filter(Boolean);
      // Sort the table UNDER every seated member so nobody hides behind the slab:
      // baseY = a hair above the topmost member's feet (minY - 1). Members' own
      // sprites use baseY = e.y + 6, and every member sits at/below the table
      // centre, so this keeps the slab strictly first in the y-sort.
      const minY = homes.length ? homes.reduce((m, p) => Math.min(m, p.y), Infinity) : tbl.cy * TILE + 8;
      sprites.push({ baseY: minY - 1, draw: () => drawSharedTable(tbl) });
    });
    // Pod members share ONE big table (drawn above) instead of individual desks,
    // so their monitors sit on the shared slab and it reads as "working together".
    const grouped = new Set();
    computed.tables.forEach(t => t.members.forEach(id => grouped.add(id)));
    STATIONS.forEach(s => {
      if (editMode.bench[s.id]) return;      // benched: no desk (sleeps in rest area)
      if (grouped.has(s.id)) return;         // grouped: uses the shared table
      const [, dy] = deskOriginFor(s);
      sprites.push({ baseY:dy+TILE, draw:()=>drawDeskSprite(s) });
    });
    sprites.push({ baseY:T(10)+12, draw:drawMassageChairs }); // dining-corner rest chairs
    sprites.push({ baseY:T(10),    draw:drawSofa });
    sprites.push({ baseY:T(11),    draw:drawTable });
    sprites.push({ baseY:T(9),     draw:drawCoffeeCounter });   // dining corner
    sprites.push({ baseY:T(10),    draw:drawCooler });
    sprites.push({ baseY:T(WB_TILE[1])+12, draw:drawWhiteboard });
    [[1,10],[6,10],[18,3],[11,10]].forEach(([col,row]) => sprites.push(plantSprite(col,row)));
    Object.values(chars).forEach(e => sprites.push({ baseY:e.y+6, draw:()=>drawCharacter(e) }));
    Object.values(pets).forEach(p => sprites.push({ baseY:p.y+5, draw:()=>drawPet(p) }));

    sprites.sort((a,b)=>a.baseY-b.baseY).forEach(sp => sp.draw());

    drawnPlateRects.length = 0;   // reset per-frame collision tracking for nameplates
    STATIONS.forEach(drawNamePlate);
    Object.values(chars).forEach(drawBubble);
    Object.values(pets).forEach(drawBubble);
    if (selected && chars[selected]) drawSelectionMarker(chars[selected]);
    if (fly) drawFlyingBook();
    if (customRunView()) drawRunDocs();    // documents are now carried by people; runDocs stays empty (kept as a no-op)
    if (editMode.on) drawEditOverlay();    // badges, greyed benched workers, hint
    if (editMode.debate && !editMode.bench.ctx) drawDebateCue();   // 🥊 floating tag on 小导
    drawTokenMeter();                      // live estimate / actual token readout
  }

  // ─── 🥊 辩论裁定 cue ─────────────────────────────────────────────────────────
  // A small floating tag above 小导 when debate mode is on, so the office shows
  // the verdict is adjudicated (正方 vs 反方), not a single call. Purely a label —
  // no extra sprites/animation (keeps the room calm, per the flow-line removal).
  function drawDebateCue() {
    try {
      const p = targetPos('ctx');
      if (!p) return;
      c.save();
      c.font = `${9}px system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const label = LZ({ zh: '🥊 正方 vs 反方', en: '🥊 Pro vs Con' });
      const w = c.measureText(label).width + SCALE * 4;
      const bx = px(p.x), by = px(p.y) - SCALE * 14;
      c.fillStyle = 'rgba(17,24,39,0.82)';
      roundRect(bx - w / 2, by - SCALE * 6, w, SCALE * 12, SCALE * 3);
      c.fill();
      c.fillStyle = '#FDE68A';
      c.fillText(label, bx, by + 1);
      c.restore();
    } catch (_) { /* never break the render loop */ }
  }

  // ─── 小词 → 小导 dependency edge ─────────────────────────────────────────────
  // The single meaningful semantic dependency in the workflow: 小导 (verdict)
  // reads 小词's jargon density to gauge reading accessibility. Unlike the old
  // doc-flow connectors (removed for noise), this is ONE static, dotted
  // "reference" line — no animation, no per-leg fan-out — drawn only when both
  // agents are active, so it reads as a data dependency, not document traffic.
  function drawDepEdge() {
    try {
      if (editMode.bench.jargon || editMode.bench.ctx) return;
      const a = targetPos('jargon'), b = targetPos('ctx');
      if (!a || !b) return;
      let ax = px(a.x), ay = px(a.y), bx = px(b.x), by = px(b.y);
      // Trim both ends so the line runs desk-to-desk and the arrowhead clears
      // 小导's sprite (drawn on top of this line).
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, pad = SCALE * 10;
      ax += ux * pad; ay += uy * pad; bx -= ux * pad; by -= uy * pad;
      c.save();
      c.lineCap = 'round';
      c.strokeStyle = rgba('#14B8A6', 0.22);   // teal — distinct from the old flow palette
      c.lineWidth = Math.max(1, SCALE * 0.7);
      c.setLineDash([SCALE * 1.5, SCALE * 2.5]);
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
      c.setLineDash([]);
      // Small arrowhead at the 小导 end to show direction (小词 → 小导).
      const ang = Math.atan2(by - ay, bx - ax), head = SCALE * 3;
      c.fillStyle = rgba('#14B8A6', 0.3);
      c.beginPath();
      c.moveTo(bx, by);
      c.lineTo(bx - head * Math.cos(ang - 0.4), by - head * Math.sin(ang - 0.4));
      c.lineTo(bx - head * Math.cos(ang + 0.4), by - head * Math.sin(ang + 0.4));
      c.closePath(); c.fill();
      c.restore();
    } catch (_) { /* never break the render loop */ }
  }

  // ─── Custom-layout run overlays ─────────────────────────────────────────────
  // Pod outline + mode badge while a custom run plays (subtler than edit mode).
  // For relay pods the members are numbered 1→2→… in run order, and the
  // currently-active member (working) gets a brighter ring.
  function drawRunPods() {
    workflowPods().forEach(pod => {
      if (pod.length < 2) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      pod.forEach(id => { const e = posOf(id);   // group box tracks the grouping coords (layout), not the live/wandering sprite — otherwise it stretches across the room
        minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x);
        minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y);
      });
      const pad = 9;
      const x = minX - pad, y = minY - 16, w = (maxX - minX) + pad * 2, h = (maxY - minY) + 26;
      const relay = podModeOf(pod) === 'relay';
      const stroke = relay ? '#8B5CF6' : '#14B8A6';
      c.save();
      c.fillStyle = relay ? rgba('#8B5CF6', 0.07) : rgba('#14B8A6', 0.07);
      roundRect(px(x), px(y), px(w), px(h), SCALE * 2.5); c.fill();
      c.strokeStyle = rgba(stroke, 0.42);
      c.lineWidth = SCALE; c.stroke();
      // Mode badge centred above the pod.
      const label = LZ(relay ? { zh:'接力', en:'Relay' } : { zh:'平行', en:'Parallel' });
      c.font = `${10}px system-ui, sans-serif`;
      const bw = Math.max(26, c.measureText(label).width + 10), bh = 11;
      const bx = (minX + maxX) / 2 - bw / 2, by = minY - 16 - bh - 2;
      c.fillStyle = rgba(stroke, 0.85);
      roundRect(px(bx), px(by), px(bw), px(bh), SCALE * 1.5); c.fill();
      c.fillStyle = '#FFFFFF';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label, px(bx + bw / 2), px(by + bh / 2) + 1);
      c.restore();
      // Relay: draw the conveyor as a dashed line threading the members in run
      // order, number them 1→2→…, and highlight the member currently HOLDING the
      // doc (the live cursor during a run; member 1 when idle). This is what makes
      // a relay read as "one doc travelling down a line" vs. parallel's cluster.
      if (relay) {
        const order = podOrder(pod);
        // The chain's live cursor (which member currently holds the doc), if this
        // pod is an active relay chain in the running sim; else -1 (idle office).
        let holder = -1;
        if (sim.relayChains) {
          for (let ci = 0; ci < sim.relayChains.length; ci++) {
            if (podKey(sim.relayChains[ci]) === podKey(order)) {
              holder = sim.relayState[ci] && sim.relayState[ci].delivered
                ? order.length : (sim.relayState[ci] ? sim.relayState[ci].i : 0);
              break;
            }
          }
        }
        // Conveyor line linking consecutive members (drawn under the badges).
        if (order.length >= 2) {
          c.save();
          c.strokeStyle = rgba('#8B5CF6', 0.5); c.lineWidth = SCALE;
          c.setLineDash([SCALE * 2, SCALE * 2]);
          c.beginPath();
          order.forEach((id, i) => {
            const e = chars[id]; const lx = px(e.x), ly = px(e.y - 18);
            if (i === 0) c.moveTo(lx, ly); else c.lineTo(lx, ly);
          });
          c.stroke();
          c.setLineDash([]);
          c.restore();
        }
        order.forEach((id, i) => {
          const e = chars[id];
          const active = i === holder;                 // the current doc-holder
          const nx = e.x - 8, ny = e.y - 18;
          c.save();
          c.fillStyle = active ? '#8B5CF6' : rgba('#8B5CF6', 0.45);
          c.beginPath(); c.arc(px(nx), px(ny), px(active ? 3.4 : 2.8), 0, Math.PI * 2); c.fill();
          c.fillStyle = '#FFFFFF';
          c.font = `${9}px system-ui, sans-serif`;
          c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(String(i + 1), px(nx), px(ny) + 1);
          c.restore();
        });
      }
    });
  }

  // Result documents flying left→right through the pipeline waypoints (a simple
  // per-segment lerp with a little arc). Each doc carries an ordered `wps` list;
  // it advances one segment at a time, and is removed after the last waypoint.
  const DOC_SEG = 34;   // frames per pipeline hop
  function drawRunDocs() {
    for (let i = runDocs.length - 1; i >= 0; i--) {
      const d = runDocs[i];
      d.t++;
      const p = Math.min(d.t / DOC_SEG, 1);
      // segment endpoints: from the previous waypoint (or spawn) to the next.
      const from = d.seg === 0 ? { x: d.x0, y: d.y0 } : d.wps[d.seg - 1];
      const to = d.wps[d.seg];
      const cx = from.x + (to.x - from.x) * p;
      const cy = from.y + (to.y - from.y) * p - Math.sin(p * Math.PI) * 14;
      rect(cx - 2, cy - 3, 5, 6, '#FFFFFF'); rect(cx - 2, cy - 3, 5, 1, d.color);
      rect(cx - 1, cy - 1, 3, 1, '#9CA3AF'); rect(cx - 1, cy + 1, 3, 1, '#9CA3AF');
      if (p >= 1) {
        d.seg++; d.t = 0;
        if (d.seg >= d.wps.length) runDocs.splice(i, 1);   // reached the end
      }
    }
  }

  // Rest-corner drop-zone highlight + translucent pod rects, drawn before
  // characters so they read clearly underneath them.
  function drawEditUnderlay() {
    // Subtle highlight around the two massage chairs — the "拖到这里 = 停用 / 休息区"
    // drop-zone. A soft wash + dashed outline so it reads as a target, and a
    // hint label just above the chairs.
    c.save();
    rect(REST_ZONE.x, REST_ZONE.y, REST_ZONE.w, REST_ZONE.h, rgba('#F59E0B', 0.14));
    c.strokeStyle = rgba('#B45309', 0.5); c.lineWidth = SCALE;
    if (c.setLineDash) c.setLineDash([3 * SCALE, 3 * SCALE]);
    c.strokeRect(px(REST_ZONE.x), px(REST_ZONE.y), px(REST_ZONE.w), px(REST_ZONE.h));
    if (c.setLineDash) c.setLineDash([]);
    c.fillStyle = rgba('#1C1917', 0.55);
    c.font = `${9}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.fillText(LZ({ zh:'休息区 · 拖到这里=停用', en:'Rest area · drag here to disable' }), px(REST_ZONE.x + REST_ZONE.w / 2), px(REST_ZONE.y - 1));
    c.restore();
    // Pod rects (only multi-member pods get a visible cluster box).
    computePods().forEach(pod => {
      if (pod.length < 2) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      pod.forEach(id => { const e = posOf(id);   // group box tracks the grouping coords (layout), not the live/wandering sprite — otherwise it stretches across the room
        minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x);
        minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y);
      });
      const pad = 9;
      const x = minX - pad, y = minY - 16, w = (maxX - minX) + pad * 2, h = (maxY - minY) + 26;
      const relay = podModeOf(pod) === 'relay';
      c.save();
      c.fillStyle = relay ? rgba('#8B5CF6', 0.14) : rgba('#14B8A6', 0.14);
      roundRect(px(x), px(y), px(w), px(h), SCALE * 2.5); c.fill();
      c.strokeStyle = relay ? rgba('#8B5CF6', 0.55) : rgba('#14B8A6', 0.55);
      c.lineWidth = SCALE; c.stroke();
      c.restore();
    });
  }

  // Effort badge dots (● / ●● / ●●●) for a level, coloured by the worker.
  const EFFORT_DOTS = { low: '●', med: '●●', high: '●●●' };
  // Draw a clickable effort badge just under a worker's feet. Registers a hit
  // rect in editMode.effortBadges so a click cycles low→med→high.
  function drawEffortBadge(id) {
    const e = chars[id];
    const lvl = effortOf(id);
    const label = EFFORT_DOTS[lvl];
    const bw = 22, bh = 10;
    const bx = e.x - bw / 2, by = e.y + 9;
    editMode.effortBadges.push({ x: bx, y: by, w: bw, h: bh, id });
    c.save();
    c.fillStyle = rgba('#1C1917', 0.82);
    roundRect(px(bx), px(by), px(bw), px(bh), SCALE * 1.4); c.fill();
    c.fillStyle = e.role.shirt;
    c.font = `${9}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, px(bx + bw / 2), px(by + bh / 2) + 1);
    c.restore();
  }

  // Clickable replicas badge (⧉×N) just under the effort badge. Registers a hit
  // rect in editMode.replicaBadges so a click cycles 1→2→3→1. Only shown when >1
  // would be meaningful — it's always drawn for enabled stage-1 readers so the
  // user can discover it, but stays subtle at ×1.
  function drawReplicaBadge(id) {
    const e = chars[id];
    const n = replicasOf(id);
    const label = '⧉×' + n;
    const bw = 24, bh = 10;
    const bx = e.x - bw / 2, by = e.y + 9 + 11;   // sits just below the effort badge
    editMode.replicaBadges.push({ x: bx, y: by, w: bw, h: bh, id });
    c.save();
    // Brighter chip when active (×2/×3) so vote-N pops; muted at ×1.
    const active = n > 1;
    c.fillStyle = active ? rgba(e.role.shirt, 0.9) : rgba('#1C1917', 0.55);
    roundRect(px(bx), px(by), px(bw), px(bh), SCALE * 1.4); c.fill();
    c.fillStyle = '#FFFFFF';
    c.font = `${9}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(label, px(bx + bw / 2), px(by + bh / 2) + 1);
    c.restore();
  }

  // Greyed benched workers, the clickable mode badges, and a subtle hint.
  function drawEditOverlay() {
    editMode.badges = [];
    editMode.effortBadges = [];
    editMode.replicaBadges = [];
    // Per-worker effort knob (only for effort nodes that are enabled).
    EFFORT_NODES.forEach(id => { if (!editMode.bench[id]) drawEffortBadge(id); });
    // Per-worker replicas knob (vote ×N) for enabled stage-1 readers.
    REPLICA_NODES.forEach(id => { if (!editMode.bench[id]) drawReplicaBadge(id); });
    // Grey out benched workers with a wash.
    EDITABLE.forEach(id => {
      if (!editMode.bench[id]) return;
      const e = chars[id];
      c.save();
      c.fillStyle = rgba('#1C1917', 0.42);
      roundRect(px(e.x - 7), px(e.y - 16), px(14), px(24), SCALE); c.fill();
      c.restore();
    });
    // Mode badges, one per multi-member pod, centred above the pod.
    computePods().forEach(pod => {
      if (pod.length < 2) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity;
      pod.forEach(id => { const e = chars[id];
        minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x); minY = Math.min(minY, e.y);
      });
      const relay = podModeOf(pod) === 'relay';
      const label = LZ(relay ? { zh:'接力', en:'Relay' } : { zh:'平行', en:'Parallel' });
      c.font = `${10}px system-ui, sans-serif`;
      const bw = Math.max(26, c.measureText(label).width + 10), bh = 11;
      const bx = (minX + maxX) / 2 - bw / 2;
      const by = minY - 16 - bh - 2;
      const key = podKey(pod);
      editMode.badges.push({ x: bx, y: by, w: bw, h: bh, key });
      c.save();
      c.fillStyle = relay ? '#8B5CF6' : '#14B8A6';
      roundRect(px(bx), px(by), px(bw), px(bh), SCALE * 1.5); c.fill();
      c.fillStyle = '#FFFFFF';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label, px(bx + bw / 2), px(by + bh / 2) + 1);
      c.restore();
    });
    // Subtle hint banner.
    c.save();
    c.fillStyle = rgba('#1C1917', 0.62);
    c.font = `${10}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillText(LZ({
      zh: '编辑模式：拖角色=单独移动（拖开=脱离群组）、拖 平行/接力 标签=整组移动、点标签=切换模式、拖到休息区=停用',
      en: 'Edit mode: drag a person = move alone (drag out = leave group); drag the Parallel/Relay badge = move whole group; click badge = toggle mode; drag to rest area = disable',
    }), px(LOGICAL_W / 2), px(WALL * TILE + 2));
    c.restore();
  }

  // ─── Token meter ────────────────────────────────────────────────────────────
  // A small readout + bar in the office's top-right corner. Shows the live
  // estimate ("预估 ~28k") while tuning, and the actual accumulated total
  // ("实际 31k") during/after a run. The bar length is relative to a soft cap.
  const METER_CAP = 45000;   // ~深度精读 upper bound; bar saturates here
  const SHOW_TOKEN_METER = false;    // hidden from users for now — flip to re-enable
  const SHOW_AUDIENCE_TAG = false;   // matches the hidden Audience picker in index.html
  const SHOW_DEP_EDGE = false;       // 小词→小导 dependency line — hidden from users for now
  function drawTokenMeter() {
    if (!SHOW_TOKEN_METER) return;
    const est = estimateTokens();
    const isActual = meter.mode === 'actual';
    const val = isActual ? meter.actual : est;
    // 💸 escalate estimate shows the cheap floor with a "↑" — final cost depends on
    // the runtime go/stop decision, so it can only grow from here.
    const estWord = LZ({ zh:'预估', en:'Est.' });
    const estLabel = editMode.escalate ? estWord + ' ' + fmtK(val) + '↑' : estWord + ' ' + fmtK(val);
    const label = isActual ? LZ({ zh:'实际', en:'Actual' }) + ' ' + fmtKPlain(val) : estLabel;
    const w = 58, h = 20;
    const x = LOGICAL_W - w - 4, y = WALL * TILE + 3;
    c.save();
    // Panel.
    c.fillStyle = rgba('#FFFFFF', 0.9);
    c.strokeStyle = rgba('#1C1917', 0.18); c.lineWidth = SCALE * 0.6;
    roundRect(px(x), px(y), px(w), px(h), SCALE * 1.6); c.fill(); c.stroke();
    // Label.
    c.fillStyle = isActual ? ACCENT : '#57534E';
    c.font = `${11}px system-ui, sans-serif`;
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(label, px(x + 4), px(y + 7) + 1);
    // Bar.
    const barX = x + 4, barY = y + 13, barW = w - 8, barH = 3;
    rect(barX, barY, barW, barH, rgba('#1C1917', 0.10));
    const p = Math.max(0, Math.min(1, val / METER_CAP));
    rect(barX, barY, Math.max(1, barW * p), barH, isActual ? ACCENT : '#3B82F6');
    c.restore();
  }

  // A little book flying to the bookshelf when a term is saved.
  function drawFlyingBook() {
    fly.t++;
    const p = Math.min(fly.t / 36, 1);
    const sx = 168, sy = 120, ex = T(3), ey = 8;
    const cx = sx + (ex - sx) * p, cy = sy + (ey - sy) * p - Math.sin(p * Math.PI) * 34;
    rect(cx - 1, cy - 1, 3, 3, '#E0A458'); rect(cx - 1, cy - 1, 3, 1, '#F0C078');
    if (p >= 1) fly = null;
  }

  // Highlight the teammate whose panel is currently open (results view).
  function drawSelectionMarker(e) {
    const cx = e.x, feetY = e.y + 6, top = feetY - 15;
    const bob = (Math.floor(tick / 15) % 2) ? -1 : 0;
    const ay = top - 12 + bob;
    c.fillStyle = e.role.shirt;
    c.beginPath();
    c.moveTo(px(cx - 3), px(ay)); c.lineTo(px(cx + 3), px(ay)); c.lineTo(px(cx), px(ay + 3));
    c.closePath(); c.fill();
    c.strokeStyle = rgba(e.role.shirt, 0.85); c.lineWidth = SCALE;
    c.beginPath(); c.ellipse(px(cx), px(feetY + 1), px(6), px(2.5), 0, 0, Math.PI * 2); c.stroke();
  }

  function loop() { tick++; update(); render(); if (!reducedMotion) animId = requestAnimationFrame(loop); }

  // ─── Canvas setup ───────────────────────────────────────────────────────────
  function createCanvas(containerId) {
    const container = document.getElementById(containerId);
    if (!container) throw new Error(`pixelAgents: #${containerId} not found`);
    canvas = document.createElement('canvas'); canvas.className='pixel-canvas';
    canvas.width = px(LOGICAL_W); canvas.height = px(LOGICAL_H);
    container.appendChild(canvas); c = canvas.getContext('2d'); c.imageSmoothingEnabled = false;
    canvas.addEventListener('click', ev => { if (editMode.on) return; const id = locate(ev); if (id && clickHandler) clickHandler(id); });
    canvas.addEventListener('mousemove', ev => {
      if (editMode.on) {
        editPointerMove(ev);
        const overEditable = !!editMode.dragId || DRAGGABLE.includes(locate(ev));
        canvas.style.cursor = editMode.dragId ? 'grabbing' : (overEditable ? 'grab' : 'default');
        return;
      }
      const id = locate(ev);
      canvas.style.cursor = id ? 'pointer' : 'default';
      if (hoverHandler) hoverHandler(id, id ? pointerInfo(ev) : null);
    });
    canvas.addEventListener('mouseleave', () => { canvas.style.cursor = 'default'; if (hoverHandler) hoverHandler(null, null); });
    // Drag interactions for edit mode (mouse + touch).
    canvas.addEventListener('mousedown', editPointerDown);
    window.addEventListener('mouseup', editPointerUp);
    canvas.addEventListener('touchstart', editPointerDown, { passive: false });
    canvas.addEventListener('touchmove', editPointerMove, { passive: false });
    canvas.addEventListener('touchend', editPointerUp);
  }
  // Map a pointer event to the character under it (front-most wins).
  function locate(ev) {
    const r = canvas.getBoundingClientRect();
    const lx = (ev.clientX - r.left) / r.width * LOGICAL_W;
    const ly = (ev.clientY - r.top) / r.height * LOGICAL_H;
    let hit = null, hitY = -1;
    for (const id in chars) { const e = chars[id];
      if (lx >= e.x-7 && lx <= e.x+7 && ly >= e.y-12 && ly <= e.y+8 && e.y > hitY) { hit = id; hitY = e.y; }
    }
    return hit;
  }
  function pointerInfo(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, width: r.width, height: r.height };
  }
  // Same rect→logical normalization used by locate(), as a {x,y} pair.
  function locateLogical(ev) {
    const r = canvas.getBoundingClientRect();
    const src = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
    return {
      x: (src.clientX - r.left) / r.width * LOGICAL_W,
      y: (src.clientY - r.top) / r.height * LOGICAL_H,
    };
  }

  // ─── Edit mode: pods, graphConfig, persistence ──────────────────────────────
  function podKey(ids) { return ids.slice().sort().join(','); }

  // Cluster the enabled stage-1 workers by proximity (transitive, ≤ POD_DIST).
  // Returns an array of id-arrays (each a pod). Singletons are length-1 pods.
  function computePods() {
    const live = STAGE1.filter(id => !editMode.bench[id]);
    const pods = [];
    const seen = new Set();
    for (const id of live) {
      if (seen.has(id)) continue;
      const pod = [id]; seen.add(id);
      for (let i = 0; i < pod.length; i++) {
        const a = posOf(pod[i]);
        for (const other of live) {
          if (seen.has(other)) continue;
          const b = posOf(other);
          if (Math.hypot(a.x - b.x, a.y - b.y) <= POD_DIST) { pod.push(other); seen.add(other); }
        }
      }
      pods.push(pod);
    }
    return pods;
  }
  function normalizePodMembers(members) {
    const seen = new Set();
    return (Array.isArray(members) ? members : [])
      .filter(id => STAGE1.includes(id) && !editMode.bench[id] && !seen.has(id) && seen.add(id));
  }
  function capturePods() {
    editMode.groups = computePods()
      .map(pod => normalizePodMembers(pod))
      .filter(pod => pod.length >= 2)
      .map(pod => ({ members: podOrder(pod), mode: podModeOf(pod) }));
  }
  function workflowPods() {
    if (editMode.on || !editMode.groups.length) return computePods();
    const claimed = new Set();
    const pods = [];
    editMode.groups.forEach(group => {
      const members = normalizePodMembers(group.members);
      if (members.length < 2 || members.some(id => claimed.has(id))) return;
      members.forEach(id => claimed.add(id));
      pods.push(members);
    });
    STAGE1.forEach(id => {
      if (!editMode.bench[id] && !claimed.has(id)) pods.push([id]);
    });
    return pods;
  }
  function podModeOf(ids) { return editMode.podModes[podKey(ids)] === 'relay' ? 'relay' : 'parallel'; }
  // Relay runs in listed order — order members left-to-right (then top-to-bottom).
  function podOrder(ids) {
    return ids.slice().sort((a, b) => (posOf(a).x - posOf(b).x) || (posOf(a).y - posOf(b).y));
  }

  // Build the graphConfig (v2: nodes with enabled+effort). Returns null when the
  // spec equals the 标准 default — all enabled, all effort "med", the three
  // stage-1 workers in a single parallel group — so default runs send no &graph
  // and behave byte-for-byte as today.
  function getGraphConfig() {
    if (!hasCustomLayout()) return null;   // untouched office → no graph param
    let anyDisabled = false;
    for (const id of EDITABLE) if (editMode.bench[id]) anyDisabled = true;
    const synthEnabled = !editMode.bench.synth;   // FE never benches synth, kept for shape
    if (!synthEnabled) anyDisabled = true;

    // v2 nodes: enabled (default true) + effort (default "med", only where it
    // applies) + replicas (vote ×N; default 1, only emitted when >1).
    const nodes = {};
    for (const id of EFFORT_NODES) {
      nodes[id] = { enabled: !editMode.bench[id], effort: effortOf(id) };
      const rep = replicasOf(id);
      if (rep > 1) nodes[id].replicas = rep;
    }
    nodes.ctx = { enabled: !editMode.bench.ctx };
    nodes.synth = { enabled: synthEnabled };

    // Pods (legacy groups) — kept working; only emitted when pods exist.
    const pods = workflowPods();
    const groups = [];
    for (const pod of pods) {
      const mode = podModeOf(pod);
      const members = mode === 'relay' ? podOrder(pod) : pod.slice();
      groups.push({ members, mode });
    }
    // A single parallel group over all three stage-1 workers is the default shape.
    const defaultGroup = groups.length === 1
      && groups[0].mode === 'parallel'
      && groups[0].members.length === STAGE1.length;
    const nonDefaultEffort = EFFORT_NODES.some(id => effortOf(id) !== 'med');
    const nonDefaultReplicas = REPLICA_NODES.some(id => replicasOf(id) > 1);

    // Full default spec → null (no &graph, unchanged behaviour). Escalate/debate/
    // audience are never "default" even when nodes/effort are all-med, so they emit.
    if (!editMode.escalate && !editMode.debate && !editMode.audience && !anyDisabled && defaultGroup && !nonDefaultEffort && !nonDefaultReplicas) return null;

    const cfg = { v: 2, nodes };
    // 💸 thrifty: run sum+ctx first, then EITHER run jargon+comments (worth it) or
    // skip them. jargon+comments are runtime "candidates"; the backend decides.
    if (editMode.escalate) cfg.escalate = true;
    // 🥊 辩论裁定: 小导 argues 正方/反方 then adjudicates into one balanced verdict.
    if (editMode.debate) cfg.debate = true;
    // 受众语气: reader level shifts tone/depth (orthogonal to depth presets).
    if (editMode.audience === 'beginner' || editMode.audience === 'expert') cfg.audience = editMode.audience;
    // Attach groups only when a non-default pod arrangement exists (a real
    // multi-member pod that isn't just the default single-parallel group).
    const realPods = groups.filter(g => g.members.length >= 2);
    if (realPods.length && !defaultGroup) cfg.groups = groups;
    return cfg;
  }

  // ─── Task presets ───────────────────────────────────────────────────────────
  // A preset is a spec of {enabled, effort} per node. Applying one sets the
  // office state (bench disabled nodes, set effort badges), clears pods + drag
  // overrides, then RE-LAYOUTS: the office auto-arranges into the preset's
  // pipeline (agents walk to their new spec-derived slots; disabled ones head to
  // the sofa to sleep). '标准' = all enabled/med (getGraphConfig() === null) and
  // renders as the clean readers‖ → ctx → synth → whiteboard pipeline.
  const PRESETS = {
    quick: {   // ⚡ 快速扫描: sum(low)+ctx; jargon+comments off; synth on
      sum: { enabled: true, effort: 'low' }, jargon: { enabled: false },
      comments: { enabled: false }, ctx: { enabled: true }, synth: { enabled: true },
    },
    standard: {  // 📄 标准: all enabled, all med (the default)
      sum: { enabled: true, effort: 'med' }, jargon: { enabled: true, effort: 'med' },
      comments: { enabled: true, effort: 'med' }, ctx: { enabled: true }, synth: { enabled: true },
    },
    jargon: {   // 🎯 术语特训: jargon(high, ×2 vote)+ctx; sum(low); comments off
      sum: { enabled: true, effort: 'low' },
      jargon: { enabled: true, effort: 'high', replicas: 2 },
      comments: { enabled: false }, ctx: { enabled: true }, synth: { enabled: true },
    },
    deep: {   // 🔬 深度精读: all enabled, all high
      sum: { enabled: true, effort: 'high' }, jargon: { enabled: true, effort: 'high' },
      comments: { enabled: true, effort: 'high' }, ctx: { enabled: true }, synth: { enabled: true },
    },
    reliable: {   // 🛡️ 可靠: all stage-1 readers at med effort, run ×2 and merge
      sum: { enabled: true, effort: 'med', replicas: 2 },
      jargon: { enabled: true, effort: 'med', replicas: 2 },
      comments: { enabled: true, effort: 'med', replicas: 2 },
      ctx: { enabled: true }, synth: { enabled: true },
    },
    thrifty: {   // 💸 省钱渐进: sum+ctx run first; jargon+comments are runtime
      // "candidates" — the backend escalates to them only if worth reading.
      escalate: true,
      sum: { enabled: true, effort: 'med' }, jargon: { enabled: true, effort: 'med' },
      comments: { enabled: true, effort: 'med' }, ctx: { enabled: true }, synth: { enabled: true },
    },
    debate: {   // 🥊 辩论裁定: full readers, but 小导 argues 正方/反方 then adjudicates.
      debate: true,
      sum: { enabled: true, effort: 'med' }, jargon: { enabled: true, effort: 'med' },
      comments: { enabled: true, effort: 'med' }, ctx: { enabled: true }, synth: { enabled: true },
    },
  };

  function applyPreset(name) {
    const spec = PRESETS[name];
    if (!spec) return;
    // Reset arrangement: clear custom positions + pods so the preset shows a
    // clean default room (workers back at their seats), then apply the spec.
    editMode.layout = Object.create(null);
    editMode.podModes = Object.create(null);
    editMode.groups = [];
    editMode.bench = Object.create(null);
    editMode.effort = Object.create(null);
    editMode.replicas = Object.create(null);
    editMode.escalate = !!spec.escalate;   // 💸 thrifty escalate mode (top-level flag)
    editMode.debate = !!spec.debate;       // 🥊 debate verdict mode (top-level flag)
    for (const id of EDITABLE.concat('synth')) {
      const node = spec[id];
      if (!node) continue;
      if (node.enabled === false) editMode.bench[id] = true;
      if (EFFORT_NODES.includes(id) && EFFORT_LEVELS.includes(node.effort) && node.effort !== 'med') {
        editMode.effort[id] = node.effort;
      }
      if (REPLICA_NODES.includes(id) && node.enabled !== false && node.replicas > 1) {
        editMode.replicas[id] = Math.min(MAX_REPLICAS, node.replicas | 0);
      }
    }
    persistGraph();
    meter.mode = 'estimate';
    // Auto-arrange: recompute the layout from this preset's spec and walk every
    // agent to its new pipeline slot (snap under reduced-motion). Drag overrides
    // were cleared above, so the arrangement is purely spec-derived.
    relayout();
    if (reducedMotion) render();
  }

  // Which built-in preset the current spec matches ('standard' when default), or
  // null for a free-tuned arrangement. Shared by the picker highlight and the
  // workflow-summary prefix so both stay in agreement.
  function matchActivePreset() {
    // 受众语气 is orthogonal to the depth preset — blank it while deciding which
    // preset the DEPTH spec matches, then restore, so e.g. 标准+新手 still reads 标准.
    const savedAud = editMode.audience;
    editMode.audience = null;
    let cfg;
    try { cfg = getGraphConfig(); } finally { editMode.audience = savedAud; }
    if (cfg === null) return 'standard';   // 标准 default
    if (cfg.groups) return null;           // custom pods → no clean preset match
    const bench = id => !!editMode.bench[id];
    const eff = id => effortOf(id);
    const matches = spec => (!!spec.escalate === !!editMode.escalate) && (!!spec.debate === !!editMode.debate) && EDITABLE.concat('synth').every(id => {
      const n = spec[id]; if (!n) return true;
      if ((n.enabled === false) !== bench(id)) return false;
      if (EFFORT_NODES.includes(id) && n.enabled !== false) {
        const want = EFFORT_LEVELS.includes(n.effort) ? n.effort : 'med';
        if (want !== eff(id)) return false;
      }
      if (REPLICA_NODES.includes(id) && n.enabled !== false) {
        const wantRep = n.replicas > 1 ? Math.min(MAX_REPLICAS, n.replicas | 0) : 1;
        if (wantRep !== replicasOf(id)) return false;
      }
      return true;
    });
    for (const name of ['quick', 'jargon', 'deep', 'reliable', 'thrifty', 'debate']) if (matches(PRESETS[name])) return name;
    return null;
  }

  // ─── Live workflow summary line ─────────────────────────────────────────────
  // Compose a single-line, human-readable picture of the CURRENT office spec —
  // the same source getGraphConfig()/specSnapshot() read — so the caption always
  // states exactly how the agents are arranged plus the cost estimate. Purely a
  // read of edit-mode state; never throws.
  const SUMMARY_NAME = { sum: ROLE.sum.name, jargon: ROLE.jargon.name, comments: ROLE.comments.name, ctx: ROLE.ctx.name, synth: ROLE.synth.name };
  const EFFORT_LABEL = { low: { zh:'低', en:'Low' }, med: { zh:'中', en:'Med' }, high: { zh:'高', en:'High' } };
  const PRESET_LABEL = {
    quick:    { zh:'⚡ 快速扫描', en:'⚡ Quick scan' },
    standard: { zh:'📄 标准',    en:'📄 Standard' },
    jargon:   { zh:'🎯 术语特训', en:'🎯 Jargon focus' },
    reliable: { zh:'🛡️ 可靠',    en:'🛡️ Reliable' },
    deep:     { zh:'🔬 深度精读', en:'🔬 Deep read' },
    thrifty:  { zh:'💸 省钱渐进', en:'💸 Thrifty ramp' },
    debate:   { zh:'🥊 辩论裁定', en:'🥊 Debate verdict' },
  };
  // "小词(高×2)" — worker name + effort (低/中/高) + optional ×N vote tag.
  function workerToken(id) {
    let s = LZ(SUMMARY_NAME[id]) || id;
    const eff = LZ(EFFORT_LABEL[effortOf(id)]);
    const rep = replicasOf(id);
    if (EFFORT_NODES.includes(id)) s += '(' + eff + (rep > 1 ? '×' + rep : '') + ')';
    else if (rep > 1) s += '×' + rep;
    return s;
  }
  function getWorkflowSummary() {
    try {
      const preset = matchActivePreset();
      const prefix = preset ? LZ(PRESET_LABEL[preset]) : LZ({ zh:'🛠️ 自订', en:'🛠️ Custom' });
      const enabledReaders = STAGE1.filter(id => !editMode.bench[id]);
      const disabled = STAGE1.filter(id => editMode.bench[id]);
      const estK = fmtK(estimateTokens());   // e.g. "~28k"
      const estWord = LZ({ zh:'预估', en:'Est.' });
      const estTag = SHOW_TOKEN_METER ? ` · ${estWord} ${estK}` : '';
      // 受众语气 tag (orthogonal to preset), appended to every caption form.
      // Audience picker is hidden from users for now, so never surface this tag.
      const audTag = !SHOW_AUDIENCE_TAG ? '' : editMode.audience === 'beginner' ? LZ({ zh:' · 受众:新手', en:' · Audience: Beginner' })
        : editMode.audience === 'expert' ? LZ({ zh:' · 受众:老手', en:' · Audience: Expert' }) : '';

      // 💸 escalate mode reads as a two-phase chain: cheap first, then +candidates.
      if (editMode.escalate) {
        const cand = editMode.escalateCandidates
          .filter(id => enabledReaders.includes(id))
          .map(id => LZ(SUMMARY_NAME[id]) || id);
        const first = enabledReaders.filter(id => !editMode.escalateCandidates.includes(id))
          .map(id => LZ(SUMMARY_NAME[id]) || id);
        const firstStr = first.length ? first.join('·') : LZ(ROLE.sum.name);
        const candStr = cand.length ? cand.join('·') : LZ({ zh:'其余读者', en:'the rest' });
        return LZ({
          zh: `${prefix} 先 ${firstStr}→${LZ(ROLE.ctx.name)}，值得才 +${candStr}${estTag}${audTag}`,
          en: `${prefix} ${firstStr} first → ${LZ(ROLE.ctx.name)}, +${candStr} only if worth it${estTag}${audTag}`,
        });
      }

      // Group the enabled readers by pod: parallel members joined by ∥, relay
      // members joined by → in run order. Ungrouped readers run in parallel (∥).
      const pods = workflowPods().filter(pod => pod.some(id => !editMode.bench[id]));
      const podStrs = [];
      const grouped = new Set();
      for (const pod of pods) {
        const members = (podModeOf(pod) === 'relay' ? podOrder(pod) : pod.slice())
          .filter(id => !editMode.bench[id]);
        if (!members.length) continue;
        members.forEach(id => grouped.add(id));
        const sep = podModeOf(pod) === 'relay' ? ' → ' : ' ∥ ';
        podStrs.push(members.map(workerToken).join(sep));
      }
      // Any enabled reader not captured by a multi-member pod (singletons) joins
      // the parallel list so nothing is dropped.
      const loose = enabledReaders.filter(id => !grouped.has(id)).map(workerToken);
      const stageParts = podStrs.concat(loose);
      let chain = stageParts.length ? stageParts.join(' ∥ ') : LZ({ zh:'（无读者）', en:'(no readers)' });

      if (!editMode.bench.ctx) chain += editMode.debate
        ? ' → ' + LZ(ROLE.ctx.name) + LZ({ zh:'⚖️(正方∥反方→合议)', en:'⚖️(pro∥con→verdict)' })
        : ' → ' + LZ(ROLE.ctx.name);
      if (!editMode.bench.synth) chain += ' → ' + LZ(ROLE.synth.name);

      let line = `${prefix} — ${chain}${estTag}${audTag}`;
      if (disabled.length) line += ' · ' + LZ({ zh:'停用', en:'Disabled' }) + ': ' + disabled.map(id => LZ(SUMMARY_NAME[id]) || id).join(LZ({ zh:'、', en:', ' }));
      return line;
    } catch (e) {
      return '';   // never break the caption
    }
  }

  // ─── Layout engine: computeLayout(spec) → positions + tables ────────────────
  // Snapshot of the current tunable spec, read straight from the office state
  // (bench = disabled, effort per node, and the stage-1 pods with their mode).
  // This is the single input to computeLayout so "office = a picture of the
  // workflow" stays true whether the spec came from a preset or free-tuning.
  function specSnapshot() {
    const nodes = {};
    for (const id of EFFORT_NODES) nodes[id] = { enabled: !editMode.bench[id], effort: effortOf(id) };
    nodes.ctx   = { enabled: !editMode.bench.ctx,   effort: 'med' };
    nodes.synth = { enabled: !editMode.bench.synth, effort: 'med' };
    // Carry each pod's collaboration mode so the layout can arrange a relay pod
    // as a left→right conveyor line (ordered, separate desks) instead of the
    // shared table a parallel pod uses.
    const pods = workflowPods();
    return { nodes, pods, podModes: pods.map(podModeOf) };
  }

  // Effort → desk richness. Kept simple + legible: low = compact 1-monitor desk,
  // med = today's desk, high = a bigger, busier 2-monitor desk with a glow.
  // Returned as a descriptor the desk sprite reads (see drawDeskSprite).
  function effortDeskSize(id) {
    const lvl = (EFFORT_NODES.includes(id)) ? effortOf(id) : 'med';
    if (lvl === 'low')  return { monitors: 1, w: TILE - 4, glow: false };
    if (lvl === 'high') return { monitors: 2, w: TILE + 3, glow: true  };
    return { monitors: 1, w: TILE - 2, glow: false };   // med (≈ today)
  }

  // Turn a spec into a target position per agent + a list of shared tables.
  // Rules (FIRST BATCH):
  //  • disabled agent  → a rest-area slot (sofa) and sleeps.
  //  • enabled readers → if 2+ are grouped in one pod, seat them around ONE
  //    shared big table (a table piece is emitted); else separate side-by-side
  //    desks across the readers band (reads as parallel).
  //  • ctx / synth     → their zone desk when enabled.
  //  • orch            → the overseer spot (still walks to the board to present).
  // Returns { pos: {id:{x,y}}, tables: [{cx,cy,members}], readerDesks: {id:true} }.
  function computeLayout(spec) {
    spec = spec || specSnapshot();
    const pos = Object.create(null);
    const tables = [];
    const readerDesks = Object.create(null);

    // 队长 overseer spot (center-top). It walks to the board to present later.
    pos.orch = centreOf(ZONE.orchseat.col, ZONE.orchseat.row);

    // Disabled agents → rest slots (sofa), assigned in a stable order.
    const disabled = ALL_WORKERS.concat('synth').filter(id => !spec.nodes[id] || !spec.nodes[id].enabled);
    disabled.forEach((id, i) => {
      const slot = REST_SLOTS[i % REST_SLOTS.length];
      pos[id] = centreOf(slot[0], slot[1]);
    });

    // Enabled stage-1 readers: split into grouped (pods ≥2) vs. solo. Carry each
    // reader pod's collaboration mode so relay pods can be arranged as a conveyor
    // line rather than a shared table.
    const enabledReaders = STAGE1.filter(id => spec.nodes[id] && spec.nodes[id].enabled);
    const podModes = spec.podModes || [];
    const readerPods = (spec.pods || [])
      .map((pod, i) => ({
        members: pod.filter(id => enabledReaders.includes(id)),
        mode: podModes[i] === 'relay' ? 'relay' : 'parallel',
      }))
      .filter(p => p.members.length >= 2);
    const grouped = new Set();
    readerPods.forEach(p => p.members.forEach(id => grouped.add(id)));
    const soloReaders = enabledReaders.filter(id => !grouped.has(id));

    // Lay out the readers band left→right. A PARALLEL pod occupies a shared table
    // cluster (2 cols); a RELAY pod stretches into a left→right line of separate
    // desks (one col per member) so it reads as a conveyor; solo readers each get
    // their own desk. We walk a cursor across the band.
    const [c0, c1] = ZONE.readers.cols;
    const row = ZONE.readers.row;
    let cursor = c0;
    const span = c1 - c0;                      // available columns
    // Count the "units" (columns) needed so the cursor spreads them evenly-ish:
    // solo = 1, parallel pod = 2 (its table), relay pod = 2 (a compact line).
    const units = soloReaders.length + readerPods.reduce((n, p) => n + 2, 0);
    const gap = units > 1 ? Math.max(1, Math.floor(span / (units - 1))) : 1;

    soloReaders.forEach(id => {
      pos[id] = centreOf(clampCol(cursor), row);
      readerDesks[id] = true;
      cursor += gap;
    });
    readerPods.forEach(p => {
      if (p.mode === 'relay') {
        // Conveyor line: members in run order (podOrder), each on its OWN desk,
        // arranged in a TIGHT left→right row centred on the cursor. Spacing is
        // kept under POD_DIST so proximity clustering (computePods) still sees them
        // as one pod, while the row reads as a line the doc travels down.
        const order = p.members.slice().sort((a, b) => (posOf(a).x - posOf(b).x) || (posOf(a).y - posOf(b).y));
        const STEP = 18;                              // px between members (< POD_DIST≈19)
        const ccx = clampCol(cursor + 0.5) * TILE + 8;
        const cy0 = row * TILE + 8;
        const x0 = ccx - (order.length - 1) * STEP / 2;
        order.forEach((id, i) => {
          pos[id] = { x: x0 + i * STEP, y: cy0 };
          readerDesks[id] = true;
        });
        cursor += 2 * gap;
      } else {
        // Parallel pod → ONE shared big table (members ringed around it). Members
        // are spread WIDE around the slab with real separation so their sprites +
        // nameplates don't overlap or stack, and are seated at/below the table's
        // midline so they y-sort ON TOP of the slab (drawn after it) — never hidden
        // behind it. Offsets scale to member count: 2 sit left/right, 3 add a
        // centred front seat, 4 ring the corners.
        const tcx = clampCol(cursor + 0.5);
        const tcy = row;
        tables.push({ cx: tcx, cy: tcy, members: p.members.slice() });
        const n = p.members.length;
        // Wide horizontal spread (±SPREAD px); Y offsets keep everyone on/below
        // the table centre (>= 0) so the table (baseY ≈ centre) sorts underneath.
        const SPREAD = 11;
        const rings = {
          2: [ [-SPREAD, 4], [SPREAD, 4] ],
          3: [ [-SPREAD, 2], [SPREAD, 2], [0, 9] ],
          4: [ [-SPREAD, 1], [SPREAD, 1], [-SPREAD, 9], [SPREAD, 9] ],
        };
        const ring = rings[n] || rings[4];
        const cx0 = tcx * TILE + 8, cy0 = tcy * TILE + 8;
        p.members.forEach((id, i) => {
          const o = ring[i % ring.length];
          pos[id] = { x: clampX(cx0 + o[0]), y: clampY(cy0 + o[1]) };
        });
        cursor += 2 * gap;
      }
    });

    // ctx / synth desks when enabled (disabled ones already sent to rest).
    if (spec.nodes.ctx && spec.nodes.ctx.enabled)   pos.ctx   = centreOf(ZONE.ctx.col, ZONE.ctx.row);
    if (spec.nodes.synth && spec.nodes.synth.enabled) pos.synth = centreOf(ZONE.synth.col, ZONE.synth.row);

    return { pos, tables, readerDesks };
  }
  function clampCol(col) { return Math.max(1, Math.min(COLS - 3, col)); }

  // The live computed layout (spec-derived). Manual drag (editMode.layout) sits
  // ON TOP of this as a per-agent override until a preset/spec change clears it.
  let computed = { pos: Object.create(null), tables: [], readerDesks: Object.create(null) };
  // Final target for an agent: a user drag override wins, else the computed slot,
  // else its legacy fixed seat (so anything unplaced still has a home).
  function targetPos(id) {
    if (editMode.layout[id]) return editMode.layout[id];
    if (computed.pos[id]) return computed.pos[id];
    const s = chars[id].station;
    return { x: s.seat[0] * TILE + 8, y: s.seat[1] * TILE + 8 };
  }

  // Recompute the layout from the current spec and move every agent to its new
  // target. Under reduced-motion we snap; otherwise agents WALK (a simple lerp
  // toward the target that stepEntity-independent code advances each frame), so
  // the office visibly "reshuffles into the new workflow". Benched agents head to
  // the sofa and sleep.
  let relayoutActive = false;
  function relayout(opts) {
    opts = opts || {};
    computed = computeLayout(specSnapshot());
    if (reducedMotion || opts.snap) {
      // Snap: place each agent exactly on its target.
      Object.keys(chars).forEach(id => {
        const t = targetPos(id);
        const e = chars[id];
        e.x = t.x; e.y = t.y; e.tile = [Math.round((e.x - 8) / TILE), Math.round((e.y - 8) / TILE)];
        e.walkTarget = null;
        e.asleep = !!editMode.bench[id] && id !== 'orch';
        if (e.asleep) { e.bubble = ''; e.state = 'idle'; }
      });
      if (reducedMotion) render();
      return;
    }
    // Animate: set a walkTarget the layout loop lerps toward. Benched → sleep on
    // arrival. We don't use A* here (positions are free-floating, not tile-locked).
    relayoutActive = true;
    Object.keys(chars).forEach(id => {
      const e = chars[id];
      const t = targetPos(id);
      e.path = null; e.onArrive = null;   // cancel any sim walk; the layout owns motion
      e.walkTarget = { x: t.x, y: t.y, benched: !!editMode.bench[id] && id !== 'orch' };
      if (e.walkTarget.benched) e.bubble = ''; else e.asleep = false;
      e.state = e.walkTarget.benched ? 'idle' : 'idle';
    });
  }

  // Advance layout walks (called each frame from update()). Lerp toward each
  // agent's walkTarget; on arrival, benched agents fall asleep. Returns when all
  // targets are reached (relayoutActive flips false).
  const LAYOUT_SPEED = 1.6;   // logical px/frame for the reshuffle walk (~+14% over original 1.4)
  function stepLayout() {
    if (!relayoutActive) return;
    let anyMoving = false;
    Object.keys(chars).forEach(id => {
      const e = chars[id];
      const t = e.walkTarget;
      if (!t) return;
      const dx = t.x - e.x, dy = t.y - e.y, d = Math.hypot(dx, dy);
      if (d <= LAYOUT_SPEED) {
        e.x = t.x; e.y = t.y; e.tile = [Math.round((e.x - 8) / TILE), Math.round((e.y - 8) / TILE)];
        e.walkTarget = null;
        if (t.benched) { e.asleep = true; e.facing = 'down'; }
      } else {
        e.x += dx / d * LAYOUT_SPEED; e.y += dy / d * LAYOUT_SPEED;
        e.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        anyMoving = true;
      }
    });
    if (!anyMoving) relayoutActive = false;
  }

  function persistGraph() {
    try {
      // Persist every DRAGGABLE agent's manual position — including infra
      // (orch/synth) — so the office remembers exactly where you put everyone.
      const layout = {};
      for (const id of DRAGGABLE) if (editMode.layout[id]) layout[id] = editMode.layout[id];
      const effort = {};
      for (const id of EFFORT_NODES) if (effortOf(id) !== 'med') effort[id] = effortOf(id);
      const replicas = {};
      for (const id of REPLICA_NODES) if (replicasOf(id) > 1) replicas[id] = replicasOf(id);
      const groups = (editMode.groups || []).map(g => ({
        members: normalizePodMembers(g.members),
        mode: g.mode === 'relay' ? 'relay' : 'parallel',
      })).filter(g => g.members.length >= 2);
      const data = { v: 2, layout, bench: Object.keys(editMode.bench), podModes: editMode.podModes, groups, effort, replicas };
      // 受众语气 is a stable preference (unlike session-only escalate/debate), so
      // persist it — the office reopens with the reader level you last chose.
      if (editMode.audience === 'beginner' || editMode.audience === 'expert') data.audience = editMode.audience;
      localStorage.setItem(GRAPH_LS_KEY, JSON.stringify(data));
    } catch (_) { /* storage may be unavailable */ }
  }
  function restoreGraph() {
    let data;
    try { data = JSON.parse(localStorage.getItem(GRAPH_LS_KEY) || 'null'); } catch (_) { return; }
    if (!data || (data.v !== 1 && data.v !== 2)) return;
    editMode.audience = (data.audience === 'beginner' || data.audience === 'expert') ? data.audience : null;
    editMode.bench = Object.create(null);
    (data.bench || []).forEach(id => { if (EDITABLE.includes(id)) editMode.bench[id] = true; });
    editMode.podModes = Object.create(null);
    if (data.podModes && typeof data.podModes === 'object') {
      for (const k in data.podModes) if (data.podModes[k] === 'relay') editMode.podModes[k] = 'relay';
    }
    editMode.groups = [];
    if (Array.isArray(data.groups)) {
      editMode.groups = data.groups.map(g => ({
        members: normalizePodMembers(g.members),
        mode: g?.mode === 'relay' ? 'relay' : 'parallel',
      })).filter(g => g.members.length >= 2);
      editMode.groups.forEach(g => {
        if (g.mode === 'relay') editMode.podModes[podKey(g.members)] = 'relay';
      });
    }
    editMode.effort = Object.create(null);
    if (data.effort && typeof data.effort === 'object') {
      for (const id of EFFORT_NODES) {
        if (EFFORT_LEVELS.includes(data.effort[id])) editMode.effort[id] = data.effort[id];
      }
    }
    editMode.replicas = Object.create(null);
    if (data.replicas && typeof data.replicas === 'object') {
      for (const id of REPLICA_NODES) {
        const n = data.replicas[id] | 0;
        if (n >= 2) editMode.replicas[id] = Math.min(MAX_REPLICAS, n);
      }
    }
    editMode.layout = Object.create(null);
    if (data.layout) {
      for (const id of DRAGGABLE) {
        const p = data.layout[id];
        if (p && typeof p.x === 'number' && typeof p.y === 'number' && chars[id]) {
          const x = clampX(p.x), y = clampY(p.y);
          editMode.layout[id] = { x, y };
        }
      }
    }
  }
  function clampX(x) { return Math.max(6, Math.min(LOGICAL_W - 6, x)); }
  function clampY(y) { return Math.max(WALL * TILE + 6, Math.min(LOGICAL_H - 4, y)); }

  function enterEditMode() {
    if (editMode.on) return;
    // Edit mode is mutually exclusive with a run.
    sim.active = false; sim.recalling = false; sim.pendingStart = false;
    sim.customView = false; runDocs.length = 0;
    sim.handoff = false; sim.handoffStart = 0; sim.collecting = false;
    sim.delivering = false; sim.delivered = false; sim.deliverTarget = null;
    sim.synthBusy = false; sim.synthQueue = []; sim.handed = 0;
    editMode.on = true; editMode.dragId = null;
    editMode.dragGroup = []; editMode.dragLast = null;
    editMode.badgeDrag = null; editMode.badgeDragStart = null; editMode._badgeLast = null;
    selected = null;
    // Freeze everyone: clear paths/timers so the sim never fights the drag.
    Object.values(chars).forEach(e => {
      e.path = null; e.onArrive = null; e.timer = 0; e.onTimer = null; e.walkXY = null;
      e._queuedDeliver = false;
      e.bubble = ''; e.ambKind = null;
      if (e.state !== 'idle') e.state = 'idle';
    });
    // Snap everyone to their current layout target so the user edits FROM the
    // spec-derived pipeline arrangement (drag overrides win; else computed slot).
    relayoutActive = false;
    computed = computeLayout(specSnapshot());
    Object.keys(chars).forEach(id => {
      const e = chars[id]; const t = targetPos(id);
      e.x = t.x; e.y = t.y; e.tile = [Math.round((e.x - 8) / TILE), Math.round((e.y - 8) / TILE)];
      e.walkTarget = null; e.asleep = false;
    });
    Object.values(pets).forEach(p => { p.path = null; p.onArrive = null; p.onTimer = null; p.bubble = ''; p.card = ''; p.state = 'idle'; });
    if (reducedMotion) render();
  }
  function exitEditMode() {
    if (!editMode.on) return;
    editMode.on = false; editMode.dragId = null;
    editMode.badgeDrag = null; editMode.badgeDragStart = null; editMode._badgeLast = null;
    capturePods();
    persistGraph();
    Object.values(chars).forEach(e => { e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND); });
    // Re-layout on exit: bench/effort changes reflow undragged agents into the
    // pipeline (drag overrides are kept). Snap here — the edit already showed
    // the arrangement, so no walk is needed.
    relayout({ snap: true });
    if (reducedMotion) render();
  }

  // Pointer handlers (mouse + touch) — only active in edit mode.
  function editPointerDown(ev) {
    if (!editMode.on) return;
    const p = locateLogical(ev);
    // Effort badge click takes priority (cycles low→med→high).
    for (const b of editMode.effortBadges) {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        const cur = effortOf(b.id);
        const next = EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(cur) + 1) % EFFORT_LEVELS.length];
        if (next === 'med') delete editMode.effort[b.id]; else editMode.effort[b.id] = next;
        persistGraph(); if (reducedMotion) render();
        if (onSpecChange) onSpecChange();
        ev.preventDefault();
        return;
      }
    }
    // Replicas badge click (vote ×N; cycles 1→2→3→1).
    for (const b of editMode.replicaBadges) {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        const cur = replicasOf(b.id);
        const next = cur >= MAX_REPLICAS ? 1 : cur + 1;
        if (next <= 1) delete editMode.replicas[b.id]; else editMode.replicas[b.id] = next;
        persistGraph(); if (reducedMotion) render();
        if (onSpecChange) onSpecChange();
        ev.preventDefault();
        return;
      }
    }
    // Mode badge = the pod's GROUP move-handle. Grabbing it starts a group-drag of
    // that pod's members (frozen at grab time so mid-move proximity shifts can't
    // add/drop members). Whether this ends up a click (toggle mode) or a drag
    // (relocate the group) is decided in editPointerUp by BADGE_DRAG_THRESH.
    for (const b of editMode.badges) {
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        const pod = computePods().find(pd => pd.length >= 2 && podKey(pd) === b.key);
        const members = pod ? pod.slice() : [];
        editMode.badgeDrag = { key: b.key, members, moved: false };
        editMode.badgeDragStart = { x: p.x, y: p.y };
        members.forEach(mid => { const m = chars[mid]; if (m) { m.path = null; m.onArrive = null; } });
        ev.preventDefault();
        return;
      }
    }
    const id = locate(ev);
    if (id && DRAGGABLE.includes(id)) {
      // Individual-agent drag moves ONLY that agent. Pulling it beyond POD_DIST of
      // the others naturally separates/ungroups it (pods are proximity-based via
      // computePods/posOf); dragging it near another groups them. The whole group
      // now moves only via its badge handle (see the badge branch above).
      editMode.dragId = id;
      chars[id].path = null; chars[id].onArrive = null;
      editMode.dragGroup = [];
      editMode.dragLast = { x: chars[id].x, y: chars[id].y };
      ev.preventDefault();
    }
  }
  function editPointerMove(ev) {
    if (!editMode.on) return;
    // Pod-badge group drag: translate every pod member by the pointer delta,
    // preserving relative offsets (and the shared table, which reads member
    // positions). Once the pointer travels past the threshold it's committed to a
    // drag (moved=true) so the up-handler won't misfire the mode toggle.
    if (editMode.badgeDrag) {
      const p = locateLogical(ev);
      const start = editMode.badgeDragStart || p;
      if (!editMode.badgeDrag.moved
          && Math.hypot(p.x - start.x, p.y - start.y) >= BADGE_DRAG_THRESH) {
        editMode.badgeDrag.moved = true;
        editMode._badgeLast = { x: start.x, y: start.y };
      }
      if (editMode.badgeDrag.moved) {
        const last = editMode._badgeLast || start;
        const dx = p.x - last.x, dy = p.y - last.y;
        for (const mid of editMode.badgeDrag.members) {
          const m = chars[mid];
          if (!m) continue;
          m.x = clampX(m.x + dx); m.y = clampY(m.y + dy);
          m.path = null; m.onArrive = null;
          m.tile = [Math.round((m.x - 8) / TILE), Math.round((m.y - 8) / TILE)];
          editMode.layout[mid] = { x: m.x, y: m.y };
        }
        editMode._badgeLast = { x: p.x, y: p.y };
      }
      ev.preventDefault();
      if (reducedMotion) render();
      return;
    }
    if (!editMode.dragId) return;
    const p = locateLogical(ev);
    const id = editMode.dragId, e = chars[id];
    const nx = clampX(p.x), ny = clampY(p.y);
    // Actual delta applied to the dragged agent AFTER clamping, so pod members
    // translate by exactly the same amount and keep their relative offsets.
    const last = editMode.dragLast || { x: e.x, y: e.y };
    const dx = nx - last.x, dy = ny - last.y;
    e.x = nx; e.y = ny;
    e.path = null;
    e.tile = [Math.round((e.x - 8) / TILE), Math.round((e.y - 8) / TILE)];
    editMode.layout[id] = { x: e.x, y: e.y };   // config source of truth
    // Translate the frozen pod group by the same (clamped) delta. Each member's
    // move is itself clamped to the room; the delta is measured from the dragged
    // agent's pre-clamp target so members drift with it without accumulating.
    const group = editMode.dragGroup || [];
    for (const mid of group) {
      const m = chars[mid];
      if (!m) continue;
      m.x = clampX(m.x + dx); m.y = clampY(m.y + dy);
      m.path = null; m.onArrive = null;
      m.tile = [Math.round((m.x - 8) / TILE), Math.round((m.y - 8) / TILE)];
      editMode.layout[mid] = { x: m.x, y: m.y };
    }
    editMode.dragLast = { x: e.x, y: e.y };
    ev.preventDefault();
    if (reducedMotion) render();
  }
  function editPointerUp(ev) {
    if (!editMode.on) return;
    // Resolve a pod-badge grab: moved past the threshold → it was a group drag
    // (positions already committed in move), just clear state. Barely moved →
    // treat as a click and toggle the pod's mode (平行↔接力).
    if (editMode.badgeDrag) {
      const bd = editMode.badgeDrag;
      editMode.badgeDrag = null;
      editMode.badgeDragStart = null;
      editMode._badgeLast = null;
      if (!bd.moved) {
        editMode.podModes[bd.key] = editMode.podModes[bd.key] === 'relay' ? 'parallel' : 'relay';
      }
      persistGraph(); if (reducedMotion) render();
      if (onSpecChange) onSpecChange();
      if (ev && ev.preventDefault) ev.preventDefault();
      return;
    }
    if (!editMode.dragId) return;
    const id = editMode.dragId;
    const e = chars[id];
    // Only the 4 spec-node workers get disabled. Dropping one on/near the
    // massage-chair rest corner disables it (naps there); dropping it anywhere
    // else places it (enabled). Infra agents (orch/synth) can be dropped anywhere
    // — including over the rest corner — without being disabled; they have no
    // enable/disable.
    if (!INFRA.includes(id)) {
      if (inRestZone(e.x, e.y)) editMode.bench[id] = true;
      else delete editMode.bench[id];
    }
    editMode.dragId = null;
    editMode.dragGroup = [];
    editMode.dragLast = null;
    persistGraph();
    if (onSpecChange) onSpecChange();
    if (reducedMotion) render();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  const VALID = ['idle','reading','typing','done'];
  window.pixelAgents = {
    init(containerId) {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      createCanvas(containerId);
      restoreGraph();   // bring back any saved custom layout (positions/bench/modes)
      // Open the office already arranged into the current spec's pipeline (snap
      // on load; later spec changes animate the reshuffle).
      relayout({ snap: true });
      if (reducedMotion) render(); else animId = requestAnimationFrame(loop);
    },
    // ─── Edit-office mode ─────────────────────────────────────────────────────
    setEditMode(on) { if (on) enterEditMode(); else exitEditMode(); },
    isEditMode() { return editMode.on; },
    getGraphConfig() { return getGraphConfig(); },
    // ─── Presets + effort + token meter ───────────────────────────────────────
    applyPreset(name) { applyPreset(name); },
    // ─── 受众语气 (reader level) ────────────────────────────────────────────────
    // Orthogonal to presets: 'beginner' | 'expert' | null(=默认). Persisted.
    getAudience() { return editMode.audience || null; },
    setAudience(level) {
      editMode.audience = (level === 'beginner' || level === 'expert') ? level : null;
      persistGraph();
      if (onSpecChange) onSpecChange();
    },
    // ─── Layout engine ────────────────────────────────────────────────────────
    // Compute the spec-derived target positions + shared tables (pure; for tests
    // / debugging / callers that want to read the arrangement).
    computeLayout(spec) { return computeLayout(spec); },
    // Recompute from the current spec and reshuffle the office (agents walk to
    // their new slots; pass {snap:true} to place instantly). Respects reduced-motion.
    relayout(opts) { relayout(opts); },
    // Which built-in preset the current spec matches ('standard' when default),
    // or null when it's a free-tuned arrangement. Lets the picker highlight one.
    getActivePreset() { return matchActivePreset(); },
    // Live, human-readable one-line summary composed from the current spec
    // (readers ∥ / relay → grouping, effort, vote ×N, ctx/synth, escalate, cost).
    // app.js renders this into #preset-caption everywhere the caption updates.
    getWorkflowSummary() { return getWorkflowSummary(); },
    // Live estimate in tokens (for the picker labels, etc.).
    getEstimate() { return estimateTokens(); },
    getEffort(id) { return effortOf(id); },
    // Register a callback fired whenever the spec changes via in-office edits
    // (effort/mode badge clicks, benching). Lets app.js refresh its picker/meter.
    setSpecChangeHandler(fn) { onSpecChange = typeof fn === 'function' ? fn : null; },
    // Token meter (actual). addUsage accumulates per-agent usage SSE; setUsageTotal
    // finalizes from result.usage.total. Both switch the meter into 'actual' mode.
    addUsage(agent, tokens) {
      const t = Number(tokens) || 0;
      meter.mode = 'actual';
      if (agent) meter.byAgent[agent] = (meter.byAgent[agent] || 0) + t;
      meter.actual += t;
      if (reducedMotion) render();
    },
    setUsageTotal(total) {
      const t = Number(total);
      if (Number.isFinite(t) && t >= 0) { meter.mode = 'actual'; meter.actual = t; }
      if (reducedMotion) render();
    },
    setAgentState(id, state) {
      if (!chars[id] || !VALID.includes(state)) return;
      // A benched worker is disabled for this run: keep it asleep, ignore any
      // stray state so "who's disabled" stays unambiguous at a glance.
      if (customRunActive() && editMode.bench[id]) return;
      // 💸 escalate FALLBACK: if a standby candidate starts getting real activity
      // (running/typing/reading) but no escalate decision has arrived yet, treat it
      // as 'go' so it wakes and joins in — it must never stay stuck asleep mid-run.
      // Works in both animated (customRunActive) and reduced-motion runs.
      if (sim.escalate && !sim.escalateDecided && isStandby(id)
          && (state === 'typing' || state === 'reading' || state === 'done')) {
        escalateDecision('go');
      }
      taskState[id] = state;
      if (chars[id].asleep) {
        chars[id].bubble = '';
        chars[id].statusText = '';
        chars[id]._report = '';
      }
      chars[id].asleep = false;            // any real activity wakes it up
      if (reducedMotion) render();
    },
    setAsleep(id, on) { if (chars[id]) { chars[id].asleep = !!on; if (reducedMotion) render(); } },
	    setSpeechBubble(id, text) {
      // latest SSE line for this agent: shown live while working, and reused as
      // the report bubble when the worker walks over to the Leader.
      if (!chars[id] || !text) return;
      if (customRunActive() && editMode.bench[id]) return;   // benched stays quiet/asleep
      chars[id].statusText = text; chars[id]._report = text;
      if (reducedMotion) { chars[id].bubble = text; render(); }
	    },
	    celebrate(id) { if (chars[id]) { taskState[id] = 'done'; if (reducedMotion) render(); } },
	    receiveTask() { receiveTask(); },
	    startRun() { startRun(); },
	    // 💸 escalate decision from the backend SSE `escalate` event: 'go' wakes the
	    // standby candidates (jargon+comments) from the dining corner into their
	    // reader slots; 'stop' leaves them asleep. Safe to call never / twice / late.
	    escalateDecision(decision) { escalateDecision(decision); },
    setClickHandler(fn) { clickHandler = typeof fn === 'function' ? fn : null; },
    setHoverHandler(fn) { hoverHandler = typeof fn === 'function' ? fn : null; },
    setSelected(id) { selected = chars[id] ? id : null; if (reducedMotion) render(); },
    setPresentHandler(fn) { presentHandler = typeof fn === 'function' ? fn : null; },
    setKbCount(n) { kbCount = Math.max(0, n | 0); if (reducedMotion) render(); },
    setLang(mode) { langMode = mode === 'zh' ? 'zh' : 'en'; if (reducedMotion) render(); },
    flyBook() { if (!reducedMotion) fly = { t: 0 }; },
    fetchWordbook(cb) { fetchWordbook(cb); },
    getAgentInfo(id) { return chars[id] ? { id, name: LZ(chars[id].role.name), role: LZ(chars[id].role.role), color: chars[id].role.shirt } : null; },
    reset() {
      sim.active = false; selected = null; sim.presented = false; sim.boardActive = false;
      sim.customView = false; sim.customRun = false; runDocs.length = 0;
      relayoutActive = false;
      meter.mode = 'estimate';   // back to the live estimate for tuning
      sim.synthQueue = []; sim.synthBusy = false; sim.handed = 0;
      sim.leaderQueue = []; sim.leaderBusy = false;
      sim.handoff = false; sim.handoffStart = 0; sim.collecting = false;
      sim.delivering = false; sim.delivered = false;
      sim.relayChains = []; sim.relayState = Object.create(null); sim.relayMembers = new Set();
      sim.escalate = false; sim.escalateDecided = false; sim.escalateStandby = new Set();
      ambLocks.kitchen = ambLocks.snack = ambLocks.cooler = false;
	      // Clear per-agent run state, then snap everyone back to their spec-derived
	      // layout slot (computeLayout) — the office rests in its pipeline shape.
	      STATIONS.forEach(s => { const e = chars[s.id];
	        e.path = null; e.onArrive = null; e.walkTarget = null; e.walkXY = null; e.facing = 'down'; e.state = 'idle';
	        e.timer = 0; e.onTimer = null; e.bubble = ''; e._report = ''; e.statusText = ''; e.workStart = 0; e.asleep = false;
	        e._queuedDeliver = false; e._returningToDesk = false; e.ambKind = null; e.carryDoc = false;
	        e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND);
	        delete taskState[s.id];
	      });
      relayout({ snap: true });   // reposition to the computed pipeline layout
      petQueue.length = 0;
      Object.assign(pets.pika, { x:T(18)+8, y:T(10)+10, tile:[18,10], path:null, onArrive:null, facing:'left', state:'idle', timer:80, onTimer:null, bubble:'', card:'' });
      Object.assign(pets.dog,  { x:T(17)+8, y:T(10)+8,  tile:[17,10], path:null, onArrive:null, facing:'left', state:'idle', timer:120, onTimer:null, bubble:'', card:'' });
      Object.assign(pets.cat,  { x:T(14)+8, y:T(10)+8,  tile:[14,10], path:null, onArrive:null, facing:'right', state:'idle', timer:160, onTimer:null, bubble:'', card:'' });
      if (reducedMotion) render();
    },
    agents: STATIONS.map(s => s.id),
  };
})();
