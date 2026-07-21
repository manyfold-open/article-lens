'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentPhase = 'input';
let currentResult = null;
let agentsDone = 0;
let totalAgents = 4;
let reportReady = false;     // result has arrived; report is filled but hidden
let reportTimer = 0;         // fallback timer to reveal the report
let kbFilter = 'all';
let kbSort = 'recent';
let kbQuery = '';
let latestBriefing = null;
let workflowStage = 'idle';

const AGENT_NAMES = {
  orch:     { zh: '隊長', en: 'Orchestrator' },
  sum:      { zh: '小摘', en: 'Summarizer' },
  jargon:   { zh: '小詞', en: 'Jargon' },
  comments: { zh: '小潛', en: 'Comments' },
  ctx:      { zh: '小導', en: 'Context' },
  synth:    { zh: '合成', en: 'Synthesizer' },
};
const AGENT_COLORS = {
  orch: '#FF6600', sum: '#3B82F6', jargon: '#F59E0B',
  comments: '#14B8A6', ctx: '#8B5CF6', synth: '#EC4899',
};
// latest SSE label/state per agent — powers the click-to-inspect panel
const agentStatus = {};
const sandboxDownAgents = new Set();
const sandboxDownReasons = {};
const WORKFLOW_STAGES = [
  { key: 'recall', label: { zh: '集合', en: 'Gather' } },
  { key: 'assign', label: { zh: '分派', en: 'Assign' } },
  { key: 'analyze', label: { zh: '分析', en: 'Analyze' } },
  { key: 'synth', label: { zh: '整合', en: 'Integrate' } },
  { key: 'present', label: { zh: '簡報', en: 'Present' } },
];

// ── i18n ─────────────────────────────────────────────────────────────────
function getLang() { return document.documentElement.dataset.lang || 'en'; }
function L(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  const lang = getLang();
  return v[lang] ?? v.zh ?? v.en ?? '';
}
function syncI18nAttrs() {
  const lang = getLang();
  document.querySelectorAll('[data-zh-ph]').forEach(el => { el.placeholder = lang === 'zh' ? el.dataset.zhPh : el.dataset.enPh; });
  document.querySelectorAll('[data-zh-title]').forEach(el => { el.title = lang === 'zh' ? el.dataset.zhTitle : el.dataset.enTitle; });
  document.querySelectorAll('[data-zh-aria]').forEach(el => { el.setAttribute('aria-label', lang === 'zh' ? el.dataset.zhAria : el.dataset.enAria); });
  document.querySelectorAll('option[data-zh]').forEach(el => { el.textContent = lang === 'zh' ? el.dataset.zh : el.dataset.en; });
}
// Re-render UI chrome that isn't tied to an analysis result (workflow strip,
// edit-toggle button, front-page toggle, static attrs) when the language flips.
function refreshChrome() {
  syncI18nAttrs();
  renderWorkflowStrip();
  syncEditToggle();
  syncFpToggleLabel();
}

// ── Phase control ──────────────────────────────────────────────────────────
function setPhase(phase) {
  currentPhase = phase;
  document.documentElement.dataset.phase = phase;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (window.pixelAgents) {
    window.pixelAgents.init('pixel-stage');
    window.pixelAgents.setClickHandler(onAgentClick);
    window.pixelAgents.setHoverHandler(onAgentHover);
    window.pixelAgents.setPresentHandler(revealReport);
  }
  document.getElementById('agent-panel-close').addEventListener('click', closeAgentPanel);
  document.getElementById('agent-panel-overlay').addEventListener('click', closeAgentPanel);
  kbRender();
  renderWorkflowStrip();
  loadFrontPage();

  // Core actions
  document.getElementById('analyze-btn').addEventListener('click', onAnalyzeClick);
  document.getElementById('hn-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') onAnalyzeClick();
  });
  document.getElementById('back-btn').addEventListener('click', () => {
    setPhase('input');
    if (window.pixelAgents) window.pixelAgents.reset();
  });

  // KB — opened via the office bookshelf (hit-target overlay)
  document.getElementById('kb-hit').addEventListener('click', openKbFromOffice);
  document.getElementById('kb-close').addEventListener('click', kbClose);
  document.getElementById('kb-overlay').addEventListener('click', kbClose);
  document.getElementById('kb-search')?.addEventListener('input', e => {
    kbQuery = e.target.value.trim().toLowerCase();
    kbRender();
  });
  document.querySelectorAll('.kb-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      kbFilter = btn.dataset.filter || 'all';
      kbRender();
    });
  });
  document.getElementById('kb-sort')?.addEventListener('change', e => {
    kbSort = e.target.value;
    kbRender();
  });
  document.getElementById('kb-export')?.addEventListener('click', kbExport);
  document.getElementById('kb-import')?.addEventListener('click', () => {
    document.getElementById('kb-import-file')?.click();
  });
  document.getElementById('kb-import-file')?.addEventListener('change', kbImport);

  // Language — switched via the office wall sign (cycles 中 / EN)
  document.getElementById('lang-hit').addEventListener('click', cycleLang);

  // Whiteboard — opens 隊長's briefing report
  document.getElementById('wb-hit').addEventListener('click', () => onAgentClick('orch'));

  // Ask 小詞
  document.getElementById('ask-btn').addEventListener('click', onAskXici);
  document.getElementById('ask-term').addEventListener('keydown', e => {
    if (e.key === 'Enter') onAskXici();
  });

  // Example chips (skip the front-page toggle, which has no data-url)
  document.querySelectorAll('.chip[data-url]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('hn-input').value = chip.dataset.url;
      onAnalyzeClick();
    });
  });

  // Front-page list: collapsed by default, toggled from the chat dock.
  const fpToggle = document.getElementById('fp-toggle');
  if (fpToggle) fpToggle.addEventListener('click', () => {
    const sec = document.getElementById('frontpage-section');
    const open = sec.hasAttribute('hidden');
    if (open) sec.removeAttribute('hidden'); else sec.setAttribute('hidden', '');
    syncFpToggleLabel();
  });

  // Edit-office mode — drag teammates into pods, set modes, disable workers.
  const editToggle = document.getElementById('edit-toggle');
  if (editToggle) editToggle.addEventListener('click', toggleEditMode);

  // Task presets — load a spec into the office (enabled+effort per worker).
  document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => onPresetClick(btn.dataset.preset));
  });
  // 受眾語氣 (reader level) — orthogonal to the depth preset; just shifts tone.
  document.querySelectorAll('.preset-btn[data-audience]').forEach(btn => {
    btn.addEventListener('click', () => onAudienceClick(btn.dataset.audience || null));
  });
  // When the user free-tunes in edit mode (effort/mode badges, benching), keep
  // the preset highlight + meter in sync.
  if (window.pixelAgents?.setSpecChangeHandler) {
    window.pixelAgents.setSpecChangeHandler(syncPresetPicker);
  }

  // Initial office-control state
  if (window.pixelAgents) {
    window.pixelAgents.setKbCount(kbLoad().length);
    window.pixelAgents.setLang(getLang());
    syncPresetPicker();   // reflect any restored/persisted spec on the picker
    syncAudiencePicker(); // reflect the restored/persisted reader level
  }
  refreshChrome();
});

// ── Task presets ─────────────────────────────────────────────────────────────
function onPresetClick(name) {
  const pa = window.pixelAgents;
  if (!pa || !pa.applyPreset) return;
  // Applying a preset only makes sense from the office hub; leave results view.
  if (currentPhase !== 'input') { setPhase('input'); pa.reset(); }
  pa.applyPreset(name);
  syncPresetPicker();
}

// Highlight the preset the current office spec matches (or none, when the user
// has free-tuned into an arrangement no preset covers).
function syncPresetPicker() {
  const pa = window.pixelAgents;
  if (!pa || !pa.getActivePreset) return;
  const active = pa.getActivePreset();
  let activeBtn = null;
  document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
    const on = btn.dataset.preset === active;
    btn.classList.toggle('active', on);
    if (on) activeBtn = btn;
  });
  // Caption = a live workflow summary composed from the current office spec
  // (which readers run, in what grouping, at what effort/×N, ctx/synth, cost).
  // Falls back to the static preset description if the summary is unavailable.
  const caption = document.getElementById('preset-caption');
  if (caption) {
    let text = '';
    if (pa.getWorkflowSummary) { try { text = pa.getWorkflowSummary(); } catch { text = ''; } }
    if (!text) {
      text = activeBtn
        ? (getLang() === 'zh' ? activeBtn.dataset.descZh : activeBtn.dataset.descEn) || ''
        : L({ zh: '🛠️ 自訂編排 · 你手動調整過，不符合任何範本', en: "🛠️ Custom arrangement · you've tuned this by hand, no preset matches" });
    }
    caption.textContent = text;
  }
}

// ── 受眾語氣 (reader level) ─────────────────────────────────────────────────────
// Orthogonal to the depth preset: just shifts the tone/depth of the analysis.
// Persisted in the office (localStorage), so no phase change is forced — it takes
// effect on the next run.
function onAudienceClick(level) {
  const pa = window.pixelAgents;
  if (!pa || !pa.setAudience) return;
  pa.setAudience(level);       // null | 'beginner' | 'expert'
  syncAudiencePicker();
  syncPresetPicker();          // refresh the caption (it carries the 受眾 tag)
}

function syncAudiencePicker() {
  const pa = window.pixelAgents;
  const cur = (pa && pa.getAudience) ? (pa.getAudience() || '') : '';
  document.querySelectorAll('.preset-btn[data-audience]').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.audience || '') === cur);
  });
}

// ── Edit-office mode toggle ─────────────────────────────────────────────────
function toggleEditMode() {
  const pa = window.pixelAgents;
  if (!pa || !pa.setEditMode) return;
  const next = !pa.isEditMode();
  // Editing only makes sense from the office hub; bail out of results view.
  if (next && currentPhase !== 'input') {
    setPhase('input');
    pa.reset();
  }
  pa.setEditMode(next);
  syncEditToggle();
}

function syncEditToggle() {
  const pa = window.pixelAgents;
  const btn = document.getElementById('edit-toggle');
  if (!btn || !pa || !pa.isEditMode) return;
  const on = pa.isEditMode();
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.textContent = on ? L({ zh: '✓ 完成編排', en: '✓ Done arranging' }) : L({ zh: '🛠️ 編排辦公室', en: '🛠️ Arrange office' });
  document.documentElement.dataset.editmode = on ? 'on' : 'off';
}

const LANG_CYCLE = ['en', 'zh'];   // EN (default) / 中 only (no bilingual)
function cycleLang() {
  const cur = getLang();
  const next = LANG_CYCLE[(LANG_CYCLE.indexOf(cur) + 1) % LANG_CYCLE.length];
  document.documentElement.dataset.lang = next;
  document.documentElement.lang = next === 'zh' ? 'zh-TW' : 'en';
  if (window.pixelAgents) window.pixelAgents.setLang(next);
  refreshChrome();
  if (next === 'en') ensureEnglish();   // agents only write zh; fetch English on demand
  else if (currentResult) { renderResults(currentResult); selectAgentSection(selectedAgent); }
}

const TODAYS_PICKS_LABEL = { zh: '今日精選', en: "Today's Picks" };
function syncFpToggleLabel() {
  const fpToggle = document.getElementById('fp-toggle');
  const sec = document.getElementById('frontpage-section');
  if (!fpToggle || !sec) return;
  const collapsed = sec.hasAttribute('hidden');
  fpToggle.textContent = `${L(TODAYS_PICKS_LABEL)} ${collapsed ? '▾' : '▴'}`;
}

function openKbFromOffice() {
  if (window.pixelAgents?.fetchWordbook) window.pixelAgents.fetchWordbook(kbOpen);
  else kbOpen();
}

// Lazy English: agents produce only Chinese. The first time the user shows EN,
// translate the result's zh strings via /api/translate and cache client-side.
const transCache = new Map();
function collectBi(r) {
  const out = [];
  const add = b => { if (b && typeof b === 'object' && typeof b.zh === 'string' && b.zh) out.push(b); };
  if (!r) return out;
  add(r.title); add(r.verdict?.why_frontpage); add(r.editor_note);
  add(r.summary?.tldr); (r.summary?.key_points || []).forEach(add);
  (r.jargon || []).forEach(t => add(t.explain));
  const cd = r.comment_digest || {};
  add(cd.overview); add(cd.consensus);
  (cd.camps || []).forEach(c => { add(c.label); add(c.stance); });
  (cd.disputes || []).forEach(add);
  (cd.expert_corrections || []).forEach(e => add(e.correction));
  return out;
}
async function ensureEnglish() {
  if (!currentResult) return;
  const bis = collectBi(currentResult);
  const need = [...new Set(bis.filter(b => !b.en && !transCache.has(b.zh)).map(b => b.zh))];
  if (need.length) {
    try {
      const res = await fetch('/api/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zh: need }),
      });
      const data = await res.json();
      const en = Array.isArray(data.en) ? data.en : [];
      need.forEach((zh, i) => transCache.set(zh, en[i] || zh));
    } catch { need.forEach(zh => transCache.set(zh, zh)); }
  }
  bis.forEach(b => { if (!b.en && transCache.has(b.zh)) b.en = transCache.get(b.zh); });
  if (currentResult) { renderResults(currentResult); selectAgentSection(selectedAgent); }
}

// ── Analyze flow ───────────────────────────────────────────────────────────
function onAnalyzeClick() {
  const input = document.getElementById('hn-input').value.trim();
  if (!input) { showError(L({ zh: '貼個 HN 連結、文章網址，或一段文字', en: 'Paste a HN link, an article URL, or some text' })); return; }
  hideError();
  startAnalysis(resolveInput(input));
}

function parseHNId(input) {
  input = input.trim();
  if (/^\d+$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname.includes('ycombinator.com')) return url.searchParams.get('id');
  } catch {}
  const m = input.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

// Decide what the pasted text is: a HN item, any article URL, or raw text.
function resolveInput(raw) {
  const id = parseHNId(raw);
  if (id) return { kind: 'id', value: id };
  if (/^https?:\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(raw)) {
    return { kind: 'url', value: /^https?:\/\//i.test(raw) ? raw : 'https://' + raw };
  }
  return { kind: 'text', value: raw };
}

function startAnalysis(input) {
  agentsDone = 0;
  totalAgents = 4;
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent = L({ zh: '分析中…', en: 'Analyzing…' });
  document.getElementById('agents-status').innerHTML = '';
  Object.keys(agentStatus).forEach(k => delete agentStatus[k]);
  sandboxDownAgents.clear();
  Object.keys(sandboxDownReasons).forEach(k => delete sandboxDownReasons[k]);
  latestBriefing = null;
  currentResult = null;
  clearReportPanels();
  closeAgentPanel();
  reportReady = false; clearTimeout(reportTimer);
  setWorkflowStage('recall');
  if (window.pixelAgents) window.pixelAgents.receiveTask();
  syncEditToggle();   // a run auto-exits edit mode in the sim; reflect it on the button
  setPhase('running');

  let qs = input.kind === 'id'  ? 'id=' + encodeURIComponent(input.value)
         : input.kind === 'url' ? 'url=' + encodeURIComponent(input.value)
         :                        'text=' + encodeURIComponent(input.value.slice(0, 4000));
  // Send the user's saved terms so 小詞 skips what they already know.
  const kb = kbLoad().map(i => String(i.term).replace(/,/g, ' ')).filter(Boolean).slice(0, 80);
  if (kb.length) qs += '&kb=' + encodeURIComponent(kb.join(','));
  // If the user has arranged the office (drag/pods/mode/disable), pass the
  // resulting graphConfig so the arrangement drives the real analysis. When the
  // layout is the default, getGraphConfig() returns null and nothing is sent.
  const cfg = window.pixelAgents?.getGraphConfig?.();
  if (cfg) qs += '&graph=' + encodeURIComponent(JSON.stringify(cfg));
  const es = new EventSource(`/api/analyze?${qs}`);
  es.onmessage = e => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleSSEEvent(ev, es);
  };
  es.onerror = () => {
    es.close();
    showError(L({ zh: '連線中斷', en: 'Connection lost' }));
    setPhase('input');
  };
}

function handleSSEEvent(ev, es) {
  switch (ev.event) {
    case 'plan':
      setWorkflowStage('assign');
      totalAgents = ev.agents.length;
      ev.agents.forEach(a => {
        ensureAgentRow(a);
        sandboxDownAgents.delete(a);
        delete sandboxDownReasons[a];
        if (window.pixelAgents) window.pixelAgents.setAgentState(a, 'idle');
      });
      // Kick off the office choreography: 隊長 walks over to assign the work.
      if (window.pixelAgents) window.pixelAgents.startRun();
      break;
    case 'status':
      agentStatus[ev.agent] = { state: ev.state, label: ev.label };
      // 合成 (Synthesizer) has a desk now — animate it, but it doesn't count
      // toward the progress bar (only the 4 workers do). Also mirror to the
      // progress line so its step text stays visible.
      if (ev.agent === 'synth') {
        if (ev.state === 'running') setWorkflowStage('synth');
        const pt = document.getElementById('progress-text');
        if (pt && ev.label) pt.textContent = L(ev.label);
        if (window.pixelAgents && !sandboxDownAgents.has('synth')) {
          const sState = ev.state === 'running' ? 'typing' : ev.state;
          window.pixelAgents.setAgentState('synth', sState);
          if (ev.label) window.pixelAgents.setSpeechBubble('synth', L(ev.label));
        }
        break;
      }
      updateAgentRow(ev.agent, ev.state, ev.label);
      if (ev.state === 'running') setWorkflowStage('analyze');
      if (window.pixelAgents && !sandboxDownAgents.has(ev.agent)) {
        const pxState = ev.state === 'running' ? 'typing' : ev.state;
        window.pixelAgents.setAgentState(ev.agent, pxState);
        if (ev.label) window.pixelAgents.setSpeechBubble(ev.agent, L(ev.label));
      }
      if (ev.state === 'done') { agentsDone++; updateProgress(); }
      break;
    case 'step':
      agentStatus[ev.agent] = { state: 'running', label: ev.label };
      updateBubble(ev.agent, ev.label);
      if (window.pixelAgents && ev.label && !sandboxDownAgents.has(ev.agent)) window.pixelAgents.setSpeechBubble(ev.agent, L(ev.label));
      break;
    case 'section':
      if (ev.data?.briefing) latestBriefing = ev.data.briefing;
      renderSection(ev.agent, ev.data);   // populate this panel as soon as it's ready
      break;
    case 'usage':
      // Per-agent token usage — accumulate into the office token meter (actual).
      if (window.pixelAgents?.addUsage) window.pixelAgents.addUsage(ev.agent, ev.tokens);
      break;
    case 'escalate':
      // 💸 省錢漸進: after running sum+ctx first, the backend decides whether the
      // article is worth reading. 'go' → wake the standby candidates (jargon+comments)
      // from the dining corner into the readers zone; 'stop' → they stay asleep and
      // the run wraps with just sum+ctx→synth→隊長.
      if (window.pixelAgents?.escalateDecision) {
        window.pixelAgents.escalateDecision(ev.decision === 'go' ? 'go' : 'stop');
      }
      break;
    case 'result':
      es.close();
      currentResult = ev.data;
      // Finalize the token meter from the authoritative total, if provided.
      if (ev.data?.usage && window.pixelAgents?.setUsageTotal && typeof ev.data.usage.total === 'number') {
        window.pixelAgents.setUsageTotal(ev.data.usage.total);
      }
      renderResults(ev.data);     // fill the report, but keep it hidden…
      if (getLang() === 'en') ensureEnglish();   // default lang is en; agents only wrote zh
      setWorkflowStage('present');
      armReport();                // …until 隊長 walks to the whiteboard to present
      break;
    case 'error':
      if (ev.agent) {
        const sandboxDown = ev.kind === 'sandbox_unavailable';
        const current = agentStatus[ev.agent]?.state;
        if (!sandboxDown && (current === 'running' || current === 'done')) break;
        if (sandboxDown) {
          sandboxDownAgents.add(ev.agent);
          sandboxDownReasons[ev.agent] = ev.message ? { zh: ev.message, en: ev.message } : { zh: 'sandbox/runtime 不在線', en: 'sandbox/runtime offline' };
        }
        agentStatus[ev.agent] = {
          state: 'error',
          label: sandboxDown
            ? { zh: 'sandbox 睡著了 💤', en: 'sandbox asleep 💤' }
            : { zh: '睡著了 💤', en: 'asleep 💤' },
        };
        if (window.pixelAgents) {
          window.pixelAgents.setAsleep(ev.agent, true);
          window.pixelAgents.setSpeechBubble(ev.agent, sandboxDown ? L({ zh: '💤 sandbox 睡著了', en: '💤 sandbox asleep' }) : L({ zh: '💤 睡著了', en: '💤 asleep' }));
        }
      } else {
        // Fatal error — abort the run.
        es.close();
        showError(ev.message);
        if (currentPhase === 'running') setPhase('input');
      }
      break;
  }
}

function updateProgress() {
  const pct = Math.round((agentsDone / totalAgents) * 100);
  document.getElementById('progress-fill').style.width = pct + '%';
  if (pct >= 100) document.getElementById('progress-text').textContent = L({ zh: '整合結果中…', en: 'Synthesizing…' });
}

function setWorkflowStage(stage) {
  workflowStage = stage;
  renderWorkflowStrip();
}

function renderWorkflowStrip() {
  const el = document.getElementById('workflow-strip');
  if (!el) return;
  const activeIdx = WORKFLOW_STAGES.findIndex(s => s.key === workflowStage);
  el.innerHTML = WORKFLOW_STAGES.map((s, i) => {
    const state = activeIdx < 0 ? 'idle' : i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'idle';
    return `<div class="workflow-step ${state}">
      <span class="workflow-dot"></span>
      <span class="workflow-label">${esc(L(s.label))}</span>
    </div>`;
  }).join('');
}

// The report is filled as soon as the result arrives, but stays hidden until
// 隊長 walks to the whiteboard to present it (pixel present handler → revealReport).
//
// Ordering guarantee: the office is the single source of truth for WHEN the
// report is revealed. The result SSE arrives when the *backend* finishes — which
// is typically well before the office finishes its choreography (readers deliver
// → 合成 visibly integrates → hands the report to 隊長 → 隊長 walks to the board).
// Revealing on result arrival (or on a short timer) is exactly the desync we are
// fixing: it flashes the report while 合成 still shows "整合中". So the ONLY normal
// reveal trigger is the pixel present handler (revealReport), fired when 隊長
// actually reaches the whiteboard. The timer below is a pure soft-lock backstop —
// long enough that it can never race a healthy run to completion, so it only ever
// fires if the office genuinely never reached the present step.
const REPORT_REVEAL_BACKSTOP_MS = 45000;   // safety net only; the office presents first
function armReport() {
  reportReady = true;
  clearTimeout(reportTimer);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Reduced-motion runs no animated office, so there is nothing to be out of sync
  // with — the result arriving IS the logical "present" step. Reveal immediately.
  if (reduced) { revealReport(); return; }
  reportTimer = setTimeout(revealReport, REPORT_REVEAL_BACKSTOP_MS);   // backstop; we never get stuck
}
function revealReport() {
  clearTimeout(reportTimer);
  if (!reportReady || currentPhase === 'results') return;
  setWorkflowStage('present');
  setPhase('results');
}

// ── Agent detail panel (click a character in the office) ────────────────────
function openAgentPanel(id) {
  const info = AGENT_NAMES[id] || { zh: id, en: id };
  document.getElementById('agent-panel-swatch').style.background = AGENT_COLORS[id] || 'var(--accent)';
  document.getElementById('agent-panel-title').textContent = L(info);
  document.getElementById('agent-panel-role').textContent = getLang() === 'zh' ? info.en : info.zh;

  const st = agentStatus[id];
  const statusEl = document.getElementById('agent-panel-status');
  if (st && st.label) statusEl.textContent = `${L(st.label)} ${st.state === 'done' ? '✓' : '…'}`;
  else statusEl.textContent = currentResult ? L({ zh: '已完成 ✓', en: 'Done ✓' }) : L({ zh: '待命中', en: 'Standby' });

  document.getElementById('agent-panel-body').innerHTML = agentPanelBody(id);

  const ov = document.getElementById('agent-panel-overlay');
  const panel = document.getElementById('agent-panel');
  ov.hidden = false; panel.hidden = false;
  requestAnimationFrame(() => { ov.classList.add('open'); panel.classList.add('open'); });
}

function closeAgentPanel() {
  const ov = document.getElementById('agent-panel-overlay');
  const panel = document.getElementById('agent-panel');
  if (!ov || !panel) return;
  ov.classList.remove('open'); panel.classList.remove('open');
  setTimeout(() => { ov.hidden = true; panel.hidden = true; }, 200);
}

function agentPanelEmpty() { return `<p class="muted">${esc(L({ zh: '這位目前沒有可顯示的產出。', en: 'Nothing to show yet.' }))}</p>`; }

function agentPanelBody(id) {
  const r = currentResult;
  if (!r) return `<p class="muted">${esc(L({ zh: '分析還在進行中… 完成後再點一次看完整結果。', en: 'Still working — click again once done.' }))}</p>`;
  const trust = sectionTrustNote(id);
  switch (id) {
    case 'sum':
      return r.summary ? `${trust}<p><strong>${esc(L(r.summary.tldr))}</strong></p>
        <ul>${(r.summary.key_points || []).map(k => `<li>${esc(L(k))}</li>`).join('')}</ul>` : agentPanelEmpty();
    case 'jargon':
      return (r.jargon && r.jargon.length) ? `${trust}<ul>${r.jargon.map(t =>
        `<li><strong class="mono">${esc(t.term)}</strong>（${esc(t.zh_term)}）— ${esc(L(t.explain))}</li>`).join('')}</ul>` : trust || agentPanelEmpty();
    case 'comments': {
      const cd = r.comment_digest; if (!cd) return agentPanelEmpty();
      return `${trust}<p>${esc(L(cd.overview))}</p>
        <ul>${(cd.camps || []).map(c => `<li><strong>${esc(L(c.label))}</strong>（${esc(L(WEIGHT_LABEL[c.weight]) || c.weight)}）：${esc(L(c.stance))}</li>`).join('')}</ul>`;
    }
    case 'ctx':
      return r.verdict ? `${trust}<p><strong>${esc(L(WORTH_LABEL[r.verdict.worth_reading]) || r.verdict.worth_reading)}</strong>（${esc(L(TIER_LABEL[r.verdict.tier]) || r.verdict.tier)}）</p>
        <p>${esc(L(r.verdict.why_frontpage))}</p>` : agentPanelEmpty();
    case 'synth':
      return (r.editor_note && (r.editor_note.zh || r.editor_note.en)) ? `${trust}<p>📋 ${esc(L(r.editor_note))}</p>` : `${trust}<p class="muted">${esc(L({ zh: '已將各組輸出整合成最終結果。', en: 'Integrated all outputs into the final result.' }))}</p>`;
    case 'orch':
      return agentPanelCaptain(r);
    default: return agentPanelEmpty();
  }
}

const ASSIGN_ACTION_LABEL = { run: { zh: '開工', en: 'Run' }, skip: { zh: '略過', en: 'Skip' }, reuse: { zh: '快取', en: 'Cache' } };
const KB_KNOWN_LABEL = { zh: '已會', en: 'Known' };
const SAVE_LABEL = { zh: '＋ 收藏', en: '+ Save' };
const SAVED_LABEL = { zh: '✓ 已收藏', en: '✓ Saved' };

function agentPanelCaptain(r) {
  const briefing = r.briefing || latestBriefing;
  const rows = (briefing?.assignments || []).map(a =>
    `<li><strong>${esc(agentLabel(a.agent))}</strong>：${esc(L(ASSIGN_ACTION_LABEL[a.action]) || a.action)} — ${esc(L(a.reason))}</li>`
  ).join('');
  return `<p class="muted">${esc(L({ zh: '讀題、分派任務給組員，再彙整成果。', en: 'Reads the brief, assigns tasks to the team, then compiles the results.' }))}</p>
    ${briefing ? `<ul>${rows}</ul>` : ''}
    <p>${esc(L({ zh: `術語 ${(r.jargon || []).length} 個 · 留言派別 ${((r.comment_digest || {}).camps || []).length} 組`, en: `${(r.jargon || []).length} terms · ${((r.comment_digest || {}).camps || []).length} camps` }))}</p>`;
}

// ── Agent rows ─────────────────────────────────────────────────────────────
function ensureAgentRow(agent) {
  const container = document.getElementById('agents-status');
  if (!container.querySelector(`[data-agent="${agent}"]`)) {
    const info = AGENT_NAMES[agent] || { zh: agent, en: agent };
    const row = document.createElement('div');
    row.className = 'agent-row idle';
    row.dataset.agent = agent;
    row.innerHTML = `
      <div class="agent-dot"></div>
      <div class="agent-info">
        <span class="agent-name">${esc(L(info))}</span>
        <span class="agent-bubble"></span>
      </div>`;
    container.appendChild(row);
  }
}

function updateAgentRow(agent, state, label) {
  const row = document.querySelector(`[data-agent="${agent}"]`);
  if (!row) return;
  row.className = `agent-row ${state}`;
  if (label) updateBubble(agent, label);
}

function updateBubble(agent, label) {
  const row = document.querySelector(`[data-agent="${agent}"]`);
  if (!row || !label) return;
  const b = row.querySelector('.agent-bubble');
  if (b) b.textContent = L(label);
}

// ── Results rendering ──────────────────────────────────────────────────────
function renderResults(r) {
  latestBriefing = r.briefing || latestBriefing;
  renderVerdictBar(r.verdict, r.source, r.flags);
  renderWhiteboardVerdict(r);
  renderJargon(r.jargon || []);
  renderSummary(r.summary);
  renderCommentDigest(r.comment_digest, r.item_id, r.flags);
  renderContext(r);
  renderBriefing(r);     // 隊長 (also opened by clicking the whiteboard)
  renderSynth(r);        // 合成 — distinct from 小導
  renderMetaBar(r);
  selectAgentSection('jargon');           // default-open panel = 小詞
}

function clearReportPanels() {
  ['verdict-bar', 'jargon-list', 'summary-content', 'comments-content', 'context-content', 'briefing-content', 'synth-content', 'meta-bar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
  const board = document.getElementById('whiteboard-verdict');
  if (board) { board.innerHTML = ''; board.dataset.worth = ''; }
  document.querySelectorAll('.result-panel').forEach(p => p.classList.remove('active'));
}

function renderWhiteboardVerdict(r) {
  const board = document.getElementById('whiteboard-verdict');
  if (!board) return;
  const v = r.verdict || {};
  const worth = L(WORTH_LABEL[v.worth_reading]) || v.worth_reading || '';
  const tier = L(TIER_LABEL[v.tier]) || v.tier || '';
  board.dataset.worth = v.worth_reading || '';
  board.innerHTML = `
    <span class="wbv-k">${esc(L({ zh: '隊長裁定', en: "Orchestrator's verdict" }))}</span>
    <span class="wbv-main">${esc(worth)}</span>
    <span class="wbv-sub">${esc(tier)}</span>
    <span class="wbv-why">${esc(L(v.why_frontpage))}</span>`;
}

const SOURCE_BADGE = {
  hn:      { label: { zh: 'HN 討論', en: 'HN Discussion' }, cls: 'badge-muted' },
  article: { label: { zh: '文章', en: 'Article' },          cls: 'badge-muted' },
  text:    { label: { zh: '貼上的文字', en: 'Pasted Text' }, cls: 'badge-muted' },
};
const WORTH_LABEL = {
  high:   { zh: '強烈推薦', en: 'Highly Recommended' },
  medium: { zh: '值得一看', en: 'Worth Reading' },
  low:    { zh: '可略過', en: 'Can Skip' },
};
const TIER_LABEL = {
  '10s': { zh: '10 秒看完', en: '10-second read' },
  '1min': { zh: '1 分鐘', en: '1-minute read' },
  deep: { zh: '深讀', en: 'Deep read' },
};
const WEIGHT_LABEL = {
  majority: { zh: '主流', en: 'Majority' },
  'vocal-minority': { zh: '少數派', en: 'Vocal Minority' },
  fringe: { zh: '邊緣觀點', en: 'Fringe' },
};

// Slim, always-visible verdict bar between the office and the panels.
function renderVerdictBar(v, source, flags) {
  const wc = { high: 'badge-green', medium: 'badge-amber', low: 'badge-red' }[v.worth_reading] || 'badge-amber';
  const wl = L(WORTH_LABEL[v.worth_reading]) || v.worth_reading;
  const tl = L(TIER_LABEL[v.tier]) || v.tier;
  const sb = SOURCE_BADGE[source];
  const bar = document.getElementById('verdict-bar');
  bar.dataset.worth = v.worth_reading;
  bar.innerHTML = `
    <span class="badge ${wc}">${esc(wl)}</span>
    <span class="badge badge-muted">${esc(tl)}</span>
    ${sb ? `<span class="badge ${sb.cls}">${esc(L(sb.label))}</span>` : ''}
    ${flags?.low_confidence ? `<span class="badge badge-amber">${esc(L({ zh: '低信心', en: 'Low confidence' }))}</span>` : ''}
    ${flags?.comments_sampled ? `<span class="badge badge-muted">${esc(L({ zh: '留言採樣', en: 'Comments sampled' }))}</span>` : ''}
    ${(flags?.fallback_agents || []).length ? `<span class="badge badge-amber">${esc(L({ zh: '含備援', en: 'Includes fallback' }))}</span>` : ''}
    <span class="vb-why">${esc(L(v.why_frontpage))}</span>`;
}

// 小導 (Context) — should I read this & why. Verdict + why only (no editor note).
function renderContext(r) {
  const v = r.verdict || {};
  document.getElementById('context-content').innerHTML = `
    ${sectionTrustNote('ctx')}
    <div class="brief-row"><span class="brief-k mono">${esc(L({ zh: '值得讀嗎', en: 'Worth reading?' }))}</span>
      <span class="badge badge-amber">${esc(L(WORTH_LABEL[v.worth_reading]) || v.worth_reading || '')}</span>
      <span class="badge badge-muted">${esc(L(TIER_LABEL[v.tier]) || v.tier || '')}</span></div>
    <p class="verdict-why bi-zh">${esc(v.why_frontpage?.zh || '')}</p>
    <p class="verdict-why bi-en">${esc(v.why_frontpage?.en || '')}</p>`;
}

// 隊長 (Orchestrator) — the structured briefing shown on the whiteboard.
function renderBriefing(r) {
  const v = r.verdict || {};
  const nJ = (r.jargon || []).length;
  const nC = ((r.comment_digest || {}).camps || []).length;
  const nK = ((r.summary || {}).key_points || []).length;
  const briefing = r.briefing || latestBriefing;
  const assignments = briefing?.assignments || [];
  const flags = r.flags || {};
  document.getElementById('briefing-content').innerHTML = `
    <p class="brief-title bi-zh">${esc(r.title?.zh || '')}</p>
    <p class="brief-title bi-en">${esc(r.title?.en || '')}</p>
    <div class="brief-row"><span class="brief-k mono">${esc(L({ zh: '結論', en: 'Verdict' }))}</span>
      <span class="badge badge-amber">${esc(L(WORTH_LABEL[v.worth_reading]) || v.worth_reading || '')}</span>
      <span class="badge badge-muted">${esc(L(TIER_LABEL[v.tier]) || v.tier || '')}</span></div>
    <div class="brief-row"><span class="brief-k mono">${esc(L({ zh: '一句話', en: 'TL;DR' }))}</span>
      <span class="brief-v bi-zh">${esc(r.summary?.tldr?.zh || '')}</span>
      <span class="brief-v bi-en">${esc(r.summary?.tldr?.en || '')}</span></div>
    <div class="brief-row"><span class="brief-k mono">${esc(r.source === 'hn' ? L({ zh: '為何上首頁', en: 'Why on the front page' }) : L({ zh: '為什麼值得讀', en: 'Why worth reading' }))}</span>
      <span class="brief-v bi-zh">${esc(v.why_frontpage?.zh || '')}</span>
      <span class="brief-v bi-en">${esc(v.why_frontpage?.en || '')}</span></div>
    ${briefing ? `<div class="captain-route">
      <strong class="small mono">${esc(L(CAPTAIN_ASSIGNS))}</strong>
      <p class="muted small">${esc(L(briefing.route))}</p>
      ${agentStatusTable(assignments, flags.agent_sources || {}, r)}
    </div>` : ''}
    ${trustBadges(flags)}
    <div class="brief-index mono small muted">${esc(L({ zh: `本次產出：術語 ${nJ} 個 · 留言 ${nC} 派 · 重點 ${nK} 條`, en: `This run: ${nJ} terms · ${nC} camps · ${nK} key points` }))}</div>
    <p class="muted small">${esc(L({ zh: '點上方各小幫手或目錄列看細節', en: 'Click a teammate or row above for details' }))}</p>`;

  document.querySelectorAll('[data-jump-agent]').forEach(btn => {
    btn.addEventListener('click', () => selectAgentSection(btn.dataset.jumpAgent));
  });
}

const CAPTAIN_ASSIGNS = { zh: '隊長分派', en: "Orchestrator's Assignments" };
const MODE_LABEL = {
  real: { zh: '真實分析', en: 'Real analysis' },
  fallback: { zh: '備援', en: 'Fallback' },
  skipped: { zh: '略過', en: 'Skipped' },
  cache: { zh: '快取', en: 'Cache' },
};

function briefNavButton(a, source) {
  const name = agentLabel(a.agent);
  const mode = source?.mode || ({ run: 'real', skip: 'skipped', reuse: 'cache' }[a.action] || 'real');
  const action = L(MODE_LABEL[mode]) || mode;
  const reason = L(source?.reason) || L(a.reason) || '';
  return `<button class="brief-nav-btn ${esc(mode)}" data-jump-agent="${esc(a.agent)}">
    <span>${esc(name)} · ${esc(action)}</span>
    <small>${esc(reason)}</small>
  </button>`;
}

function agentStatusTable(assignments, sources, r) {
  const rows = assignments.map(a => statusRow(a.agent, sources[a.agent], a.reason, r)).join('');
  const synthRow = statusRow('synth', sources.synth, { zh: '整合各組產出並做品管。', en: 'Integrates every teammate’s output and does QA.' }, r);
  return `<div class="agent-status-table">
    ${rows}${synthRow}
  </div>`;
}

function statusRow(agent, source, fallbackReason, r) {
  const mode = source?.mode || 'real';
  const reason = L(source?.reason) || L(fallbackReason) || L({ zh: '等待狀態回報。', en: 'Waiting for status.' });
  return `<button class="agent-status-row ${esc(mode)}" data-jump-agent="${esc(agent)}">
    <span class="agent-status-name">${esc(agentLabel(agent))}</span>
    <span class="agent-status-mode">${esc(L(MODE_LABEL[mode]) || mode)}</span>
    <span class="agent-status-count">${esc(agentOutputCount(agent, r))}</span>
    <span class="agent-status-reason">${esc(reason)}</span>
  </button>`;
}

function agentOutputCount(agent, r) {
  if (agent === 'jargon') return L({ zh: `${(r.jargon || []).length} 詞`, en: `${(r.jargon || []).length} terms` });
  if (agent === 'comments') return L({ zh: `${((r.comment_digest || {}).camps || []).length} 派`, en: `${((r.comment_digest || {}).camps || []).length} camps` });
  if (agent === 'sum') return L({ zh: `${((r.summary || {}).key_points || []).length} 重點`, en: `${((r.summary || {}).key_points || []).length} points` });
  if (agent === 'ctx') return r.verdict?.tier ? (L(TIER_LABEL[r.verdict.tier]) || r.verdict.tier) : L({ zh: '裁定', en: 'Verdict' });
  if (agent === 'synth') return (r.editor_note?.zh || r.editor_note?.en) ? L({ zh: '有註記', en: 'Has note' }) : L({ zh: '完成', en: 'Done' });
  return '';
}

function trustBadges(flags) {
  const bits = [];
  if (flags?.comments_sampled) bits.push(L({ zh: '留言採樣：只看高訊號串', en: 'Comments sampled: high-signal threads only' }));
  if (flags?.fallback_agents?.length) bits.push(L({ zh: `備援內容：${flags.fallback_agents.map(agentLabel).join('、')}`, en: `Fallback content: ${flags.fallback_agents.map(agentLabel).join(', ')}` }));
  if (flags?.skipped_agents?.length) bits.push(L({ zh: `隊長略過：${flags.skipped_agents.map(agentLabel).join('、')}`, en: `Orchestrator skipped: ${flags.skipped_agents.map(agentLabel).join(', ')}` }));
  if (!bits.length) return '';
  return `<div class="trust-notes">${bits.map(b => `<span class="badge badge-muted">${esc(b)}</span>`).join('')}</div>`;
}

function agentLabel(id) {
  return L(AGENT_NAMES[id]) || id;
}

function sectionTrustNote(agent) {
  const flags = currentResult?.flags || {};
  const source = flags.agent_sources?.[agent] || fallbackSource(agent, flags);
  if (!source) return '';
  const spec = {
    real: { label: { zh: '真實分析', en: 'Real analysis' }, cls: 'real' },
    cache: { label: { zh: '使用快取', en: 'Using cache' }, cls: 'cache' },
    fallback: { label: { zh: '備援內容', en: 'Fallback content' }, cls: 'fallback' },
    skipped: { label: { zh: '隊長略過', en: 'Orchestrator skipped' }, cls: 'skipped' },
  }[source.mode] || { label: { zh: source.mode, en: source.mode }, cls: 'cache' };
  return `<div class="source-note ${esc(spec.cls)}">
    <span class="source-note-label">${esc(agentLabel(agent))} · ${esc(L(spec.label))}</span>
    <span class="source-note-reason">${esc(L(source.reason) || (typeof source.reason === 'string' ? source.reason : ''))}</span>
  </div>`;
}

function fallbackSource(agent, flags) {
  if ((flags.fallback_agents || []).includes(agent)) {
    return { mode: 'fallback', reason: { zh: '這段沒有順利取得 agent 回覆，使用備援內容。', en: "Didn't get a reply from the agent, using fallback content." } };
  }
  if ((flags.skipped_agents || []).includes(agent)) {
    return { mode: 'skipped', reason: { zh: '隊長判斷這段不用呼叫 agent。', en: 'Orchestrator decided this section didn’t need an agent call.' } };
  }
  return null;
}

// 合成 (Synthesizer) — integration & QA. Distinct from 小導: this is the editor's
// note on what was pruned/merged, not the verdict.
function renderSynth(r) {
  const en = r.editor_note || {};
  const nJ = (r.jargon || []).length;
  const nC = ((r.comment_digest || {}).camps || []).length;
  const nK = ((r.summary || {}).key_points || []).length;
  document.getElementById('synth-content').innerHTML = `
    ${sectionTrustNote('synth')}
    <p class="muted small">${esc(L({ zh: '整合與品管：把四位組員的產出去蕪存菁、修跨段落不一致。', en: 'Integration & QA: prunes noise from the four teammates’ output and fixes cross-section inconsistencies.' }))}</p>
    <div class="brief-index mono small">${esc(L({ zh: `保留：術語 ${nJ} · 重點 ${nK} · 留言派別 ${nC}`, en: `Kept: ${nJ} terms · ${nK} points · ${nC} camps` }))}</div>
    ${ (en.zh || en.en) ? `
      <p class="editor-note bi-zh">📋 ${esc(en.zh)}</p>
      <p class="editor-note bi-en">📋 ${esc(en.en)}</p>`
      : `<p class="muted small">${esc(L({ zh: '（這次沒有額外編輯註記）', en: '(No additional editor notes this time)' }))}</p>`}`;
}

// Progressive: render one section as soon as its agent finishes, and reveal the
// report so panels visibly populate while the office keeps animating.
function renderSection(agent, data) {
  if (data?.briefing) {
    renderBriefingShell(data.briefing);
    return;
  }
  const shouldShowProgress = currentPhase === 'results' || reportReady;
  if (agent === 'sum') renderSummary(data);
  else if (agent === 'jargon') renderJargon(Array.isArray(data) ? data : []);
  else if (agent === 'comments') renderCommentDigest(data, 0, {});
  else if (agent === 'ctx') { renderVerdictBar(data, undefined, {}); renderContextFromVerdict(data); }
  if (shouldShowProgress && !document.querySelector('.result-panel.active')) selectAgentSection('jargon');
}

function renderBriefingShell(briefing) {
  const el = document.getElementById('briefing-content');
  if (!el) return;
  el.innerHTML = `
    <div class="captain-route">
      <strong class="small mono">${esc(L(CAPTAIN_ASSIGNS))}</strong>
      <p class="muted small">${esc(L(briefing.route))}</p>
      <div class="brief-nav">
        ${(briefing.assignments || []).map(a => briefNavButton(a)).join('')}
      </div>
    </div>`;
  el.querySelectorAll('.brief-nav-btn[data-jump-agent]').forEach(btn => {
    btn.addEventListener('click', () => selectAgentSection(btn.dataset.jumpAgent));
  });
}

function renderContextFromVerdict(v) {
  document.getElementById('context-content').innerHTML = `
    <p class="verdict-why bi-zh">${esc(v.why_frontpage?.zh || '')}</p>
    <p class="verdict-why bi-en">${esc(v.why_frontpage?.en || '')}</p>`;
}

// Which panel each teammate owns — each now has its own report.
const AGENT_SECTION = {
  orch: 'briefing-section', sum: 'summary-section', jargon: 'jargon-section',
  comments: 'comments-section', ctx: 'context-section', synth: 'synth-section',
};
let selectedAgent = 'jargon';

function selectAgentSection(id) {
  const secId = AGENT_SECTION[id] || 'context-section';
  document.querySelectorAll('.result-panel').forEach(p => p.classList.toggle('active', p.id === secId));
  selectedAgent = AGENT_SECTION[id] ? id : 'ctx';
  if (window.pixelAgents && window.pixelAgents.setSelected) window.pixelAgents.setSelected(selectedAgent);
}

// Clicking a teammate: in results, reveal their panel; while running, the drawer.
function onAgentClick(id) {
  hideAgentTooltip();
  if (currentPhase === 'results' && currentResult) selectAgentSection(id);
  else openAgentPanel(id);
}

function onAgentHover(id, pos) {
  if (!id || !pos || !window.pixelAgents?.getAgentInfo) { hideAgentTooltip(); return; }
  const info = window.pixelAgents.getAgentInfo(id);
  if (!info) { hideAgentTooltip(); return; }
  showAgentTooltip(info, pos);
}

function showAgentTooltip(info, pos) {
  const tip = document.getElementById('agent-tooltip');
  if (!tip) return;
  const detail = agentHoverDetail(info.id);
  tip.innerHTML = `<strong>${esc(info.name)}</strong>
    <span>${esc(info.role)}</span>
    <span class="agent-tip-state">${esc(detail.state)}</span>
    ${detail.source ? `<span class="agent-tip-source">${esc(detail.source)}</span>` : ''}
    ${detail.reason ? `<span class="agent-tip-reason">${esc(detail.reason)}</span>` : ''}`;
  tip.hidden = false;
  const x = Math.max(8, Math.min(pos.x + 14, pos.width - 168));
  const y = Math.max(8, pos.y - 50);
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function agentHoverDetail(id) {
  const st = agentStatus[id];
  const source = currentResult?.flags?.agent_sources?.[id];
  const sourceLabels = { real: { zh: '真實分析', en: 'Real analysis' }, cache: { zh: '使用快取', en: 'Using cache' }, fallback: { zh: '備援內容', en: 'Fallback content' }, skipped: { zh: '隊長略過', en: 'Orchestrator skipped' } };
  if (sandboxDownAgents.has(id)) {
    return {
      state: L({ zh: 'sandbox 睡著了', en: 'sandbox asleep' }),
      source: source ? (L(sourceLabels[source.mode]) || source.mode) : L({ zh: 'runtime 不在線', en: 'runtime offline' }),
      reason: L(source?.reason) || L(sandboxDownReasons[id]) || L({ zh: '這位 agent 的執行環境沒有 alive，所以改用備援內容。', en: "This agent's runtime isn't alive, so fallback content was used." }),
    };
  }
  if (source) {
    return {
      state: L(sourceLabels[source.mode]) || source.mode,
      source: agentOutputCount(id, currentResult),
      reason: L(source.reason),
    };
  }
  if (st?.label) {
    const state = L({
      running: { zh: '正在處理', en: 'Processing' }, done: { zh: '已完成', en: 'Done' },
      error: { zh: '需要備援', en: 'Needs fallback' }, idle: { zh: '待命', en: 'Standby' },
    }[st.state]) || st.state;
    return { state: `${state} · ${L(st.label)}`, source: '', reason: '' };
  }
  if (workflowStage === 'recall') return { state: L({ zh: '回座中', en: 'Returning to seat' }), source: '', reason: L({ zh: '隊長正在集合大家。', en: 'Orchestrator is gathering everyone.' }) };
  if (latestBriefing?.assignments) {
    const a = latestBriefing.assignments.find(x => x.agent === id);
    if (a) {
      const prep = L({ run: { zh: '準備真實分析', en: 'Preparing real analysis' }, reuse: { zh: '準備拿快取', en: 'Preparing to use cache' }, skip: { zh: '準備略過', en: 'Preparing to skip' } }[a.action]) || a.action;
      return { state: L({ zh: '已分派', en: 'Assigned' }), source: prep, reason: L(a.reason) };
    }
  }
  return { state: currentPhase === 'running' ? L({ zh: '等待任務', en: 'Waiting for task' }) : L({ zh: '待命中', en: 'Standby' }), source: '', reason: '' };
}

function hideAgentTooltip() {
  const tip = document.getElementById('agent-tooltip');
  if (tip) tip.hidden = true;
}

// Small difficulty label on a jargon pill (●●●○○), coloured by level.
function difficultyTag(d) {
  const n = Math.max(0, Math.min(5, Math.round(Number(d) || 0)));
  if (!n) return '';
  const cls = n >= 4 ? 'diff-hard' : n >= 3 ? 'diff-mid' : 'diff-easy';
  return `<span class="jpill-diff ${cls}" title="${esc(L({ zh: `難度 ${n}/5`, en: `difficulty ${n}/5` }))}">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span>`;
}

function renderJargon(terms) {
  const list = document.getElementById('jargon-list');
  const note = currentResult ? sectionTrustNote('jargon') : '';
  if (!terms.length) {
    list.innerHTML = `${note}<p class="muted">${esc(L({ zh: '沒有找到術語。', en: 'No terms identified.' }))}</p>`;
    return;
  }
  list.innerHTML = note + terms.map((t, i) => {
    const known = kbHas(t.term);
    return `<div class="jpill${known ? ' known' : ''}" data-index="${i}">
      <div class="jpill-head">
        <span class="jpill-term">${esc(t.term)}</span>
        <span class="jpill-zh">${esc(t.zh_term || '')}</span>
        ${difficultyTag(t.difficulty)}
        ${known ? `<span class="jpill-tag">${esc(L(KB_KNOWN_LABEL))}</span>` : ''}
        <span class="jpill-caret">▶</span>
      </div>
      <div class="jpill-body">
        ${t.appeared_as ? `<blockquote class="term-quote">"${esc(t.appeared_as)}"</blockquote>` : ''}
        <p class="term-explain bi-en">${esc(t.explain.en)}</p>
        <p class="term-explain bi-zh">${esc(t.explain.zh)}</p>
        <button class="save-btn" data-index="${i}"${known ? ' disabled' : ''}>${known ? esc(L(SAVED_LABEL)) : esc(L(SAVE_LABEL))}</button>
      </div>
    </div>`;
  }).join('');

  // Expand/collapse — one pill open at a time.
  list.querySelectorAll('.jpill').forEach(pill => {
    pill.querySelector('.jpill-head').addEventListener('click', () => {
      const wasOpen = pill.classList.contains('open');
      list.querySelectorAll('.jpill.open').forEach(o => o.classList.remove('open'));
      if (!wasOpen) pill.classList.add('open');
    });
  });

  // Save to KB.
  list.querySelectorAll('.save-btn[data-index]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      kbAdd(terms[+btn.dataset.index]);
      btn.textContent = L(SAVED_LABEL);
      btn.disabled = true;
      btn.closest('.jpill')?.classList.add('known');
    });
  });
}

function kbHas(term) {
  const key = normalizeTermKey(term);
  return kbLoad().some(i => normalizeTermKey(i.term) === key);
}

function seenLabel(s) {
  return { article: '文章', comments: '留言', both: '兩者 both' }[s] || s;
}

function renderSummary(s) {
  if (!s) return;
  document.getElementById('summary-content').innerHTML = `
    ${sectionTrustNote('sum')}
    <div class="tldr">
      <p class="bi-zh">${esc(s.tldr.zh)}</p>
      <p class="bi-en">${esc(s.tldr.en)}</p>
    </div>
    <ul class="key-points">${(s.key_points || []).map(kp => `
      <li>
        <span class="bi-zh">${esc(kp.zh)}</span>
        <span class="bi-en">${esc(kp.en)}</span>
      </li>`).join('')}
    </ul>`;
}

function renderCommentDigest(d, itemId, flags) {
  if (!d) return;
  if (flags?.no_discussion) {
    document.getElementById('comments-content').innerHTML =
      `<p class="muted bi-zh">這篇沒有對應的 HN 討論串，所以只分析了內容本身。</p>
       <p class="muted bi-en">Not found on Hacker News — analysed the content alone, no discussion to dig into.</p>`;
    return;
  }
  const weightLabel = weight => L(WEIGHT_LABEL[weight]) || weight || L({ zh: '觀點', en: 'stance' });
  const wc = { majority: 'badge-green', 'vocal-minority': 'badge-amber', fringe: 'badge-muted' };
  const camps = (d.camps || []).filter(c => biText(c?.label) || biText(c?.stance) || c?.quote);
  const disputes = (d.disputes || []).filter(biText);
  const corrections = (d.expert_corrections || []).filter(ec => biText(ec?.correction));
  const spicy = (d.spicy || []).filter(s => s?.quote || s?.zh);
  const hnLink = (id, label) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `<a href="https://news.ycombinator.com/item?id=${n}" target="_blank" rel="noopener" class="hn-link">${esc(label || L({ zh: '看原留言', en: 'View original comment' }))} ↗</a>`;
  };
  const emptyDiscussion = !camps.length && !disputes.length && !corrections.length && !spicy.length && !biText(d.consensus);

  document.getElementById('comments-content').innerHTML = `
    ${sectionTrustNote('comments')}
    ${flags?.comments_sampled ? `<p class="trust-line">${esc(L({ zh: '只分析高訊號留言串，沒有逐字看完整留言區。', en: 'Analyzed high-signal threads only, not the full comment section verbatim.' }))}</p>` : ''}
    <p class="overview bi-zh">${esc(d.overview?.zh || '')}</p>
    <p class="overview bi-en">${esc(d.overview?.en || '')}</p>
    ${emptyDiscussion ? `<p class="muted">${esc(L({ zh: '小潛沒有抓到明確派別、爭議或可引用留言。', en: "Comments didn't surface clear camps, disputes, or quotable comments." }))}</p>` : ''}

    ${camps.length ? `<div class="digest-group">
      <strong class="small mono digest-heading">${esc(L({ zh: '主要派別', en: 'Camps' }))}</strong>
      <div class="camps">
      ${camps.map(c => `<div class="camp-card">
        <div class="camp-header">
          <span class="bi-zh camp-label">${esc(c.label?.zh || '')}</span>
          <span class="bi-en camp-label">${esc(c.label?.en || '')}</span>
          <span class="badge ${wc[c.weight] || 'badge-muted'}">${esc(weightLabel(c.weight))}</span>
        </div>
        <p class="camp-stance bi-zh">${esc(c.stance?.zh || '')}</p>
        <p class="camp-stance bi-en">${esc(c.stance?.en || '')}</p>
        ${c.quote ? `<blockquote class="camp-quote">"${esc(c.quote)}" ${hnLink(c.comment_id)}</blockquote>` : hnLink(c.comment_id)}
      </div>`).join('')}
      </div>
    </div>` : ''}

    ${biText(d.consensus) ? `<div class="consensus-block">
      <strong class="small mono">${esc(L({ zh: '共識', en: 'Consensus' }))}</strong>
      <p class="bi-zh">${esc(d.consensus?.zh || '')}</p>
      <p class="bi-en">${esc(d.consensus?.en || '')}</p>
    </div>` : ''}

    ${disputes.length ? `<div class="disputes-block">
      <strong class="small mono">${esc(L({ zh: '爭議點', en: 'Disputes' }))}</strong>
      <ul class="dispute-list">
        ${disputes.map(x => `<li>
          <span class="bi-zh">${esc(x.zh || '')}</span>
          <span class="bi-en">${esc(x.en || '')}</span>
        </li>`).join('')}
      </ul>
    </div>` : ''}

    ${corrections.length ? `<div class="corrections-block">
      <strong class="small mono red">${esc(L({ zh: '專家糾錯', en: 'Expert Corrections' }))}</strong>
      ${corrections.map(ec => `<div class="correction-card">
        <p class="bi-zh">${esc(ec.correction?.zh || '')}</p>
        <p class="bi-en">${esc(ec.correction?.en || '')}</p>
        ${hnLink(ec.comment_id)}
      </div>`).join('')}
    </div>` : ''}

    ${spicy.length ? `<div class="spicy-block">
      <strong class="small mono amber">${esc(L({ zh: '辣評', en: 'Spicy Takes' }))}</strong>
      ${spicy.map(s => `<div class="spicy-card">
        ${s.quote ? `<blockquote>"${esc(s.quote)}"</blockquote>` : ''}
        <p class="bi-zh">${esc(s.zh)}</p>
        ${hnLink(s.comment_id)}
      </div>`).join('')}
    </div>` : ''}`;
}

function biText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  return String(v.zh || v.en || '').trim();
}

function renderMetaBar(r) {
  document.getElementById('meta-bar').innerHTML = `
    <span class="mono small">${r.meta.points} pts</span>
    <span class="mono small">${r.meta.comments} comments</span>
    ${r.meta.age ? `<span class="mono small">${esc(r.meta.age)}</span>` : ''}
    <a href="https://news.ycombinator.com/item?id=${r.item_id}" target="_blank" rel="noopener" class="hn-link mono small">HN ↗</a>`;
}

// ── Ask 小詞 ───────────────────────────────────────────────────────────────
async function onAskXici() {
  const term = document.getElementById('ask-term').value.trim();
  if (!term) return;
  const btn = document.getElementById('ask-btn');
  btn.disabled = true;
  btn.textContent = L({ zh: '問中…', en: 'Asking…' });
  document.getElementById('ask-result').innerHTML = `<div class="loading">${esc(L({ zh: '小詞思考中…', en: 'Jargon is thinking…' }))}</div>`;
  try {
    const res = await fetch('/api/define', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term }),
    });
    const d = await res.json();
    const termObj = { term: d.term, zh_term: d.zh_term || d.term, explain: d.explain || { en: '', zh: '' } };
    document.getElementById('ask-result').innerHTML = `
      <div class="term-card ask-result-card">
        <div class="term-header">
          <span class="term-name mono">${esc(d.term)}</span>
          <span class="term-zh muted">${esc(d.zh_term || '')}</span>
          <button class="save-btn" id="ask-save">${esc(L(SAVE_LABEL))}</button>
        </div>
        <p class="term-explain bi-en">${esc(d.explain?.en || '')}</p>
        <p class="term-explain bi-zh">${esc(d.explain?.zh || '')}</p>
      </div>`;
    document.getElementById('ask-save')?.addEventListener('click', function() {
      kbAdd(termObj);
      this.textContent = L(SAVED_LABEL);
      this.disabled = true;
    });
  } catch (e) {
    document.getElementById('ask-result').innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = L({ zh: '問', en: 'Ask' });
  }
}

// ── Front page ─────────────────────────────────────────────────────────────
async function loadFrontPage() {
  const list = document.getElementById('frontpage-list');
  try {
    const res = await fetch('/api/frontpage');
    if (!res.ok) throw new Error('failed');
    const items = await res.json();
    list.innerHTML = items.slice(0, 6).map(item => `
      <button class="frontpage-item" data-id="${item.id}">
        <span class="fp-title">${esc(item.title)}</span>
        <span class="fp-meta mono small muted">${item.points}pts · ${item.age}</span>
      </button>`).join('');
    list.querySelectorAll('.frontpage-item').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('hn-input').value =
          `https://news.ycombinator.com/item?id=${btn.dataset.id}`;
        startAnalysis({ kind: 'id', value: btn.dataset.id });
      });
    });
  } catch {
    list.innerHTML = `<span class="muted small">${esc(L({ zh: '無法載入', en: 'Could not load' }))}</span>`;
  }
}

// ── Knowledge base (localStorage) ─────────────────────────────────────────
const KB_KEY = 'hnlens_kb_v1';
const KB_STATUS = {
  new: { label: { zh: '新詞', en: 'New' }, next: 'learning' },
  learning: { label: { zh: '複習中', en: 'Learning' }, next: 'known' },
  known: { label: { zh: '已會', en: 'Known' }, next: 'new' },
};

function kbLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(KB_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeKbItem).filter(Boolean);
  } catch {
    return [];
  }
}
function kbSave(items) {
  localStorage.setItem(KB_KEY, JSON.stringify(items.map(normalizeKbItem).filter(Boolean)));
}

function normalizeTermKey(term) {
  return String(term || '').trim().toLowerCase();
}

function normalizeKbItem(item) {
  if (!item || typeof item !== 'object') return null;
  const term = String(item.term || '').trim();
  if (!term) return null;
  const now = new Date().toISOString();
  const status = KB_STATUS[item.status] ? item.status : 'new';
  return {
    term,
    zh: String(item.zh || item.zh_term || term).trim(),
    def: String(item.def || item.explain?.zh || item.explain?.en || '').trim(),
    status,
    seen_count: Math.max(1, Number(item.seen_count) || 1),
    source_item_id: Number(item.source_item_id || 0) || 0,
    added_at: item.added_at || now,
    last_seen_at: item.last_seen_at || item.added_at || now,
  };
}

function kbAdd(term) {
  const normalized = normalizeKbItem({
    term: term?.term,
    zh: term?.zh_term || term?.zh,
    def: term?.explain?.zh || term?.explain?.en || term?.def,
    source_item_id: currentResult?.item_id ?? 0,
  });
  if (!normalized) return;

  const items = kbLoad();
  const ts = new Date().toISOString();
  const key = normalizeTermKey(normalized.term);
  const existing = items.find(i => normalizeTermKey(i.term) === key);
  if (existing) {
    existing.zh = normalized.zh || existing.zh;
    existing.def = normalized.def || existing.def;
    existing.source_item_id = normalized.source_item_id || existing.source_item_id;
    existing.seen_count = (Number(existing.seen_count) || 1) + 1;
    existing.last_seen_at = ts;
  } else {
    items.unshift({ ...normalized, added_at: ts, last_seen_at: ts });
  }
  kbSave(items);
  kbRender();
  if (window.pixelAgents) window.pixelAgents.flyBook();   // a book flies to the shelf
}

function kbRemove(term) {
  const key = normalizeTermKey(term);
  kbSave(kbLoad().filter(i => normalizeTermKey(i.term) !== key));
  kbRender();
}

function kbRender() {
  const items = kbLoad();
  const count = document.getElementById('kb-count');
  if (count) count.textContent = items.length;
  const total = document.getElementById('kb-total');
  if (total) total.textContent = String(items.length);
  if (window.pixelAgents) window.pixelAgents.setKbCount(items.length);   // shelf fills up

  const list = document.getElementById('kb-list');
  if (!list) return;
  const filtered = kbVisibleItems(items);
  const visible = document.getElementById('kb-visible');
  if (visible) visible.textContent = String(filtered.length);
  document.querySelectorAll('.kb-filter').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.filter || 'all') === kbFilter);
  });

  if (!items.length) {
    list.innerHTML = `<p class="kb-empty muted">${esc(L({ zh: '還沒有收藏。看到想記住的術語時，請小詞放進來。', en: "No saved terms yet. When you see one worth remembering, ask Jargon to add it." }))}</p>`;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<p class="kb-empty muted">${esc(L({ zh: '找不到符合條件的生詞。', en: 'No terms match your filters.' }))}</p>`;
    return;
  }
  list.innerHTML = filtered.map(item => {
    const status = KB_STATUS[item.status] || KB_STATUS.new;
    const source = item.source_item_id
      ? `<a class="kb-source" href="https://news.ycombinator.com/item?id=${item.source_item_id}" target="_blank" rel="noopener">HN #${item.source_item_id}</a>`
      : '';
    return `
    <div class="kb-item">
      <div class="kb-item-header">
        <span class="term-name mono">${esc(item.term)}</span>
        <span class="term-zh muted">${esc(item.zh)}</span>
        <button class="kb-remove" data-term="${esc(item.term)}" aria-label="Remove ${esc(item.term)}">✕</button>
      </div>
      <div class="kb-meta">
        <button class="kb-status kb-status-${esc(item.status)}" data-term="${esc(item.term)}">${esc(L(status.label))}</button>
        <span class="kb-seen">${esc(L({ zh: `出現 ${item.seen_count} 次`, en: `Seen ${item.seen_count}×` }))}</span>
        ${source}
      </div>
      <p class="kb-def small">${esc(item.def)}</p>
    </div>`;
  }).join('');

  list.querySelectorAll('.kb-remove').forEach(btn => {
    btn.addEventListener('click', () => kbRemove(btn.dataset.term));
  });
  list.querySelectorAll('.kb-status').forEach(btn => {
    btn.addEventListener('click', () => kbCycleStatus(btn.dataset.term));
  });
}

function kbVisibleItems(items) {
  const filtered = items.filter(item => {
    const matchesStatus = kbFilter === 'all' || item.status === kbFilter;
    const haystack = `${item.term} ${item.zh} ${item.def}`.toLowerCase();
    const matchesQuery = !kbQuery || haystack.includes(kbQuery);
    return matchesStatus && matchesQuery;
  });
  return filtered.sort((a, b) => {
    if (kbSort === 'frequent') {
      return (Number(b.seen_count) || 0) - (Number(a.seen_count) || 0)
        || Date.parse(b.last_seen_at || b.added_at || 0) - Date.parse(a.last_seen_at || a.added_at || 0);
    }
    if (kbSort === 'az') return a.term.localeCompare(b.term, undefined, { sensitivity: 'base' });
    return Date.parse(b.last_seen_at || b.added_at || 0) - Date.parse(a.last_seen_at || a.added_at || 0);
  });
}

function kbCycleStatus(term) {
  const key = normalizeTermKey(term);
  const items = kbLoad();
  const item = items.find(i => normalizeTermKey(i.term) === key);
  if (!item) return;
  item.status = KB_STATUS[item.status]?.next || 'new';
  kbSave(items);
  kbRender();
}

function kbExport() {
  const items = kbLoad();
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hnlens-kb-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function kbImport(event) {
  const input = event.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error('not an array');
    kbSave(mergeKbItems(kbLoad(), imported));
    kbRender();
  } catch {
    alert(L({ zh: '匯入失敗：請選擇 HN Lens 匯出的 JSON 檔。', en: 'Import failed: please choose a JSON file exported by HN Lens.' }));
  } finally {
    input.value = '';
  }
}

function mergeKbItems(existingItems, importedItems) {
  const map = new Map();
  existingItems.map(normalizeKbItem).filter(Boolean).forEach(item => {
    map.set(normalizeTermKey(item.term), item);
  });
  importedItems.map(normalizeKbItem).filter(Boolean).forEach(item => {
    const key = normalizeTermKey(item.term);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      return;
    }
    existing.zh = existing.zh || item.zh;
    existing.def = existing.def || item.def;
    existing.seen_count = Math.max(Number(existing.seen_count) || 1, Number(item.seen_count) || 1);
    existing.source_item_id = existing.source_item_id || item.source_item_id;
    existing.added_at = earlierIso(existing.added_at, item.added_at);
    existing.last_seen_at = laterIso(existing.last_seen_at, item.last_seen_at);
    existing.status = higherStatus(existing.status, item.status);
  });
  return Array.from(map.values());
}

function earlierIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function laterIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function higherStatus(a, b) {
  const rank = { new: 0, learning: 1, known: 2 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

function kbOpen() {
  kbRender();
  document.getElementById('kb-drawer').hidden = false;
  document.getElementById('kb-overlay').hidden = false;
}
function kbClose() {
  document.getElementById('kb-drawer').hidden = true;
  document.getElementById('kb-overlay').hidden = true;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.hidden = false;
}
function hideError() {
  document.getElementById('error-msg').hidden = true;
}
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
