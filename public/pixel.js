/**
 * pixel.js — HN Lens pixel office simulation (top-down)
 *
 * A living Metro-City-style office rendered procedurally on a Canvas (no asset
 * files). Four subsystems:
 *   1. Tilemap      — floor / walls / furniture / walkable grid.
 *   2. A* pathfind  — characters route through corridors, avoiding furniture.
 *   3. Character FSM — idle → walking → assigning → working → reporting → returning.
 *   4. Task sim      — real SSE task-state drives one closed loop:
 *        Leader walks to 小詞, assigns, returns; 小詞 works; on done walks to the
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

  // ─── Grid / layout ──────────────────────────────────────────────────────────
  const SCALE = 3;
  const TILE  = 16;
  const COLS  = 20;
  const ROWS  = 12;
  const WALL  = 2;                       // top rows = wall
  const LOGICAL_W = COLS * TILE;          // 320
  const LOGICAL_H = ROWS * TILE;          // 192

  const SPEED  = 0.9;                     // logical px / frame
  const RUSH_SPEED = 1.9;                 // new assignment: everyone hustles back
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
  const CHAIR='#5B4E40', CHAIRHI='#6E6052';
  const MON='#23201C', SKIN='#F1C9A1', SKINSH='#D8A578', DARK='#241F1B';
  const LABEL='#6B6256', ACCENT='#FF6600';
  const RUG='#6FB7AE', RUGE='#3E8C84', SOFA='#7C8AA6', SOFAHI='#9AA6BE';
  const SHADOW='rgba(0,0,0,0.13)';

  // ─── Roles + stations (seat tile; desk = seat+below; approach = beside) ──────
  const ROLE = {
    orch:     { name:'隊長', shirt:'#FF6600', hair:'#3F3F46', acc:'lead',    role:'分派任務、最後帶你看報告' },
    sum:      { name:'小摘', shirt:'#3B82F6', hair:'#5B3A29', acc:'doc',     role:'抓文章重點與 TL;DR' },
    jargon:   { name:'小詞', shirt:'#F59E0B', hair:'#6B4423', acc:'bulb',    role:'挑出術語，白話解釋', glasses:true },
    comments: { name:'小潛', shirt:'#14B8A6', hair:'#1F2937', acc:'phones',  role:'潛入留言，整理派系' },
    ctx:      { name:'小導', shirt:'#8B5CF6', hair:'#7C2D12', acc:'stamp',   role:'幫你判斷這篇該略讀、速讀還是深讀' },
    synth:    { name:'合成', shirt:'#EC4899', hair:'#4B5563', acc:'printer', role:'校稿整合，刪掉雜訊' },
  };
  const STATIONS = [
    { id:'orch',     seat:[3,3],  approach:[4,3]  },
    { id:'sum',      seat:[8,3],  approach:[9,3]  },
    { id:'jargon',   seat:[12,3], approach:[13,3] },
    { id:'comments', seat:[8,7],  approach:[9,7]  },
    { id:'ctx',      seat:[12,7], approach:[13,7] },
    { id:'synth',    seat:[3,7],  approach:[4,7]  },   // directly below 隊長
  ];
  const deskOf = s => [s.seat[0], s.seat[1] + 1];

  // Blocking floor furniture (besides seats/desks).
  const BLOCKED = [
    [15,2],[16,2],[17,2],[18,2],          // kitchen counter
    [14,9],[15,9],[16,9],                 // sofa
    [16,10],                              // coffee table
    [1,10],[6,10],[18,3],[11,10],         // plants
    [18,8],[18,9],                        // dining corner: coffee counter + water cooler
    [5,3],                                // whiteboard easel (beside 隊長)
  ];
  const WB_TILE = [5, 3];                 // whiteboard easel sits beside 隊長
  const WB_APPROACH = [4, 3];             // 隊長 stands at its own approach to present
  const SHELF_APPROACH = [2, 3];          // 隊長 stands here to look up the wordbook

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
  function moving(e) { return e.path && e.path.length > 0; }

	  function stepEntity(e) {
	    if (e.timer > 0) { e.timer--; if (e.timer === 0 && e.onTimer) { const t = e.onTimer; e.onTimer = null; t(); } }
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
    dog.state = 'carry'; dog.card = job.label; dog.bubble = '汪！';
    walkTo(dog, target.station.approach, () => {
      faceToward(dog, target.station.seat);
      dog.state = 'deliver'; dog.bubble = job.label; target.bubble = '收到';
      dog.timer = 55;
      dog.onTimer = () => {
        dog.card = ''; dog.bubble = ''; if (target.bubble === '收到') target.bubble = ''; dog.state = 'idle';
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
      if (sim.active && p.kind !== 'dog') startWorkPetVisit(p);
      else startPetAmbient(p);
    });
  }

  function startWorkPetVisit(p) {
    const active = ALL_WORKERS.filter(id => chars[id].state === 'working' || chars[id].state === 'waiting');
    if (!active.length) { startPetAmbient(p); return; }
    const target = chars[active[Math.floor(Math.random() * active.length)]];
    p.state = 'visit'; p.bubble = p.kind === 'cat' ? '喵？' : 'pika!';
    walkTo(p, target.station.approach, () => {
      faceToward(p, target.station.seat);
      if (!target.bubble) target.bubble = p.kind === 'cat' ? '等等～' : '有靈感';
      p.timer = 75;
      p.onTimer = () => {
        p.bubble = '';
        if (target.bubble === '等等～' || target.bubble === '有靈感') target.bubble = '';
        p.state = 'idle'; p.timer = 80 + Math.floor(Math.random() * 120);
      };
    });
  }

  function startPetAmbient(p) {
    const dest = PET_LOUNGE[Math.floor(Math.random() * PET_LOUNGE.length)];
    p.state = 'wander';
    if (Math.random() < 0.28) p.bubble = p.kind === 'dog' ? '汪' : p.kind === 'cat' ? '喵' : 'pika';
    walkTo(p, dest, () => {
      p.bubble = '';
      p.timer = 90 + Math.floor(Math.random() * 220);
      p.onTimer = () => { p.state = 'idle'; p.timer = 80 + Math.floor(Math.random() * 180); };
    });
  }

  // ─── The workflow, staged to mirror the real pipeline ──────────────────────
  //   小摘/小詞/小潛  ──► 合成 (collects, reviews) ──► 隊長 (final)
  //   小導           ─────────────────────────────► 隊長 (direct)
  // A single 合成 desk and a single 隊長 desk each serialize their visitors so
  // nobody piles up.  Backend runs all workers in parallel; the sim paces it.
  const ALL_WORKERS = ['sum', 'jargon', 'comments', 'ctx'];
  const TO_SYNTH = ['sum', 'jargon', 'comments'];   // these hand off to 合成
  const SYNTH_REVIEW = 130;                          // min frames 合成 spends curating
  const ASSIGNMENTS = {
    sum:      { order:'小摘抓重點', ack:'收到！', card:'摘要中' },
    jargon:   { order:'小詞找難詞', ack:'收到！', card:'找術語' },
    comments: { order:'小潛看留言', ack:'我去潛水', card:'留言中' },
    ctx:      { order:'小導判讀',   ack:'交給我', card:'判讀中' },
    synth:    { order:'合成校稿',   ack:'收到稿', card:'整合中' },
  };

	  function startRun() {
	    if (reducedMotion) return;
	    if (sim.recalling) { sim.pendingStart = true; return; }
	    if (sim.active) return;
	    cancelAmbientAndSideJobs();
	    sim.active = true; sim.presented = false; sim.boardActive = false;
	    sim.pendingStart = false;
	    sim.kbOpen = null;
	    sim.synthQueue = []; sim.synthBusy = false; sim.handed = 0;
	    sim.leaderQueue = []; sim.leaderBusy = false;
	    const L = chars.orch;
	    L.state = 'walking_to_employee'; L.bubble = '';
	    slideTo(L, L.station.approach, () => assignTour(0));
	  }

	  function receiveTask() {
	    if (reducedMotion) { reset(); return; }
	    hardStopSideJobs();
	    sim.active = false; sim.recalling = true; sim.pendingStart = false;
	    sim.presented = false; sim.boardActive = false; sim.kbOpen = null;
	    sim.synthQueue = []; sim.synthBusy = false; sim.handed = 0;
	    sim.leaderQueue = []; sim.leaderBusy = false;
	    selected = null;
	    const L = chars.orch;
	    L.bubble = '全體回座，準備開工！';
	    let remaining = STATIONS.length;
	    const done = () => {
	      remaining--;
	      if (remaining > 0) return;
	      sim.recalling = false;
	      Object.values(chars).forEach(e => {
	        e.state = 'idle'; e.bubble = ''; e.facing = 'down';
	        e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND);
	      });
	      if (sim.pendingStart) startRun();
	    };
	    STATIONS.forEach(s => recallToSeat(chars[s.id], done));
	  }

	  function recallToSeat(e, done) {
	    e.path = null; e.onArrive = null; e.timer = 0; e.onTimer = null;
	    e.asleep = false; e._queuedDeliver = false; e.ambKind = null;
	    e._returningToDesk = false;
	    e.statusText = ''; e._report = ''; e.workStart = 0;
	    delete taskState[e.id];
	    e.state = 'recall';
	    if (e.id !== 'orch') e.bubble = '收到，回座！';
	    const seat = e.station.seat;
	    const finish = () => { e.tile = seat.slice(); e.state = 'idle'; e.bubble = ''; done(); };
	    if (e.tile[0] === seat[0] && e.tile[1] === seat[1]) { finish(); return; }
	    const approach = e.station.approach;
	    const sit = () => slideTo(e, seat, finish);
	    if (e.tile[0] === approach[0] && e.tile[1] === approach[1]) { sit(); return; }
	    walkTo(e, approach, sit);
	  }
  function assignTour(i) {
    const L = chars.orch;
    if (i >= ALL_WORKERS.length) {                   // done assigning → become receiver
      L.state = 'returning';
      L.bubble = '各組開工';
      walkTo(L, L.station.approach, () => slideTo(L, L.station.seat, () => {
        L.state = 'idle'; L.facing = 'down'; L.bubble = ''; tryLeader();
      }));
      return;
    }
    const w = chars[ALL_WORKERS[i]];
    const task = ASSIGNMENTS[w.id] || { order:'交給你！', ack:'收到！', card:'處理中' };
    L.state = 'walking_to_employee';
    walkTo(L, w.station.approach, () => {
      faceToward(L, w.station.seat);
      L.state = 'assigning'; L.bubble = task.order; w.state = 'called'; w.bubble = task.ack;
      queuePetCard(w.id, task.card);
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

	  // Stage 1: 小摘/小詞/小潛 hand their drafts to 合成 (serialized at its desk).
	  function trySynth() {
	    if (sim.synthBusy || !sim.synthQueue.length) return;
	    const S = chars.synth;
	    if (!isSeated(S)) {
	      ensureAtDesk(S, () => trySynth());
	      return;
	    }
	    const w = chars[sim.synthQueue.shift()];
	    sim.synthBusy = true;
	    deliver(w, S, w._report || '交稿！', '收到', () => {
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
	    e.bubble = e.id === 'synth' ? '先回電腦前' : '';
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

  // Stage 2: 隊長 receives 小導's direct report and 合成's final draft (serialized).
  function tryLeader() {
    const L = chars.orch;
    if (sim.leaderBusy || L.state !== 'idle' || !sim.leaderQueue.length) return;
    const job = sim.leaderQueue.shift();
    sim.leaderBusy = true;
    const w = chars[job];
    const say = job === 'synth' ? '最終稿！' : (w._report || '完成！');
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

  // Everyone's done → 隊長 walks to the whiteboard to present, then the report
  // expands (the app reveals it via the present handler).
  function startPresent() {
    const L = chars.orch;
    L.state = 'walking_to_employee'; L.bubble = '';
    slideTo(L, L.station.approach, () => walkTo(L, WB_APPROACH, () => {
      faceToward(L, WB_TILE); L.state = 'presenting'; L.bubble = '📊 來看報告！';
      sim.boardActive = true;
      if (presentHandler) presentHandler();
      L.timer = 120; L.onTimer = () => settleAfterReport();
    }));
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
    slideTo(L, L.station.approach, () => walkTo(L, SHELF_APPROACH, () => {
      faceToward(L, [2, 2]);
      L.state = 'kb_search'; L.bubble = '找單詞本…'; L.timer = 85;
      L.onTimer = () => {
        L.bubble = '找到了';
        if (sim.kbOpen) sim.kbOpen();
        sim.kbOpen = null;
        L.timer = 35;
        L.onTimer = () => {
          L.bubble = '';
          walkTo(L, L.station.approach, () => slideTo(L, L.station.seat, () => finishAmbient(L)));
        };
      };
    }));
  }

  // ─── Ambient office life (game-NPC idle behaviour) ──────────────────────────
  const ambLocks = { kitchen: false, snack: false, cooler: false };
  const CHATS = ['🙂 歇會', '🥱', '💤 zzz', '🎧', '摸個魚', '🤔', '☕?'];

  function ambientTick(e) {
    if (sim.active || e.state !== 'idle' || moving(e)) return;
    if (e.idleTimer == null) e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND);
    if (--e.idleTimer > 0) return;
    startAmbient(e);
  }
  function finishAmbient(e) {
    e.state = 'idle'; e.bubble = ''; e.facing = 'down';
    e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND);
  }
  // walk out to a tile, do a thing for a beat, then walk back to the seat.
  function ambientTrip(e, tile, lock, say, release) {
    e.state = 'amb_walk'; e.ambKind = 'trip'; e.bubble = '';
    slideTo(e, e.station.approach, () => walkTo(e, tile, () => {
      e.facing = 'up'; e.state = 'amb_do'; e.bubble = say; e.timer = AMB_DO;
      e.onTimer = () => {
        e.bubble = '';
        walkTo(e, e.station.approach, () => slideTo(e, e.station.seat, () => {
          if (release) ambLocks[release] = false;
          finishAmbient(e);
        }));
      };
    }));
  }
  function startAmbient(e) {
    const roll = Math.random();
    if (roll < 0.26 && !ambLocks.kitchen) { ambLocks.kitchen = true; ambientTrip(e, KITCHEN_TILE, 'kitchen', '☕', 'kitchen'); }
    else if (roll < 0.44 && !ambLocks.snack) { ambLocks.snack = true; ambientTrip(e, SNACK_TILE, 'snack', '🍪', 'snack'); }
    else if (roll < 0.56 && !ambLocks.cooler) { ambLocks.cooler = true; ambientTrip(e, COOLER_TILE, 'cooler', '💧', 'cooler'); }
    else if (roll < 0.80) {                                  // answer email at the desk
      e.state = 'amb_do'; e.ambKind = 'email'; e.bubble = '✉️ 回信'; e.timer = AMB_DO + 60;
      e.onTimer = () => finishAmbient(e);
    } else {                                                 // a little idle chatter
      e.state = 'amb_do'; e.ambKind = 'chat'; e.bubble = CHATS[Math.floor(Math.random() * CHATS.length)];
      e.timer = 90; e.onTimer = () => finishAmbient(e);
    }
  }

  // ─── Per-frame update ───────────────────────────────────────────────────────
  function update() {
    Object.values(chars).forEach(stepEntity);
    Object.values(pets).forEach(stepEntity);
    // hybrid work gate: a worker moves on only after its real `done` AND min time.
    for (const id of ALL_WORKERS) {
      const w = chars[id];
      if (w.state === 'working' && !moving(w) && taskState[id] === 'done' && (tick - w.workStart) >= MIN_WORK) {
        w.state = 'waiting';
        if (id === 'ctx') { sim.leaderQueue.push('ctx'); tryLeader(); }   // 小導 → 隊長 direct
        else { sim.synthQueue.push(id); trySynth(); }                     // others → 合成
      }
    }
	    // 合成 finishes curating → walks the final draft to 隊長.
	    const S = chars.synth;
	    if (S.state === 'reviewing' && isSeated(S) && (tick - S.workStart) >= SYNTH_REVIEW && !S._queuedDeliver) {
	      S._queuedDeliver = true; S.state = 'waiting';
	      sim.leaderQueue.push('synth'); tryLeader();
	    }
    // ambient office life while nothing is being analysed
    Object.values(chars).forEach(ambientTick);
    petTick();
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
  let canvas, c, animId, reducedMotion = false, tick = 0, clickHandler = null, hoverHandler = null, selected = null, presentHandler = null;
  let kbCount = 0, langMode = 'bilingual', fly = null;   // shelf count, language sign, flying-book anim
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
    STATIONS.forEach(drawChair);
  }
  // Wall sign that switches the language (雙語 / 中 / EN), next to the HN LENS sign.
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
  function drawChair(s) {
    const x=T(s.seat[0]), y=T(s.seat[1]);
    rect(x+3,y+1,10,3,CHAIR); rect(x+3,y+1,10,1,CHAIRHI);   // back
    rect(x+3,y+10,10,3,CHAIR); rect(x+3,y+10,10,1,CHAIRHI); // seat hint
    rect(x+4,y+4,2,7,shade(CHAIR,0.85)); rect(x+10,y+4,2,7,shade(CHAIR,0.85));
  }

  // ─── Desk (with monitor reflecting its worker's mode) + props ───────────────
  function drawDeskSprite(s) {
    const d = deskOf(s), x = T(d[0]), y = T(d[1]);
    const mode = vmode(chars[s.id]);
    rect(x+1,y,TILE-2,TILE-1,DESK); rect(x+1,y,TILE-2,1,DESKHI); rect(x+1,y+TILE-2,TILE-2,1,DESKLO);
    rect(x+3,y+1,10,2,'#9CA3AF');                            // keyboard
    rect(x+4,y+1,1,1,'#6B7280'); rect(x+7,y+1,1,1,'#6B7280'); rect(x+10,y+1,1,1,'#6B7280');
    const mx=x+4,my=y+5;                                     // monitor
    rect(mx-1,my-1,10,8,'#34302A'); rect(mx,my,8,6,MON);
    drawScreen(mx+1,my+1,6,4,mode,chars[s.id].role.shirt);
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
    if (s.id==='synth') { const pxx=T(s.seat[0]+1),pyy=y;
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
  function drawSofa(){ const sx=T(14),sy=T(9)+1,sw=T(3);
    rect(sx,sy,sw,4,SOFA); rect(sx,sy,sw,1,SOFAHI); rect(sx,sy+4,sw,3,SOFAHI);
    rect(sx,sy+4,1,3,SOFA); rect(sx+sw-1,sy+4,1,3,SOFA); rect(sx+sw/2,sy+4,1,3,shade(SOFA,0.85)); }
  function drawTable(){ const x=T(16)+2,y=T(10); rect(x,y,TILE-2,5,WOOD); rect(x,y,TILE-2,1,WOODHI); dot(x+5,y+2,'#FFFFFF'); }
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
  // Whiteboard easel — blank until 隊長 presents, then it fills with a "report".
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

  // ─── Character sprite (4 facings + walk) ────────────────────────────────────
  function drawCharacter(e) {
    const mode = e.asleep ? 'idle' : vmode(e);              // asleep → calm, dim, no activity
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
  function drawNamePlate(s) {
    const e = chars[s.id], mode = vmode(e);
    const d = deskOf(s), cx = T(d[0])+8, ly = T(d[1]+1)-2;
    const bx = T(d[0])+1;
    if (mode==='done') { rect(bx,ly+1,4,4,'#16A34A'); dot(bx+1,ly+2,'#FFFFFF'); dot(bx+2,ly+3,'#FFFFFF'); dot(bx+3,ly+1,'#FFFFFF'); }
    else if (mode==='working') { const p=Math.floor(tick/10)%2; rect(bx,ly+1,4,4,p?e.role.shirt:rgba(e.role.shirt,0.45)); }
    else rect(bx,ly+1,4,4,'#CFC4B4');
    c.save(); c.font=`${13}px monospace`; c.textAlign='center'; c.textBaseline='middle';
    const w=c.measureText(e.role.name).width;
    c.fillStyle=rgba('#FFFFFF',0.72); c.fillRect(px(cx)-w/2-2, px(ly)-1, w+4, px(5));
    c.fillStyle=(mode==='idle')?'#9C9384':(e.id==='jargon'?e.role.shirt:LABEL);
    c.fillText(e.role.name, px(cx)+SCALE, px(ly)+px(2.5)); c.restore();
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
    // longer step text ("通讀全文 2 段…", "聚類派別分析中…") is readable.
    const lines = isLive ? wrapBubble(raw, 11, 2) : [shortLine(raw, 8)];
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
  function shortLine(s, max) { const a = [...s]; return a.length > max ? a.slice(0, max - 1).join('') + '…' : s; }
  function wrapBubble(s, perLine, maxLines) {
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

    const sprites = [];
    STATIONS.forEach(s => { const d=deskOf(s); sprites.push({ baseY:T(d[1]+1), draw:()=>drawDeskSprite(s) }); });
    sprites.push({ baseY:T(10),    draw:drawSofa });
    sprites.push({ baseY:T(11),    draw:drawTable });
    sprites.push({ baseY:T(9),     draw:drawCoffeeCounter });   // dining corner
    sprites.push({ baseY:T(10),    draw:drawCooler });
    sprites.push({ baseY:T(WB_TILE[1])+12, draw:drawWhiteboard });
    [[1,10],[6,10],[18,3],[11,10]].forEach(([col,row]) => sprites.push(plantSprite(col,row)));
    Object.values(chars).forEach(e => sprites.push({ baseY:e.y+6, draw:()=>drawCharacter(e) }));
    Object.values(pets).forEach(p => sprites.push({ baseY:p.y+5, draw:()=>drawPet(p) }));

    sprites.sort((a,b)=>a.baseY-b.baseY).forEach(sp => sp.draw());

    STATIONS.forEach(drawNamePlate);
    Object.values(chars).forEach(drawBubble);
    Object.values(pets).forEach(drawBubble);
    if (selected && chars[selected]) drawSelectionMarker(chars[selected]);
    if (fly) drawFlyingBook();
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
    canvas.addEventListener('click', ev => { const id = locate(ev); if (id && clickHandler) clickHandler(id); });
    canvas.addEventListener('mousemove', ev => {
      const id = locate(ev);
      canvas.style.cursor = id ? 'pointer' : 'default';
      if (hoverHandler) hoverHandler(id, id ? pointerInfo(ev) : null);
    });
    canvas.addEventListener('mouseleave', () => { canvas.style.cursor = 'default'; if (hoverHandler) hoverHandler(null, null); });
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

  // ─── Public API ─────────────────────────────────────────────────────────────
  const VALID = ['idle','reading','typing','done'];
  window.pixelAgents = {
    init(containerId) {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      createCanvas(containerId);
      if (reducedMotion) render(); else animId = requestAnimationFrame(loop);
    },
    setAgentState(id, state) {
      if (!chars[id] || !VALID.includes(state)) return;
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
      chars[id].statusText = text; chars[id]._report = text;
      if (reducedMotion) { chars[id].bubble = text; render(); }
	    },
	    celebrate(id) { if (chars[id]) { taskState[id] = 'done'; if (reducedMotion) render(); } },
	    receiveTask() { receiveTask(); },
	    startRun() { startRun(); },
    setClickHandler(fn) { clickHandler = typeof fn === 'function' ? fn : null; },
    setHoverHandler(fn) { hoverHandler = typeof fn === 'function' ? fn : null; },
    setSelected(id) { selected = chars[id] ? id : null; if (reducedMotion) render(); },
    setPresentHandler(fn) { presentHandler = typeof fn === 'function' ? fn : null; },
    setKbCount(n) { kbCount = Math.max(0, n | 0); if (reducedMotion) render(); },
    setLang(mode) { langMode = mode; if (reducedMotion) render(); },
    flyBook() { if (!reducedMotion) fly = { t: 0 }; },
    fetchWordbook(cb) { fetchWordbook(cb); },
    getAgentInfo(id) { return chars[id] ? { id, name: chars[id].role.name, role: chars[id].role.role, color: chars[id].role.shirt } : null; },
    reset() {
      sim.active = false; selected = null; sim.presented = false; sim.boardActive = false;
      sim.synthQueue = []; sim.synthBusy = false; sim.handed = 0;
      sim.leaderQueue = []; sim.leaderBusy = false;
      ambLocks.kitchen = ambLocks.snack = ambLocks.cooler = false;
      STATIONS.forEach(s => { const e = chars[s.id];
        e.x = s.seat[0]*TILE+8; e.y = s.seat[1]*TILE+8; e.tile = s.seat.slice();
        e.path = null; e.onArrive = null; e.facing = 'down'; e.state = 'idle';
	        e.timer = 0; e.onTimer = null; e.bubble = ''; e._report = ''; e.statusText = ''; e.workStart = 0; e.asleep = false;
	        e._queuedDeliver = false; e._returningToDesk = false; e.ambKind = null;
        e.idleTimer = AMB_MIN + Math.floor(Math.random() * AMB_RAND);
        delete taskState[s.id];
      });
      petQueue.length = 0;
      Object.assign(pets.pika, { x:T(18)+8, y:T(10)+10, tile:[18,10], path:null, onArrive:null, facing:'left', state:'idle', timer:80, onTimer:null, bubble:'', card:'' });
      Object.assign(pets.dog,  { x:T(17)+8, y:T(10)+8,  tile:[17,10], path:null, onArrive:null, facing:'left', state:'idle', timer:120, onTimer:null, bubble:'', card:'' });
      Object.assign(pets.cat,  { x:T(14)+8, y:T(10)+8,  tile:[14,10], path:null, onArrive:null, facing:'right', state:'idle', timer:160, onTimer:null, bubble:'', card:'' });
      if (reducedMotion) render();
    },
    agents: STATIONS.map(s => s.id),
  };
})();
