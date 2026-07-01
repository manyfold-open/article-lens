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
  { key: 'recall', label: '集合' },
  { key: 'assign', label: '分派' },
  { key: 'analyze', label: '分析' },
  { key: 'synth', label: '整合' },
  { key: 'present', label: '簡報' },
];

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
    fpToggle.textContent = open ? '今日精選 ▴' : '今日精選 ▾';
  });

  // Edit-office mode — drag teammates into pods, set modes, disable workers.
  const editToggle = document.getElementById('edit-toggle');
  if (editToggle) editToggle.addEventListener('click', toggleEditMode);

  // Task presets — load a spec into the office (enabled+effort per worker).
  document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => onPresetClick(btn.dataset.preset));
  });
  // When the user free-tunes in edit mode (effort/mode badges, benching), keep
  // the preset highlight + meter in sync.
  if (window.pixelAgents?.setSpecChangeHandler) {
    window.pixelAgents.setSpecChangeHandler(syncPresetPicker);
  }

  // Initial office-control state
  if (window.pixelAgents) {
    window.pixelAgents.setKbCount(kbLoad().length);
    window.pixelAgents.setLang(document.documentElement.dataset.lang || 'bilingual');
    syncPresetPicker();   // reflect any restored/persisted spec on the picker
  }
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
  document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === active);
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
  btn.textContent = on ? '✓ 完成編排' : '🛠️ 編排辦公室';
  document.documentElement.dataset.editmode = on ? 'on' : 'off';
}

const LANG_CYCLE = ['zh', 'en'];   // 中 / EN only (no bilingual)
function cycleLang() {
  const cur = document.documentElement.dataset.lang || 'zh';
  const next = LANG_CYCLE[(LANG_CYCLE.indexOf(cur) + 1) % LANG_CYCLE.length];
  document.documentElement.dataset.lang = next;
  if (window.pixelAgents) window.pixelAgents.setLang(next);
  if (next !== 'zh') ensureEnglish();   // English is fetched on demand
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
  if (!input) { showError('貼個 HN 連結、文章網址，或一段文字 / Paste a HN link, an article URL, or some text'); return; }
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
  document.getElementById('progress-text').textContent = '分析中… / Analyzing…';
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
    showError('連線中斷 / Connection lost');
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
        if (pt && ev.label) pt.textContent = ev.label.zh || ev.label.en || '';
        if (window.pixelAgents && !sandboxDownAgents.has('synth')) {
          const sState = ev.state === 'running' ? 'typing' : ev.state;
          window.pixelAgents.setAgentState('synth', sState);
          if (ev.label) window.pixelAgents.setSpeechBubble('synth', ev.label.zh);
        }
        break;
      }
      updateAgentRow(ev.agent, ev.state, ev.label);
      if (ev.state === 'running') setWorkflowStage('analyze');
      if (window.pixelAgents && !sandboxDownAgents.has(ev.agent)) {
        const pxState = ev.state === 'running' ? 'typing' : ev.state;
        window.pixelAgents.setAgentState(ev.agent, pxState);
        if (ev.label) window.pixelAgents.setSpeechBubble(ev.agent, ev.label.zh);
      }
      if (ev.state === 'done') { agentsDone++; updateProgress(); }
      break;
    case 'step':
      agentStatus[ev.agent] = { state: 'running', label: ev.label };
      updateBubble(ev.agent, ev.label);
      if (window.pixelAgents && ev.label && !sandboxDownAgents.has(ev.agent)) window.pixelAgents.setSpeechBubble(ev.agent, ev.label.zh);
      break;
    case 'section':
      if (ev.data?.briefing) latestBriefing = ev.data.briefing;
      renderSection(ev.agent, ev.data);   // populate this panel as soon as it's ready
      break;
    case 'usage':
      // Per-agent token usage — accumulate into the office token meter (actual).
      if (window.pixelAgents?.addUsage) window.pixelAgents.addUsage(ev.agent, ev.tokens);
      break;
    case 'result':
      es.close();
      currentResult = ev.data;
      // Finalize the token meter from the authoritative total, if provided.
      if (ev.data?.usage && window.pixelAgents?.setUsageTotal && typeof ev.data.usage.total === 'number') {
        window.pixelAgents.setUsageTotal(ev.data.usage.total);
      }
      renderResults(ev.data);     // fill the report, but keep it hidden…
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
          sandboxDownReasons[ev.agent] = ev.message || 'sandbox/runtime 不在線';
        }
        agentStatus[ev.agent] = {
          state: 'error',
          label: sandboxDown
            ? { zh: 'sandbox 睡著了 💤', en: 'sandbox asleep 💤' }
            : { zh: '睡著了 💤', en: 'asleep 💤' },
        };
        if (window.pixelAgents) {
          window.pixelAgents.setAsleep(ev.agent, true);
          window.pixelAgents.setSpeechBubble(ev.agent, sandboxDown ? '💤 sandbox 睡著了' : '💤 睡著了');
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
  if (pct >= 100) document.getElementById('progress-text').textContent = '整合結果中… / Synthesizing…';
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
      <span class="workflow-label">${esc(s.label)}</span>
    </div>`;
  }).join('');
}

// The report is filled as soon as the result arrives, but stays hidden until
// 隊長 walks to the whiteboard to present it (pixel present handler → revealReport).
function armReport() {
  reportReady = true;
  clearTimeout(reportTimer);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { revealReport(); return; }
  reportTimer = setTimeout(revealReport, 16000);   // fallback so we never get stuck
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
  document.getElementById('agent-panel-title').textContent = info.zh;
  document.getElementById('agent-panel-role').textContent = info.en;

  const st = agentStatus[id];
  const statusEl = document.getElementById('agent-panel-status');
  if (st && st.label) statusEl.textContent = `${st.label.zh || ''} ${st.state === 'done' ? '✓' : '…'}`;
  else statusEl.textContent = currentResult ? '已完成 ✓' : '待命中 idle';

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

function agentPanelEmpty() { return '<p class="muted">這位目前沒有可顯示的產出。/ Nothing to show yet.</p>'; }

function agentPanelBody(id) {
  const r = currentResult;
  if (!r) return '<p class="muted">分析還在進行中… 完成後再點一次看完整結果。<br>Still working — click again once done.</p>';
  const trust = sectionTrustNote(id);
  switch (id) {
    case 'sum':
      return r.summary ? `${trust}<p><strong>${esc(r.summary.tldr.zh)}</strong></p>
        <ul>${(r.summary.key_points || []).map(k => `<li>${esc(k.zh)}</li>`).join('')}</ul>` : agentPanelEmpty();
    case 'jargon':
      return (r.jargon && r.jargon.length) ? `${trust}<ul>${r.jargon.map(t =>
        `<li><strong class="mono">${esc(t.term)}</strong>（${esc(t.zh_term)}）— ${esc(t.explain.zh)}</li>`).join('')}</ul>` : trust || agentPanelEmpty();
    case 'comments': {
      const cd = r.comment_digest; if (!cd) return agentPanelEmpty();
      return `${trust}<p>${esc(cd.overview.zh)}</p>
        <ul>${(cd.camps || []).map(c => `<li><strong>${esc(c.label.zh)}</strong>（${esc(c.weight)}）：${esc(c.stance.zh)}</li>`).join('')}</ul>`;
    }
    case 'ctx':
      return r.verdict ? `${trust}<p><strong>${({ high: '強烈推薦', medium: '值得一看', low: '可略過' })[r.verdict.worth_reading] || r.verdict.worth_reading}</strong>（${esc(r.verdict.tier)}）</p>
        <p>${esc(r.verdict.why_frontpage.zh)}</p>` : agentPanelEmpty();
    case 'synth':
      return (r.editor_note && r.editor_note.zh) ? `${trust}<p>📋 ${esc(r.editor_note.zh)}</p>` : `${trust}<p class="muted">已將各組輸出整合成最終結果。</p>`;
    case 'orch':
      return agentPanelCaptain(r);
    default: return agentPanelEmpty();
  }
}

function agentPanelCaptain(r) {
  const briefing = r.briefing || latestBriefing;
  const rows = (briefing?.assignments || []).map(a =>
    `<li><strong>${esc(agentLabel(a.agent))}</strong>：${esc(({ run: '開工', skip: '略過', reuse: '快取' })[a.action] || a.action)} — ${esc(a.reason?.zh || '')}</li>`
  ).join('');
  return `<p class="muted">讀題、分派任務給組員，再彙整成果。</p>
    ${briefing ? `<ul>${rows}</ul>` : ''}
    <p>術語 ${(r.jargon || []).length} 個 · 留言派別 ${((r.comment_digest || {}).camps || []).length} 組</p>`;
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
        <span class="agent-name">${esc(info.zh)}</span>
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
  if (b) b.textContent = label.zh || label.en || '';
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
  const worth = WORTH_ZH[v.worth_reading] || v.worth_reading || '';
  const tier = TIER_ZH[v.tier] || v.tier || '';
  board.dataset.worth = v.worth_reading || '';
  board.innerHTML = `
    <span class="wbv-k">隊長裁定</span>
    <span class="wbv-main">${esc(worth)}</span>
    <span class="wbv-sub">${esc(tier)}</span>
    <span class="wbv-why">${esc(v.why_frontpage?.zh || '')}</span>`;
}

const SOURCE_BADGE = {
  hn:      { label: 'HN 討論', cls: 'badge-muted' },
  article: { label: '文章',     cls: 'badge-muted' },
  text:    { label: '貼上的文字', cls: 'badge-muted' },
};

// Slim, always-visible verdict bar between the office and the panels.
function renderVerdictBar(v, source, flags) {
  const wc = { high: 'badge-green', medium: 'badge-amber', low: 'badge-red' }[v.worth_reading] || 'badge-amber';
  const wl = { high: '強烈推薦', medium: '值得一看', low: '可略過' }[v.worth_reading] || v.worth_reading;
  const tl = { '10s': '10 秒看完', '1min': '1 分鐘', deep: '深讀' }[v.tier] || v.tier;
  const sb = SOURCE_BADGE[source];
  const bar = document.getElementById('verdict-bar');
  bar.dataset.worth = v.worth_reading;
  bar.innerHTML = `
    <span class="badge ${wc}">${esc(wl)}</span>
    <span class="badge badge-muted">${esc(tl)}</span>
    ${sb ? `<span class="badge ${sb.cls}">${esc(sb.label)}</span>` : ''}
    ${flags?.low_confidence ? '<span class="badge badge-amber">低信心</span>' : ''}
    ${flags?.comments_sampled ? '<span class="badge badge-muted">留言採樣</span>' : ''}
    ${(flags?.fallback_agents || []).length ? '<span class="badge badge-amber">含備援</span>' : ''}
    <span class="vb-why">${esc(v.why_frontpage?.zh || '')}</span>`;
}

const WORTH_ZH = { high: '強烈推薦', medium: '值得一看', low: '可略過' };
const TIER_ZH  = { '10s': '10 秒看完', '1min': '1 分鐘', deep: '深讀' };

// 小導 (Context) — should I read this & why. Verdict + why only (no editor note).
function renderContext(r) {
  const v = r.verdict || {};
  document.getElementById('context-content').innerHTML = `
    ${sectionTrustNote('ctx')}
    <div class="brief-row"><span class="brief-k mono">值得讀嗎</span>
      <span class="badge badge-amber">${esc(WORTH_ZH[v.worth_reading] || v.worth_reading || '')}</span>
      <span class="badge badge-muted">${esc(TIER_ZH[v.tier] || v.tier || '')}</span></div>
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
    <div class="brief-row"><span class="brief-k mono">結論</span>
      <span class="badge badge-amber">${esc(WORTH_ZH[v.worth_reading] || v.worth_reading || '')}</span>
      <span class="badge badge-muted">${esc(TIER_ZH[v.tier] || v.tier || '')}</span></div>
    <div class="brief-row"><span class="brief-k mono">一句話</span>
      <span class="brief-v bi-zh">${esc(r.summary?.tldr?.zh || '')}</span>
      <span class="brief-v bi-en">${esc(r.summary?.tldr?.en || '')}</span></div>
    <div class="brief-row"><span class="brief-k mono">${r.source === 'hn' ? '為何上首頁' : '為什麼值得讀'}</span>
      <span class="brief-v bi-zh">${esc(v.why_frontpage?.zh || '')}</span>
      <span class="brief-v bi-en">${esc(v.why_frontpage?.en || '')}</span></div>
    ${briefing ? `<div class="captain-route">
      <strong class="small mono">隊長分派</strong>
      <p class="muted small">${esc(briefing.route?.zh || '')}</p>
      ${agentStatusTable(assignments, flags.agent_sources || {}, r)}
    </div>` : ''}
    ${trustBadges(flags)}
    <div class="brief-index mono small muted">本次產出：術語 ${nJ} 個 · 留言 ${nC} 派 · 重點 ${nK} 條</div>
    <p class="muted small">點上方各小幫手或目錄列看細節 / click a teammate or row for details</p>`;

  document.querySelectorAll('[data-jump-agent]').forEach(btn => {
    btn.addEventListener('click', () => selectAgentSection(btn.dataset.jumpAgent));
  });
}

function briefNavButton(a, source) {
  const name = { sum: '小摘', jargon: '小詞', comments: '小潛', ctx: '小導' }[a.agent] || a.agent;
  const mode = source?.mode || ({ run: 'real', skip: 'skipped', reuse: 'cache' }[a.action] || 'real');
  const action = { real: '真實分析', fallback: '備援', skipped: '略過', cache: '快取' }[mode] || mode;
  const reason = source?.reason?.zh || a.reason?.zh || '';
  return `<button class="brief-nav-btn ${esc(mode)}" data-jump-agent="${esc(a.agent)}">
    <span>${esc(name)} · ${esc(action)}</span>
    <small>${esc(reason)}</small>
  </button>`;
}

function agentStatusTable(assignments, sources, r) {
  const rows = assignments.map(a => statusRow(a.agent, sources[a.agent], a.reason?.zh || '', r)).join('');
  const synthRow = statusRow('synth', sources.synth, '整合各組產出並做品管。', r);
  return `<div class="agent-status-table">
    ${rows}${synthRow}
  </div>`;
}

function statusRow(agent, source, fallbackReason, r) {
  const mode = source?.mode || 'real';
  const labels = { real: '真實分析', cache: '快取', fallback: '備援', skipped: '略過' };
  const reason = source?.reason?.zh || fallbackReason || '等待狀態回報。';
  return `<button class="agent-status-row ${esc(mode)}" data-jump-agent="${esc(agent)}">
    <span class="agent-status-name">${esc(agentLabel(agent))}</span>
    <span class="agent-status-mode">${esc(labels[mode] || mode)}</span>
    <span class="agent-status-count">${esc(agentOutputCount(agent, r))}</span>
    <span class="agent-status-reason">${esc(reason)}</span>
  </button>`;
}

function agentOutputCount(agent, r) {
  if (agent === 'jargon') return `${(r.jargon || []).length} 詞`;
  if (agent === 'comments') return `${((r.comment_digest || {}).camps || []).length} 派`;
  if (agent === 'sum') return `${((r.summary || {}).key_points || []).length} 重點`;
  if (agent === 'ctx') return r.verdict?.tier ? (TIER_ZH[r.verdict.tier] || r.verdict.tier) : '裁定';
  if (agent === 'synth') return r.editor_note?.zh ? '有註記' : '完成';
  return '';
}

function trustBadges(flags) {
  const bits = [];
  if (flags?.comments_sampled) bits.push('留言採樣：只看高訊號串');
  if (flags?.fallback_agents?.length) bits.push(`備援內容：${flags.fallback_agents.map(agentLabel).join('、')}`);
  if (flags?.skipped_agents?.length) bits.push(`隊長略過：${flags.skipped_agents.map(agentLabel).join('、')}`);
  if (!bits.length) return '';
  return `<div class="trust-notes">${bits.map(b => `<span class="badge badge-muted">${esc(b)}</span>`).join('')}</div>`;
}

function agentLabel(id) {
  return AGENT_NAMES[id]?.zh || id;
}

function sectionTrustNote(agent) {
  const flags = currentResult?.flags || {};
  const source = flags.agent_sources?.[agent] || fallbackSource(agent, flags);
  if (!source) return '';
  const spec = {
    real: { label: '真實分析', cls: 'real' },
    cache: { label: '使用快取', cls: 'cache' },
    fallback: { label: '備援內容', cls: 'fallback' },
    skipped: { label: '隊長略過', cls: 'skipped' },
  }[source.mode] || { label: source.mode, cls: 'cache' };
  return `<div class="source-note ${esc(spec.cls)}">
    <span class="source-note-label">${esc(agentLabel(agent))} · ${esc(spec.label)}</span>
    <span class="source-note-reason">${esc(source.reason?.zh || source.reason || '')}</span>
  </div>`;
}

function fallbackSource(agent, flags) {
  if ((flags.fallback_agents || []).includes(agent)) {
    return { mode: 'fallback', reason: { zh: '這段沒有順利取得 agent 回覆，使用備援內容。' } };
  }
  if ((flags.skipped_agents || []).includes(agent)) {
    return { mode: 'skipped', reason: { zh: '隊長判斷這段不用呼叫 agent。' } };
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
    <p class="muted small">整合與品管：把四位組員的產出去蕪存菁、修跨段落不一致。</p>
    <div class="brief-index mono small">保留：術語 ${nJ} · 重點 ${nK} · 留言派別 ${nC}</div>
    ${ (en.zh || en.en) ? `
      <p class="editor-note bi-zh">📋 ${esc(en.zh)}</p>
      <p class="editor-note bi-en">📋 ${esc(en.en)}</p>`
      : '<p class="muted small">（這次沒有額外編輯註記 / no editor note）</p>'}`;
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
      <strong class="small mono">隊長分派</strong>
      <p class="muted small">${esc(briefing.route?.zh || '')}</p>
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
  const sourceLabels = { real: '真實分析', cache: '使用快取', fallback: '備援內容', skipped: '隊長略過' };
  if (sandboxDownAgents.has(id)) {
    return {
      state: 'sandbox 睡著了',
      source: source ? (sourceLabels[source.mode] || source.mode) : 'runtime 不在線',
      reason: source?.reason?.zh || sandboxDownReasons[id] || '這位 agent 的執行環境沒有 alive，所以改用備援內容。',
    };
  }
  if (source) {
    return {
      state: sourceLabels[source.mode] || source.mode,
      source: agentOutputCount(id, currentResult),
      reason: source.reason?.zh || '',
    };
  }
  if (st?.label) {
    const state = { running: '正在處理', done: '已完成', error: '需要備援', idle: '待命' }[st.state] || st.state;
    return { state: `${state} · ${st.label.zh || st.label.en || ''}`, source: '', reason: '' };
  }
  if (workflowStage === 'recall') return { state: '回座中', source: '', reason: '隊長正在集合大家。' };
  if (latestBriefing?.assignments) {
    const a = latestBriefing.assignments.find(x => x.agent === id);
    if (a) return { state: '已分派', source: ({ run: '準備真實分析', reuse: '準備拿快取', skip: '準備略過' })[a.action] || a.action, reason: a.reason?.zh || '' };
  }
  return { state: currentPhase === 'running' ? '等待任務' : '待命中', source: '', reason: '' };
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
  return `<span class="jpill-diff ${cls}" title="難度 ${n}/5 / difficulty">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span>`;
}

function renderJargon(terms) {
  const list = document.getElementById('jargon-list');
  const note = currentResult ? sectionTrustNote('jargon') : '';
  if (!terms.length) {
    list.innerHTML = `${note}<p class="muted">No terms identified.</p>`;
    return;
  }
  list.innerHTML = note + terms.map((t, i) => {
    const known = kbHas(t.term);
    return `<div class="jpill${known ? ' known' : ''}" data-index="${i}">
      <div class="jpill-head">
        <span class="jpill-term">${esc(t.term)}</span>
        <span class="jpill-zh">${esc(t.zh_term || '')}</span>
        ${difficultyTag(t.difficulty)}
        ${known ? '<span class="jpill-tag">已會</span>' : ''}
        <span class="jpill-caret">▶</span>
      </div>
      <div class="jpill-body">
        ${t.appeared_as ? `<blockquote class="term-quote">"${esc(t.appeared_as)}"</blockquote>` : ''}
        <p class="term-explain bi-en">${esc(t.explain.en)}</p>
        <p class="term-explain bi-zh">${esc(t.explain.zh)}</p>
        <button class="save-btn" data-index="${i}"${known ? ' disabled' : ''}>${known ? '✓ 已收藏' : '＋ 收藏'}</button>
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
      btn.textContent = '✓ 已收藏';
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
      '<p class="muted">這篇沒有對應的 HN 討論串，所以只分析了內容本身。<br>' +
      'Not found on Hacker News — analysed the content alone, no discussion to dig into.</p>';
    return;
  }
  const wl = { majority: '主流', 'vocal-minority': '少數派', fringe: '邊緣觀點' };
  const wc = { majority: 'badge-green', 'vocal-minority': 'badge-amber', fringe: 'badge-muted' };
  const weightLabel = weight => wl[weight] || weight || '觀點';
  const camps = (d.camps || []).filter(c => biText(c?.label) || biText(c?.stance) || c?.quote);
  const disputes = (d.disputes || []).filter(biText);
  const corrections = (d.expert_corrections || []).filter(ec => biText(ec?.correction));
  const spicy = (d.spicy || []).filter(s => s?.quote || s?.zh);
  const hnLink = (id, label = '看原留言') => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `<a href="https://news.ycombinator.com/item?id=${n}" target="_blank" rel="noopener" class="hn-link">${esc(label)} ↗</a>`;
  };
  const emptyDiscussion = !camps.length && !disputes.length && !corrections.length && !spicy.length && !biText(d.consensus);

  document.getElementById('comments-content').innerHTML = `
    ${sectionTrustNote('comments')}
    ${flags?.comments_sampled ? '<p class="trust-line">只分析高訊號留言串，沒有逐字看完整留言區。</p>' : ''}
    <p class="overview bi-zh">${esc(d.overview?.zh || '')}</p>
    <p class="overview bi-en">${esc(d.overview?.en || '')}</p>
    ${emptyDiscussion ? '<p class="muted">小潛沒有抓到明確派別、爭議或可引用留言。</p>' : ''}

    ${camps.length ? `<div class="digest-group">
      <strong class="small mono digest-heading">主要派別 Camps</strong>
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
      <strong class="small mono">共識 Consensus</strong>
      <p class="bi-zh">${esc(d.consensus?.zh || '')}</p>
      <p class="bi-en">${esc(d.consensus?.en || '')}</p>
    </div>` : ''}

    ${disputes.length ? `<div class="disputes-block">
      <strong class="small mono">爭議點 Disputes</strong>
      <ul class="dispute-list">
        ${disputes.map(x => `<li>
          <span class="bi-zh">${esc(x.zh || '')}</span>
          <span class="bi-en">${esc(x.en || '')}</span>
        </li>`).join('')}
      </ul>
    </div>` : ''}

    ${corrections.length ? `<div class="corrections-block">
      <strong class="small mono red">專家糾錯 Expert Corrections</strong>
      ${corrections.map(ec => `<div class="correction-card">
        <p class="bi-zh">${esc(ec.correction?.zh || '')}</p>
        <p class="bi-en">${esc(ec.correction?.en || '')}</p>
        ${hnLink(ec.comment_id)}
      </div>`).join('')}
    </div>` : ''}

    ${spicy.length ? `<div class="spicy-block">
      <strong class="small mono amber">辣評 Spicy Takes</strong>
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
  btn.textContent = '問中…';
  document.getElementById('ask-result').innerHTML = '<div class="loading">小詞思考中…</div>';
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
          <button class="save-btn" id="ask-save">＋ 收藏</button>
        </div>
        <p class="term-explain bi-en">${esc(d.explain?.en || '')}</p>
        <p class="term-explain bi-zh">${esc(d.explain?.zh || '')}</p>
      </div>`;
    document.getElementById('ask-save')?.addEventListener('click', function() {
      kbAdd(termObj);
      this.textContent = '✓ 已收藏';
      this.disabled = true;
    });
  } catch (e) {
    document.getElementById('ask-result').innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '問 Ask';
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
    list.innerHTML = '<span class="muted small">無法載入 / Could not load</span>';
  }
}

// ── Knowledge base (localStorage) ─────────────────────────────────────────
const KB_KEY = 'hnlens_kb_v1';
const KB_STATUS = {
  new: { label: '新詞', next: 'learning' },
  learning: { label: '複習中', next: 'known' },
  known: { label: '已會', next: 'new' },
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
    list.innerHTML = '<p class="kb-empty muted">還沒有收藏。看到想記住的術語時，請小詞放進來。</p>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<p class="kb-empty muted">找不到符合條件的生詞。</p>';
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
        <button class="kb-status kb-status-${esc(item.status)}" data-term="${esc(item.term)}">${esc(status.label)}</button>
        <span class="kb-seen">出現 ${esc(item.seen_count)} 次</span>
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
    alert('匯入失敗：請選擇 HN Lens 匯出的 JSON 檔。');
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
