'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentPhase = 'input';
let currentResult = null;
let reportReady = false;     // result has arrived; report is filled but hidden
let reportTimer = 0;         // fallback timer to reveal the report
let kbFilter = 'all';
let kbSort = 'recent';
let kbQuery = '';
let latestBriefing = null;
let workflowStage = 'idle';
let workflowState = window.WorkflowModel?.createState('') || null;
let analysisPollGeneration = 0;
let workflowRenderTimer = 0;
let workbenchCollapsed = false;
let workbenchView = 'graph';   // the console opens on the execution graph

const AGENT_NAMES = {
  orch:     'Orchestrator',
  sum:      'Summariser',
  jargon:   'Jargon',
  comments: 'Comments',
  ctx:      'Context',
  synth:    'Synthesiser',
};
const AGENT_COLORS = {
  orch: '#FF6600', sum: '#3B82F6', jargon: '#F59E0B',
  comments: '#14B8A6', ctx: '#8B5CF6', synth: '#EC4899',
};
// latest SSE label/state per agent — powers the click-to-inspect panel
const agentStatus = {};
const agentTraces = {};
const agentOutputs = {};
let openAgentId = null;
const activityEntries = [];
let activitySeq = 0;
let activityAgentFilter = 'all';
let activityKindFilter = 'all';
let activityAutoscroll = true;
let activityCollapsed = false;
let activityRenderPending = false;
const sandboxDownAgents = new Set();
const sandboxDownReasons = {};

// The page is English only. Agents are prompted in English and answer in
// English, so there is no BiStr to pick a side from, no /api/translate round
// trip, and no window where a section renders blank or half-translated.
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
// Re-render UI chrome that isn't tied to an analysis result (workflow strip,
// edit-toggle button, front-page toggle).
function refreshChrome() {
  renderWorkflowInspector();
  renderActivityLog();
  syncWorkbench();
  syncEditToggle();
  syncFpToggleLabel();
  // The glossary's status and count labels are written by JS, so without a
  // re-render they keep the language they were drawn in and the drawer ends up
  // mixing both.
  kbRender();
}

// ── Phase control ──────────────────────────────────────────────────────────
function setPhase(phase) {
  currentPhase = phase;
  document.documentElement.dataset.phase = phase;
  syncWorkbench();
}

// ── Bottom workbench ───────────────────────────────────────────────────────
// One row of tabs picks one view: Graph, Timeline, Assignments or Activity. The
// first three are rendered by WorkflowInspector inside the same panel, so the tab
// both chooses the panel and tells that module which of its views to show.
//
// Analyze is not a tab. It is the input you need before there is anything to
// inspect, so it stays open below the view; during a live run its controls remain
// visible but locked, so a second run cannot race the first.
const WORKBENCH_VIEW_PANEL = {
  graph: 'workflow', timeline: 'workflow', assignments: 'workflow', activity: 'activity',
};

function setWorkbenchView(view) {
  workbenchView = WORKBENCH_VIEW_PANEL[view] ? view : 'graph';
  syncWorkbench();
  if (WORKBENCH_VIEW_PANEL[workbenchView] === 'workflow') {
    window.WorkflowInspector?.setTab?.(workbenchView);
  }
}

function syncWorkbench() {
  const root = document.getElementById('workbench');
  if (!root) return;
  const shown = WORKBENCH_VIEW_PANEL[workbenchView] || 'workflow';
  document.querySelectorAll('[data-workbench-panel]').forEach(panel => {
    const name = panel.dataset.workbenchPanel;
    panel.hidden = name !== 'analyze' && name !== shown;
  });
  root.querySelectorAll('[data-workbench-view]').forEach(button => {
    const selected = button.dataset.workbenchView === workbenchView;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });

  const runLocked = currentPhase === 'running';
  root.classList.toggle('run-locked', runLocked);
  document.getElementById('hn-input')?.toggleAttribute('disabled', runLocked);
  document.getElementById('analyze-btn')?.toggleAttribute('disabled', runLocked);
  root.querySelectorAll('.chat-chips button').forEach(button => {
    button.toggleAttribute('disabled', runLocked);
  });
  const analyzeState = document.getElementById('analyze-panel-state');
  if (analyzeState) {
    analyzeState.textContent = runLocked
      ? 'Current run in progress'
      : currentPhase === 'results'
        ? 'Ready for the next article'
        : 'Paste a link or text to begin';
  }
  root.classList.toggle('collapsed', workbenchCollapsed);
  const collapse = document.getElementById('workbench-collapse');
  if (collapse) {
    collapse.setAttribute('aria-expanded', String(!workbenchCollapsed));
    collapse.textContent = workbenchCollapsed ? '⌃' : '⌄';
    collapse.dataset.tip = workbenchCollapsed
      ? 'Expand analysis console'
      : 'Collapse analysis console';
  }
  const context = document.getElementById('workbench-context');
  if (context) {
    context.textContent = currentPhase === 'input'
      ? 'Ready'
      : currentPhase === 'running'
        ? 'Live run · updating'
        : 'Run complete · inspect the record';
  }
}

// ── Top bar height sync ──────────────────────────────────────────────────────
// .topbar is fixed-position and grows to fit its content (preset row + audience
// row + caption can wrap to different heights). Keep --topbar-h in sync with the
// real rendered height so .pixel-stage-wrap's margin-top never overlaps it.
function syncTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  document.documentElement.style.setProperty('--topbar-h', `${bar.getBoundingClientRect().height}px`);
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const topbarEl = document.querySelector('.topbar');
  if (topbarEl && window.ResizeObserver) {
    new ResizeObserver(syncTopbarHeight).observe(topbarEl);
  }
  syncTopbarHeight();

  if (window.pixelAgents) {
    window.pixelAgents.init('pixel-stage');
    window.pixelAgents.setClickHandler(onAgentClick);
    window.pixelAgents.setHoverHandler(onAgentHover);
    window.pixelAgents.setPresentHandler(revealReport);
  }
  window.WorkflowInspector?.init({
    onSelectAgent: openAgentPanel,
    agentNames: AGENT_NAMES,
  });
  document.getElementById('agent-panel-close').addEventListener('click', closeAgentPanel);
  document.getElementById('agent-panel-overlay').addEventListener('click', closeAgentPanel);
  document.getElementById('activity-agent-filter')?.addEventListener('change', e => {
    activityAgentFilter = e.target.value;
    renderActivityLog();
  });
  document.getElementById('activity-kind-filter')?.addEventListener('change', e => {
    activityKindFilter = e.target.value;
    renderActivityLog();
  });
  document.getElementById('activity-autoscroll')?.addEventListener('change', e => {
    activityAutoscroll = Boolean(e.target.checked);
    if (activityAutoscroll) scrollActivityToBottom();
  });
  document.getElementById('activity-collapse')?.addEventListener('click', () => {
    activityCollapsed = !activityCollapsed;
    syncActivityPanel();
  });
  document.getElementById('activity-clear')?.addEventListener('click', clearActivityLog);
  document.getElementById('workbench-collapse')?.addEventListener('click', () => {
    workbenchCollapsed = !workbenchCollapsed;
    syncWorkbench();
  });
  document.querySelectorAll('[data-workbench-view]').forEach(button => {
    button.addEventListener('click', () => setWorkbenchView(button.dataset.workbenchView));
  });
  document.getElementById('access-lock')?.addEventListener('click', async () => {
    try {
      await fetch('/api/access/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } finally {
      window.location.assign('/access');
    }
  });
  document.getElementById('activity-stream')?.addEventListener('scroll', e => {
    if (!activityAutoscroll) return;
    const stream = e.currentTarget;
    if (stream.scrollHeight - stream.scrollTop - stream.clientHeight > 72) {
      activityAutoscroll = false;
      const toggle = document.getElementById('activity-autoscroll');
      if (toggle) toggle.checked = false;
    }
  });
  kbRender();
  renderWorkflowInspector();
  loadFrontPage();

  // Core actions
  document.getElementById('analyze-btn').addEventListener('click', onAnalyzeClick);
  document.getElementById('hn-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') onAnalyzeClick();
  });
  document.getElementById('back-btn').addEventListener('click', () => {
    stopAnalysisPolling();
    clearAnalysisUrl();
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

  // Whiteboard — opens Orchestrator's briefing report
  document.getElementById('wb-hit').addEventListener('click', () => onAgentClick('orch'));

  // Ask Jargon
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
  // Audience tone (reader level) — orthogonal to the depth preset; just shifts tone.
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
    syncPresetPicker();   // reflect any restored/persisted spec on the picker
    syncAudiencePicker(); // reflect the restored/persisted reader level
  }
  refreshChrome();
  const recoverId = new URLSearchParams(window.location.search).get('analysis');
  if (recoverId) recoverAnalysis(recoverId);
  workflowRenderTimer = window.setInterval(() => {
    if (currentPhase === 'running') renderWorkflowInspector();
  }, 1000);
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
        ? activeBtn.dataset.desc || ''
        : "🛠️ Custom arrangement · you've tuned this by hand, no preset matches";
    }
    caption.textContent = text;
  }
}

// ── Audience tone (reader level) ─────────────────────────────────────────────────────
// Orthogonal to the depth preset: just shifts the tone/depth of the analysis.
// Persisted in the office (localStorage), so no phase change is forced — it takes
// effect on the next run.
function onAudienceClick(level) {
  const pa = window.pixelAgents;
  if (!pa || !pa.setAudience) return;
  pa.setAudience(level);       // null | 'beginner' | 'expert'
  syncAudiencePicker();
  syncPresetPicker();          // refresh the caption (it carries the audience tag)
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
  btn.textContent = on ? '✓ Done arranging' : '🛠️ Arrange office';
  document.documentElement.dataset.editmode = on ? 'on' : 'off';
}

const TODAYS_PICKS_LABEL = "Today's Picks";
function syncFpToggleLabel() {
  const fpToggle = document.getElementById('fp-toggle');
  const sec = document.getElementById('frontpage-section');
  if (!fpToggle || !sec) return;
  const collapsed = sec.hasAttribute('hidden');
  fpToggle.textContent = `${TODAYS_PICKS_LABEL} ${collapsed ? '▾' : '▴'}`;
}

function openKbFromOffice() {
  if (window.pixelAgents?.fetchWordbook) window.pixelAgents.fetchWordbook(kbOpen);
  else kbOpen();
}

// ── Analyze flow ───────────────────────────────────────────────────────────
function onAnalyzeClick() {
  const input = document.getElementById('hn-input').value.trim();
  if (!input) { showError('Paste a HN link, an article URL, or some text'); return; }
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

function prepareAnalysisUi(input, restoring = false) {
  workbenchCollapsed = false;
  setWorkbenchView('graph');   // a new run opens on the graph, whatever was last shown
  clearActivityLog();
  appendActivity({
    agent: 'system',
    kind: restoring ? 'restore' : 'request',
    level: 'info',
    message: restoring
      ? 'Restoring the previous analysis'
      : `Analysis started · ${input.kind}`,
    detail: restoring ? String(input.analysisId || '') : String(input.value || ''),
  });
  Object.keys(agentStatus).forEach(k => delete agentStatus[k]);
  Object.keys(agentTraces).forEach(k => delete agentTraces[k]);
  Object.keys(agentOutputs).forEach(k => delete agentOutputs[k]);
  sandboxDownAgents.clear();
  Object.keys(sandboxDownReasons).forEach(k => delete sandboxDownReasons[k]);
  latestBriefing = null;
  currentResult = null;
  clearReportPanels();
  closeAgentPanel();
  reportReady = false; clearTimeout(reportTimer);
  setWorkflowStage('recall');
  if (window.pixelAgents && !restoring) window.pixelAgents.receiveTask();
  syncEditToggle();   // a run auto-exits edit mode in the sim; reflect it on the button
  setPhase('running');
}

async function startAnalysis(input) {
  stopAnalysisPolling();
  clearAnalysisUrl();
  workflowState = window.WorkflowModel?.createState('') || null;
  prepareAnalysisUi(input);
  const body = {};
  body[input.kind] = input.kind === 'text' ? input.value.slice(0, 8000) : input.value;
  // Send the user's saved terms so Jargon skips what they already know.
  const kb = kbLoad().map(i => String(i.term).replace(/,/g, ' ')).filter(Boolean).slice(0, 80);
  if (kb.length) body.kb = kb;
  // If the user has arranged the office (drag/pods/mode/disable), pass the
  // resulting graphConfig so the arrangement drives the real analysis. When the
  // layout is the default, getGraphConfig() returns null and nothing is sent.
  const cfg = window.pixelAgents?.getGraphConfig?.();
  if (cfg) body.graph = cfg;
  try {
    const response = await fetch('/api/analyses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.analysis_id) throw new Error(data.error || `HTTP ${response.status}`);
    workflowState = window.WorkflowModel?.createState(data.analysis_id) || null;
    setAnalysisUrl(data.analysis_id);
    renderWorkflowInspector();
    pollAnalysis(data.analysis_id, false);
  } catch (error) {
    appendActivity({
      agent: 'system',
      kind: 'error',
      level: 'error',
      message: 'Could not create the analysis job',
      detail: error instanceof Error ? error.message : String(error),
    });
    showError(error instanceof Error ? error.message : String(error));
    setPhase('input');
  }
}

function recoverAnalysis(analysisId) {
  stopAnalysisPolling();
  workflowState = window.WorkflowModel?.createState(analysisId) || null;
  prepareAnalysisUi({ analysisId }, true);
  pollAnalysis(analysisId, true);
}

function setAnalysisUrl(analysisId) {
  const url = new URL(window.location.href);
  url.searchParams.set('analysis', analysisId);
  history.replaceState(null, '', url);
}

function clearAnalysisUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('analysis')) return;
  url.searchParams.delete('analysis');
  history.replaceState(null, '', url);
}

function stopAnalysisPolling() {
  analysisPollGeneration++;
  if (workflowState) workflowState.reconnecting = false;
}

function pollDelay(milliseconds) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

async function pollAnalysis(analysisId, restoring) {
  const generation = ++analysisPollGeneration;
  let restorePass = restoring;
  let failures = 0;
  while (generation === analysisPollGeneration) {
    try {
      const cursor = workflowState?.cursor || 0;
      const response = await fetch(`/api/analyses/${encodeURIComponent(analysisId)}/status?after=${cursor}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (response.status === 404) {
        clearAnalysisUrl();
        setPhase('input');
        showError('This run has expired. Start a new analysis.');
        return;
      }
      if (!response.ok) throw new Error(`Status request failed (HTTP ${response.status})`);
      const snapshot = await response.json();
      failures = 0;
      if (workflowState) workflowState.reconnecting = false;
      const envelopes = Array.isArray(snapshot.events)
        ? [...snapshot.events].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
        : [];
      for (const envelope of envelopes) {
        const seq = Number(envelope.seq);
        if (workflowState?.seenSeq?.[seq]) continue;
        window.WorkflowModel?.applyEnvelope(workflowState, envelope);
        handleSSEEvent(envelope.data, { restoring: restorePass });
      }
      window.WorkflowModel?.applySnapshot(workflowState, { ...snapshot, events: [] });
      if (snapshot.result && !currentResult) {
        handleSSEEvent({ event: 'result', data: snapshot.result, at: snapshot.updated_at }, { restoring: restorePass });
      }
      renderWorkflowInspector();
      restorePass = false;
      if (snapshot.phase === 'done') {
        if (reportReady && currentPhase !== 'results') revealReport();
        return;
      }
      if (snapshot.phase === 'error') {
        showError(snapshot.error || 'Workflow failed');
        return;
      }
      await pollDelay(500);
    } catch (error) {
      if (generation !== analysisPollGeneration) return;
      failures++;
      if (workflowState) workflowState.reconnecting = true;
      renderWorkflowInspector();
      const seconds = Math.min(15, Math.max(1, 2 ** Math.min(failures - 1, 4)));
      appendActivity({
        agent: 'system',
        kind: 'reconnect',
        level: 'warn',
        message: `Reconnecting in ${seconds}s`,
        detail: error instanceof Error ? error.message : String(error),
      });
      await pollDelay(seconds * 1000);
    }
  }
}

function handleSSEEvent(ev, options = {}) {
  recordActivityEvent(ev);
  switch (ev.event) {
    case 'plan':
      setWorkflowStage('assign');
      ev.agents.forEach(a => {
        sandboxDownAgents.delete(a);
        delete sandboxDownReasons[a];
        if (window.pixelAgents && !options.restoring) window.pixelAgents.setAgentState(a, 'idle');
      });
      // Kick off the office choreography: Orchestrator walks over to assign the work.
      if (window.pixelAgents && !options.restoring) window.pixelAgents.startRun();
      break;
    case 'status':
      agentStatus[ev.agent] = { ...agentStatus[ev.agent], state: ev.state, label: ev.label };
      if (ev.state === 'running') {
        // A durable workflow retry starts a fresh attempt for this agent.
        delete agentStatus[ev.agent].error;
        delete agentStatus[ev.agent].errorKind;
      }
      pushAgentTrace(ev.agent, {
        phase: 'progress',
        label: ev.label,
        at: ev.at || new Date().toISOString(),
        call_id: 'workflow',
      });
      refreshOpenAgentPanel(ev.agent);
      // Synthesiser (Synthesizer) has a desk now, so reflect its live state in the
      // office as well as the Workflow Inspector.
      if (ev.agent === 'synth') {
        if (ev.state === 'running') setWorkflowStage('synth');
        if (window.pixelAgents && !options.restoring && !sandboxDownAgents.has('synth')) {
          const sState = ev.state === 'running' ? 'typing' : ev.state;
          window.pixelAgents.setAgentState('synth', sState);
          if (ev.label) window.pixelAgents.setSpeechBubble('synth', ev.label);
        }
        break;
      }
      if (ev.state === 'running') setWorkflowStage('analyze');
      if (window.pixelAgents && !options.restoring && !sandboxDownAgents.has(ev.agent)) {
        const pxState = ev.state === 'running' ? 'typing' : ev.state;
        window.pixelAgents.setAgentState(ev.agent, pxState);
        if (ev.label) window.pixelAgents.setSpeechBubble(ev.agent, ev.label);
      }
      break;
    case 'step':
      agentStatus[ev.agent] = { ...agentStatus[ev.agent], state: 'running', label: ev.label };
      pushAgentTrace(ev.agent, {
        phase: 'progress',
        label: ev.label,
        at: ev.at || new Date().toISOString(),
        call_id: 'workflow',
      });
      if (window.pixelAgents && !options.restoring && ev.label && !sandboxDownAgents.has(ev.agent)) window.pixelAgents.setSpeechBubble(ev.agent, ev.label);
      refreshOpenAgentPanel(ev.agent);
      break;
    case 'agent_trace':
      pushAgentTrace(ev.agent, ev);
      if (ev.phase === 'error' && ev.will_retry !== true) {
        agentStatus[ev.agent] = {
          ...agentStatus[ev.agent],
          error: ev.content || ev.label,
          errorKind: 'agent_error',
        };
      }
      refreshOpenAgentPanel(ev.agent);
      break;
    case 'section':
      if (ev.data?.briefing) {
        latestBriefing = ev.data.briefing;
        agentOutputs.orch = ev.data.briefing;
        refreshOpenAgentPanel('orch');
      } else {
        ev.data = coerceLegacySection(ev.agent, ev.data);
        agentOutputs[ev.agent] = ev.data;
      }
      renderSection(ev.agent, ev.data);   // populate this panel as soon as it's ready
      refreshOpenAgentPanel(ev.agent);
      break;
    case 'usage':
      // Per-agent token usage — accumulate into the office token meter (actual).
      if (window.pixelAgents?.addUsage) window.pixelAgents.addUsage(ev.agent, ev.tokens);
      break;
    case 'escalate':
      // 💸 Thrifty Progressive: after running sum+ctx first, the backend decides whether the
      // article is worth reading. 'go' → wake the standby candidates (jargon+comments)
      // from the dining corner into the readers zone; 'stop' → they stay asleep and
      // the run wraps with just sum+ctx→synth→Orchestrator.
      if (!options.restoring && window.pixelAgents?.escalateDecision) {
        window.pixelAgents.escalateDecision(ev.decision === 'go' ? 'go' : 'stop');
      }
      break;
    case 'retry':
      setWorkflowStage('assign');
      break;
    case 'result':
      currentResult = coerceLegacyResult(ev.data);
      // Finalize the token meter from the authoritative total, if provided.
      if (ev.data?.usage && window.pixelAgents?.setUsageTotal && typeof ev.data.usage.total === 'number') {
        window.pixelAgents.setUsageTotal(ev.data.usage.total);
      }
      renderResults(ev.data);     // fill the report, but keep it hidden…
      if (openAgentId) refreshOpenAgentPanel(openAgentId);
      setWorkflowStage('present');
      if (options.restoring) {
        reportReady = true;
        revealReport();
      } else {
        armReport();                // …until Orchestrator walks to the whiteboard to present
      }
      break;
    case 'error':
      if (ev.agent) {
        const sandboxDown = ev.kind === 'sandbox_unavailable';
        const current = agentStatus[ev.agent]?.state;
        if (sandboxDown) {
          sandboxDownAgents.add(ev.agent);
          sandboxDownReasons[ev.agent] = ev.message ? ev.message : 'sandbox/runtime offline';
        }
        agentStatus[ev.agent] = {
          ...agentStatus[ev.agent],
          error: ev.message,
          errorKind: ev.kind || 'agent_error',
          state: 'error',
          label: sandboxDown
            ? 'sandbox asleep 💤'
            : 'Agent call failed',
        };
        const alreadyTraced = (agentTraces[ev.agent] || []).some(entry =>
          entry.phase === 'error' && entry.content === ev.message
        );
        if (!alreadyTraced) {
          pushAgentTrace(ev.agent, {
            phase: 'error',
            label: sandboxDown
              ? 'Runtime unavailable'
              : 'Agent execution error',
            content: ev.message,
            at: ev.at || new Date().toISOString(),
            call_id: 'workflow-error',
          });
        }
        if (window.pixelAgents && !options.restoring && sandboxDown) {
          window.pixelAgents.setAsleep(ev.agent, true);
          window.pixelAgents.setSpeechBubble(ev.agent, '💤 sandbox asleep');
        }
        if (!options.restoring && !sandboxDown && current !== 'done' && window.pixelAgents) {
          window.pixelAgents.setAgentState(ev.agent, 'error');
          window.pixelAgents.setSpeechBubble(ev.agent, agentStatus[ev.agent].label);
        }
        refreshOpenAgentPanel(ev.agent);
      } else if (ev.kind === 'orchestration_error') {
        agentStatus.orch = {
          ...agentStatus.orch,
          state: 'error',
          label: 'Orchestration failed; using fallback',
          error: ev.message,
          errorKind: ev.kind,
        };
        pushAgentTrace('orch', {
          phase: 'error',
          label: agentStatus.orch.label,
          content: ev.message,
          at: ev.at || new Date().toISOString(),
          call_id: 'orchestration-error',
        });
        refreshOpenAgentPanel('orch');
      } else {
        // Durable workflow state decides whether the job retries or terminates.
        // Keep the Inspector visible so the exact reason remains available.
        showError(ev.message);
      }
      break;
    case 'workflow_plan':
    case 'workflow_state':
      break;
  }
  renderWorkflowInspector();
}

function setWorkflowStage(stage) {
  workflowStage = stage;
  renderWorkflowInspector();
}

function renderWorkflowInspector() {
  if (workflowState) window.WorkflowInspector?.render(workflowState);
}

// The report is filled as soon as the result arrives, but stays hidden until
// Orchestrator walks to the whiteboard to present it (pixel present handler → revealReport).
//
// Ordering guarantee: the office is the single source of truth for WHEN the
// report is revealed. The result SSE arrives when the *backend* finishes — which
// is typically well before the office finishes its choreography (readers deliver
// → Synthesiser visibly integrates → hands the report to Orchestrator → Orchestrator walks to the board).
// Revealing on result arrival (or on a short timer) is exactly the desync we are
// fixing: it flashes the report while Synthesiser still shows "Synthesising". So the ONLY normal
// reveal trigger is the pixel present handler (revealReport), fired when Orchestrator
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

// ── Global activity log ────────────────────────────────────────────────────
// This is deliberately fed from the single SSE switch above, so it observes the
// same ordered event stream as the office, Agent drawer, and final report.
function recordActivityEvent(ev) {
  const now = ev.at || new Date().toISOString();
  switch (ev.event) {
    case 'workflow_plan':
      appendActivity({
        at: now,
        agent: 'orch',
        kind: 'workflow_plan',
        level: 'info',
        message: `Execution graph ready for attempt ${ev.attempt}/${ev.max_attempts}`,
        detail: safeActivityJson({
          nodes: ev.nodes,
          edges: ev.edges,
          groups: ev.groups,
          escalate: ev.escalate,
          debate: ev.debate,
          audience: ev.audience,
        }),
        attempt: ev.attempt,
      });
      break;
    case 'workflow_state':
      appendActivity({
        at: now,
        agent: 'orch',
        kind: 'workflow_state',
        level: ev.state === 'error' ? 'error' : ev.state === 'retry_wait' ? 'warn' : ev.state === 'done' ? 'success' : 'info',
        message: `Workflow: ${ev.state}`,
        detail: ev.reason,
        attempt: ev.attempt,
      });
      break;
    case 'plan':
      {
      const agents = Array.isArray(ev.agents) ? ev.agents : [];
      appendActivity({
        at: now,
        agent: 'orch',
        kind: 'plan',
        level: 'info',
        message: `Assigned ${agents.length} agents`,
        detail: agents.join(' → '),
      });
      break;
      }
    case 'status':
      appendActivity({
        at: now,
        agent: ev.agent,
        kind: 'status',
        level: ev.state === 'error' ? 'error' : ev.state === 'done' ? 'success' : 'info',
        message: ev.label,
        detail: `state=${ev.state}`,
      });
      break;
    case 'step':
      appendActivity({
        at: now,
        agent: ev.agent,
        kind: 'step',
        level: 'info',
        message: ev.label,
      });
      break;
    case 'agent_trace':
      appendActivity({
        at: now,
        agent: ev.agent,
        kind: ev.phase,
        level: ev.phase === 'error'
          ? (ev.will_retry ? 'warn' : 'error')
          : ev.phase === 'output' ? 'success' : 'info',
        message: ev.label,
        detail: ev.content,
        callId: ev.call_id,
        attempt: ev.attempt,
        truncated: ev.truncated,
        originalChars: ev.original_chars,
      });
      break;
    case 'section': {
      const isBriefing = Boolean(ev.data?.briefing);
      appendActivity({
        at: now,
        agent: isBriefing ? 'orch' : ev.agent,
        kind: isBriefing ? 'briefing' : 'section',
        level: 'success',
        message: isBriefing
          ? 'Task briefing created'
          : 'Structured result ready',
        detail: safeActivityJson(isBriefing ? ev.data.briefing : ev.data),
      });
      break;
    }
    case 'usage':
      appendActivity({
        at: now,
        agent: ev.agent || 'system',
        kind: 'usage',
        level: 'info',
        message: ev.total !== undefined
          ? `About ${ev.total} tokens total`
          : `About ${ev.tokens} tokens`,
      });
      break;
    case 'escalate':
      appendActivity({
        at: now,
        agent: 'orch',
        kind: 'decision',
        level: ev.decision === 'go' ? 'success' : 'warn',
        message: ev.decision === 'go'
          ? 'Escalating to the full analysis'
          : 'Stopping the remaining expensive steps',
        detail: ev.reason,
      });
      break;
    case 'retry':
      appendActivity({
        at: now,
        agent: 'orch',
        kind: 'retry',
        level: 'warn',
        message: `Retrying the workflow in ${ev.delay_seconds}s (attempt ${ev.attempt}/${ev.max_attempts})`,
        detail: ev.reason,
        attempt: ev.attempt,
      });
      break;
    case 'result':
      appendActivity({
        at: now,
        agent: 'orch',
        kind: 'result',
        level: 'success',
        message: 'Analysis complete; final report ready',
      });
      break;
    case 'error':
      appendActivity({
        at: now,
        agent: ev.agent || (ev.kind === 'orchestration_error' ? 'orch' : 'system'),
        kind: 'error',
        level: 'error',
        message: ev.kind === 'sandbox_unavailable'
          ? 'Agent runtime unavailable'
          : ev.kind === 'orchestration_error'
            ? 'Orchestration failed; using fallback'
            : 'Execution error',
        detail: ev.message,
      });
      break;
    default:
      appendActivity({
        at: now,
        agent: 'system',
        kind: ev.event || 'event',
        level: 'warn',
        message: 'Unknown event',
        detail: safeActivityJson(ev),
      });
  }
}

function safeActivityJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clipActivityDetail(value, max = 10000) {
  const text = value == null ? '' : String(value);
  if (text.length <= max) return { text, clipped: false, originalChars: text.length };
  return {
    text: `${text.slice(0, max - 900)}\n\n… [activity payload truncated] …\n\n${text.slice(-800)}`,
    clipped: true,
    originalChars: text.length,
  };
}

function appendActivity(entry) {
  const clipped = clipActivityDetail(entry.detail);
  activityEntries.push({
    id: ++activitySeq,
    at: entry.at || new Date().toISOString(),
    agent: entry.agent || 'system',
    kind: entry.kind || 'event',
    level: entry.level || 'info',
    message: entry.message || 'Event',
    detail: clipped.text,
    clipped: Boolean(entry.truncated || clipped.clipped),
    originalChars: entry.originalChars || clipped.originalChars,
    callId: entry.callId,
    attempt: entry.attempt,
  });
  if (activityEntries.length > 500) activityEntries.splice(0, activityEntries.length - 500);
  document.getElementById('activity-panel')?.classList.add('has-entries');
  scheduleActivityRender();
}

function clearActivityLog() {
  activityEntries.length = 0;
  activitySeq = 0;
  const panel = document.getElementById('activity-panel');
  const stream = document.getElementById('activity-stream');
  if (panel) panel.classList.remove('has-entries');
  if (stream) stream.innerHTML = '';
  const count = document.getElementById('activity-count');
  if (count) count.textContent = '0';
  const workbenchCount = document.getElementById('workbench-activity-count');
  if (workbenchCount) {
    workbenchCount.textContent = '0';
    workbenchCount.classList.remove('has-errors');
  }
}

function scheduleActivityRender() {
  if (activityRenderPending) return;
  activityRenderPending = true;
  requestAnimationFrame(() => {
    activityRenderPending = false;
    renderActivityLog();
  });
}

function activityMatches(entry) {
  if (activityAgentFilter !== 'all' && entry.agent !== activityAgentFilter) return false;
  if (activityKindFilter === 'errors') return entry.level === 'error';
  if (activityKindFilter === 'calls') return ['input', 'progress', 'output'].includes(entry.kind);
  if (activityKindFilter === 'results') return ['output', 'section', 'result', 'briefing'].includes(entry.kind);
  if (activityKindFilter === 'workflow') {
    return ['request', 'restore', 'reconnect', 'workflow_plan', 'workflow_state', 'plan', 'status', 'step', 'usage', 'decision', 'retry'].includes(entry.kind);
  }
  return true;
}

function activityAgentLabel(agent) {
  if (agent === 'system') return 'System';
  return AGENT_NAMES[agent] || agent;
}

// The tag sits in a narrow column and renders uppercase with letter spacing, so
// the two `workflow_*` kinds have to be shortened rather than clipped. `plan` is
// already taken by the orchestrator's own event, hence `graph` for the topology.
const ACTIVITY_KIND_TAG = { workflow_state: 'state', workflow_plan: 'graph' };

function activityKindTag(kind) {
  return ACTIVITY_KIND_TAG[kind] || kind || 'event';
}

function activityTime(at) {
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

// Entries arrive in receipt order, which is not clock order: replaying a retained
// run pushes the "restoring" notice first and then events carrying their original
// timestamps, so the log used to open with a later time than the rows beneath it.
// Sort by the timestamp the row actually displays, and break ties by arrival.
function activityChronological(a, b) {
  const at = Date.parse(a.at) || 0;
  const bt = Date.parse(b.at) || 0;
  return at === bt ? a.id - b.id : at - bt;
}

function renderActivityLog() {
  const stream = document.getElementById('activity-stream');
  if (!stream) return;
  const filtered = activityEntries.filter(activityMatches).sort(activityChronological);
  stream.innerHTML = filtered.length
    ? filtered.map(activityEntryHtml).join('')
    : `<div class="activity-empty">${esc('No events match this filter yet.')}</div>`;
  document.getElementById('activity-panel')?.classList.toggle('has-entries', activityEntries.length > 0);
  const count = document.getElementById('activity-count');
  if (count) count.textContent = activityAgentFilter === 'all' && activityKindFilter === 'all'
    ? String(activityEntries.length)
    : `${filtered.length}/${activityEntries.length}`;
  const workbenchCount = document.getElementById('workbench-activity-count');
  if (workbenchCount) {
    workbenchCount.textContent = String(activityEntries.length);
    workbenchCount.classList.toggle('has-errors', activityEntries.some(entry => entry.level === 'error'));
  }
  stream.querySelectorAll('[data-activity-open-agent]').forEach(button => {
    button.addEventListener('click', () => openAgentPanel(button.dataset.activityOpenAgent));
  });
  syncActivityPanel();
  if (activityAutoscroll) scrollActivityToBottom();
}

function activityEntryHtml(entry) {
  const agent = activityAgentLabel(entry.agent);
  const clickableAgent = entry.agent !== 'system' && AGENT_NAMES[entry.agent];
  const metadata = [
    entry.attempt ? `attempt ${entry.attempt}` : '',
    entry.callId ? `call ${entry.callId.slice(0, 8)}` : '',
  ].filter(Boolean).join(' · ');
  const detail = entry.detail
    ? `<details class="activity-detail">
        <summary>${esc(`payload · ${entry.detail.length} chars${entry.clipped ? ` (from ${entry.originalChars || '?'})` : ''}`)}</summary>
        <pre>${esc(entry.detail)}</pre>
      </details>`
    : '';
  return `<article class="activity-entry level-${esc(entry.level)} kind-${esc(entry.kind)}">
    <time class="activity-time">${esc(activityTime(entry.at))}</time>
    ${clickableAgent
      ? `<button type="button" class="activity-agent" data-activity-open-agent="${esc(entry.agent)}"><span class="activity-agent-dot" style="--agent-color:${esc(AGENT_COLORS[entry.agent] || '#94A3B8')}"></span>${esc(agent)}</button>`
      : `<span class="activity-agent"><span class="activity-agent-dot" style="--agent-color:#64748B"></span>${esc(agent)}</span>`}
    <span class="activity-kind">${esc(activityKindTag(entry.kind))}</span>
    <div class="activity-message">
      <span>${esc(entry.message)}</span>
      ${metadata ? `<span class="activity-meta">${esc(metadata)}</span>` : ''}
      ${detail}
    </div>
  </article>`;
}

function scrollActivityToBottom() {
  const stream = document.getElementById('activity-stream');
  if (stream) stream.scrollTop = stream.scrollHeight;
}

function syncActivityPanel() {
  const panel = document.getElementById('activity-panel');
  const button = document.getElementById('activity-collapse');
  if (!panel || !button) return;
  panel.classList.toggle('collapsed', activityCollapsed);
  button.setAttribute('aria-expanded', String(!activityCollapsed));
  button.textContent = activityCollapsed
    ? 'Expand'
    : 'Collapse';
}

// ── Agent detail panel (click a character in the office) ────────────────────
function pushAgentTrace(id, entry) {
  if (!id || !entry) return;
  const list = agentTraces[id] || (agentTraces[id] = []);
  const normalized = {
    call_id: entry.call_id || 'workflow',
    phase: entry.phase || 'progress',
    label: entry.label || 'Processing',
    at: entry.at || new Date().toISOString(),
    attempt: entry.attempt,
    will_retry: Boolean(entry.will_retry),
    content: entry.content,
    truncated: Boolean(entry.truncated),
    original_chars: entry.original_chars,
  };
  const last = list[list.length - 1];
  const sameAsLast = last
    && last.phase === normalized.phase
    && last.label === normalized.label
    && (last.content || '') === (normalized.content || '')
    && last.call_id === normalized.call_id;
  if (!sameAsLast) list.push(normalized);
  if (list.length > 120) list.splice(0, list.length - 120);
}

function refreshOpenAgentPanel(id) {
  if (openAgentId !== id) return;
  const panel = document.getElementById('agent-panel');
  if (!panel || panel.hidden) return;
  const scrollTop = panel.scrollTop;
  document.getElementById('agent-panel-status').textContent = agentPanelStatus(id);
  document.getElementById('agent-panel-body').innerHTML = agentPanelBody(id);
  panel.scrollTop = scrollTop;
}

function agentPanelStatus(id) {
  const st = agentStatus[id];
  if (st?.state === 'error') {
    return `${'Failed'} · ${st.label || st.error || ''} ✕`;
  }
  if (st?.error && st?.state === 'done') {
    return `${st.label || 'Done'} · ${'with errors/fallback'} ⚠`;
  }
  if (st?.label) {
    const suffix = st.state === 'done' ? ' ✓' : st.state === 'running' ? ' …' : '';
    return `${st.label}${suffix}`;
  }
  if (currentResult || agentOutputs[id]) return 'Done ✓';
  return 'Waiting for input · updates appear live';
}

// The six cards each state their agent's job in one line. Read it from there
// rather than keeping a second copy of the same sentence in JS.
function agentDuty(id) {
  return document.querySelector(`.result-panel[data-agent="${id}"] .panel-duty`)?.textContent?.trim() || '';
}

function openAgentPanel(id) {
  openAgentId = id;
  const info = AGENT_NAMES[id] || id;
  document.getElementById('agent-panel-swatch').style.background = AGENT_COLORS[id] || 'var(--accent)';
  document.getElementById('agent-panel-title').textContent = info;
  // This line used to hold the name in the other language. With one language it
  // carries the agent's job instead, read from the card that already states it
  // so the copy has exactly one home.
  document.getElementById('agent-panel-role').textContent = agentDuty(id);
  document.getElementById('agent-panel-status').textContent = agentPanelStatus(id);
  document.getElementById('agent-panel-body').innerHTML = agentPanelBody(id);

  const ov = document.getElementById('agent-panel-overlay');
  const panel = document.getElementById('agent-panel');
  ov.hidden = false; panel.hidden = false;
  requestAnimationFrame(() => { ov.classList.add('open'); panel.classList.add('open'); });
}

function closeAgentPanel() {
  openAgentId = null;
  const ov = document.getElementById('agent-panel-overlay');
  const panel = document.getElementById('agent-panel');
  if (!ov || !panel) return;
  ov.classList.remove('open'); panel.classList.remove('open');
  setTimeout(() => { ov.hidden = true; panel.hidden = true; }, 200);
}

function agentPanelEmpty(message) {
  return `<p class="muted">${esc(message || 'No structured result yet. This panel updates automatically.')}</p>`;
}

function agentPanelBody(id) {
  return `${agentTracePanel(id)}${agentStructuredResult(id)}`;
}

function agentTracePanel(id) {
  const entries = agentTraces[id] || [];
  const st = agentStatus[id];
  const error = st?.error;
  const errorAlreadyListed = error && entries.some(entry => entry.phase === 'error' && entry.content === error);
  const all = errorAlreadyListed ? entries : error
    ? [...entries, {
        call_id: 'status-error',
        phase: 'error',
        label: 'Error reason',
        content: error,
        at: new Date().toISOString(),
      }]
    : entries;
  const assignment = latestBriefing?.assignments?.find(a => a.agent === id);
  let content;
  if (!all.length) {
    const note = assignment
      ? `${ASSIGN_ACTION_LABEL[assignment.action] || assignment.action} · ${assignment.reason}`
      : 'No execution events yet. New events will appear here live.';
    content = `<div class="agent-trace-empty">${esc(note)}</div>`;
  } else {
    content = all.map(agentTraceEntry).join('');
  }
  return `<section class="agent-panel-section">
    <h3>${esc('Input · execution · raw output')}</h3>
    <div class="agent-trace-list">${content}</div>
  </section>`;
}

function agentTraceEntry(entry) {
  const phaseLabel = entry.phase === 'error' && entry.will_retry
    ? 'Retry'
    : ({
    input: 'Input',
    progress: 'Progress',
    output: 'Output',
    error: 'Error',
  }[entry.phase] || entry.phase);
  let time = '';
  try {
    time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {}
  const content = typeof entry.content === 'string' ? entry.content : '';
  const detail = content
    ? `<details class="agent-trace-detail" ${entry.phase === 'input' || entry.phase === 'output' || entry.phase === 'error' ? 'open' : ''}>
        <summary>${esc(`${content.length} chars${entry.truncated ? ` (trimmed from ${entry.original_chars || '?'})` : ''}`)}</summary>
        <pre>${esc(content)}</pre>
      </details>`
    : '';
  return `<article class="agent-trace-entry ${esc(entry.phase)}${entry.will_retry ? ' retrying' : ''}">
    <div class="agent-trace-meta">
      <span class="agent-trace-phase">${esc(phaseLabel)}</span>
      ${entry.attempt ? `<span>${esc(`attempt ${entry.attempt}`)}</span>` : ''}
      <time>${esc(time)}</time>
    </div>
    <div class="agent-trace-label">${esc(entry.label)}</div>
    ${detail}
  </article>`;
}

function agentStructuredResult(id) {
  const r = currentResult;
  const trust = r ? sectionTrustNote(id) : '';
  let body = '';
  switch (id) {
    case 'sum': {
      const summary = r?.summary || agentOutputs.sum;
      body = summary ? `${trust}<p><strong>${esc(summary.tldr)}</strong></p>
        <ul>${(summary.key_points || []).map(k => `<li>${esc(k)}</li>`).join('')}</ul>` : agentPanelEmpty();
      break;
    }
    case 'jargon': {
      const jargon = r?.jargon || agentOutputs.jargon;
      body = (jargon && jargon.length) ? `${trust}<ul>${jargon.map(t =>
        `<li><strong class="mono">${esc(t.term)}</strong> — ${esc(t.explain)}</li>`).join('')}</ul>` : `${trust}${agentPanelEmpty()}`;
      break;
    }
    case 'comments': {
      const cd = r?.comment_digest || agentOutputs.comments;
      body = cd ? `${trust}<p>${esc(cd.overview)}</p>
        <ul>${(cd.camps || []).map(c => `<li><strong>${esc(c.label)}</strong> (${esc(WEIGHT_LABEL[c.weight] || c.weight)}): ${esc(c.stance)}</li>`).join('')}</ul>`
        : agentPanelEmpty();
      break;
    }
    case 'ctx': {
      const verdict = r?.verdict || agentOutputs.ctx;
      body = verdict ? `${trust}<p><strong>${esc(WORTH_LABEL[verdict.worth_reading] || verdict.worth_reading)}</strong> (${esc(TIER_LABEL[verdict.tier] || verdict.tier)})</p>
        <p>${esc(verdict.why_frontpage)}</p>` : agentPanelEmpty();
      break;
    }
    case 'synth':
      body = r
        ? (r.editor_note
            ? `${trust}<p>📋 ${esc(r.editor_note)}</p>`
            : `${trust}<p class="muted">${esc('Reviewed every section; no extra editor note was added.')}</p>`)
        : agentPanelEmpty();
      break;
    case 'orch': {
      const briefing = r?.briefing || latestBriefing || agentOutputs.orch;
      body = briefing ? agentPanelCaptain({
        jargon: r?.jargon || agentOutputs.jargon || [],
        comment_digest: r?.comment_digest || agentOutputs.comments || { camps: [] },
      }) : agentPanelEmpty();
      break;
    }
    default:
      body = agentPanelEmpty();
  }
  return `<section class="agent-panel-section agent-result-section">
    <h3>${esc('Structured result')}</h3>
    ${body}
  </section>`;
}

const ASSIGN_ACTION_LABEL = { run: 'Run', skip: 'Skip', reuse: 'Cache' };
const KB_KNOWN_LABEL = 'Known';
const SAVE_LABEL = '+ Save';
const SAVED_LABEL = '✓ Saved';

// No division-of-labour list here. That is the Workflow inspector's Assignments view and
// it appears in exactly one place; this panel is office-side, so it keeps the job
// description and the output counts.
function agentPanelCaptain(r) {
  return `<p class="muted">${esc('Reads the brief, assigns tasks to the team, then compiles the results.')}</p>
    <p>${esc(`${plural((r.jargon || []).length, 'term')} · ${plural(((r.comment_digest || {}).camps || []).length, 'camp')}`)}</p>`;
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
  renderBriefing(r);     // Orchestrator (also opened by clicking the whiteboard)
  renderAssignments(r);  // how the work was divided — Workflow inspector, not a card
  renderSynth(r);        // Synthesiser — distinct from Context
  renderMetaBar(r);
  // The reveal opens on Orchestrator's overall report: it is what the office walks to the
  // whiteboard to present, and it indexes the other five cards.
  selectAgentSection('orch');
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
  const worth = WORTH_LABEL[v.worth_reading] || v.worth_reading || '';
  const tier = TIER_LABEL[v.tier] || v.tier || '';
  board.dataset.worth = v.worth_reading || '';
  board.innerHTML = `
    <span class="wbv-k">${esc("Orchestrator's verdict")}</span>
    <span class="wbv-main">${esc(worth)}</span>
    <span class="wbv-sub">${esc(tier)}</span>
    <span class="wbv-why">${esc(v.why_frontpage)}</span>`;
}

const SOURCE_BADGE = {
  hn:      { label: 'HN Discussion', cls: 'badge-muted' },
  article: { label: 'Article',          cls: 'badge-muted' },
  text:    { label: 'Pasted Text', cls: 'badge-muted' },
};
const WORTH_LABEL = {
  // The whiteboard card is a fixed slice of the office (10.5%, about 73px of
  // content), and its longest *word* has to fit that on its own: a word wider
  // than the card cannot wrap out of trouble and gets chopped by the card's
  // overflow. `Recommended` alone needed 108px. Keep every English label here to
  // short words.
  high:   'Top Pick',
  medium: 'Worth Reading',
  low:    'Can Skip',
};
const TIER_LABEL = {
  '10s': '10-second read',
  '1min': '1-minute read',
  deep: 'Deep read',
};
const WEIGHT_LABEL = {
  majority: 'Majority',
  'vocal-minority': 'Vocal Minority',
  fringe: 'Fringe',
};

// Slim, always-visible verdict bar between the office and the panels.
function renderVerdictBar(v, source, flags) {
  const wc = { high: 'badge-green', medium: 'badge-amber', low: 'badge-red' }[v.worth_reading] || 'badge-amber';
  const wl = WORTH_LABEL[v.worth_reading] || v.worth_reading;
  const tl = TIER_LABEL[v.tier] || v.tier;
  const sb = SOURCE_BADGE[source];
  const bar = document.getElementById('verdict-bar');
  bar.dataset.worth = v.worth_reading;
  bar.innerHTML = `
    <span class="badge ${wc}">${esc(wl)}</span>
    <span class="badge badge-muted">${esc(tl)}</span>
    ${sb ? `<span class="badge ${sb.cls}">${esc(sb.label)}</span>` : ''}
    ${flags?.low_confidence ? `<span class="badge badge-amber">${esc('Low confidence')}</span>` : ''}
    ${flags?.comments_sampled ? `<span class="badge badge-muted">${esc('Comments sampled')}</span>` : ''}
    ${(flags?.fallback_agents || []).length ? `<span class="badge badge-amber">${esc('Includes fallback')}</span>` : ''}
    <span class="vb-why">${esc(v.why_frontpage)}</span>`;
}

// Context (Context) — should I read this & why. Verdict + why only (no editor note).
function renderContext(r) {
  const v = r.verdict || {};
  document.getElementById('context-content').innerHTML = `
    ${sectionTrustNote('ctx')}
    <div class="brief-row"><span class="brief-k mono">${esc('Worth reading?')}</span>
      <span class="badge badge-amber">${esc(WORTH_LABEL[v.worth_reading] || v.worth_reading || '')}</span>
      <span class="badge badge-muted">${esc(TIER_LABEL[v.tier] || v.tier || '')}</span></div>
    <p class="verdict-why">${esc(v.why_frontpage || '')}</p>`;
}

// Orchestrator (Orchestrator) — the overall report, and the first card the reveal opens.
//
// An outline, not prose: the verdict on top, then one synopsis per teammate who
// found something, each with a way into that teammate's own card. The opening
// lines are deliberately repeated from those cards, because this card doubles as
// the table of contents — a full-text version would read as one wall of text and
// leave the other five cards with nothing new to show.
//
// Nothing here describes how the work was divided up. That question belongs to
// the Workflow inspector's Assignments view (see renderAssignments).
function renderBriefing(r) {
  const v = r.verdict || {};
  const summary = r.summary || {};
  const digest = r.comment_digest || {};
  const jargon = r.jargon || [];
  const keyPoints = summary.key_points || [];
  const camps = digest.camps || [];
  const flags = r.flags || {};
  const el = document.getElementById('briefing-content');
  el.innerHTML = `
    <p class="brief-title">${esc(r.title || '')}</p>
    <div class="brief-row"><span class="brief-k mono">${esc('Verdict')}</span>
      <span class="badge badge-amber">${esc(WORTH_LABEL[v.worth_reading] || v.worth_reading || '')}</span>
      <span class="badge badge-muted">${esc(TIER_LABEL[v.tier] || v.tier || '')}</span>
      <button class="verdict-owner synopsis-who" data-agent="ctx" data-jump-agent="ctx">${esc(agentLabel('ctx'))}</button></div>
    <div class="brief-row"><span class="brief-k mono">${esc(r.source === 'hn' ? 'Why on the front page' : 'Why worth reading')}</span>
      <span class="brief-v">${esc(v.why_frontpage || '')}</span></div>
    ${synopsisBlock('sum', keyPoints.map(k => esc(k)), flags, { lead: summary.tldr })}
    ${synopsisBlock('jargon', jargon.map(jargonSynopsisLine), flags)}
    ${synopsisBlock('comments', camps.map(campSynopsisLine), flags, { lead: digest.overview, preview: 2 })}
    ${trustBadges(flags)}
    <div class="brief-index mono small muted">${esc(`This run: ${plural(jargon.length, 'term')} · ${plural(camps.length, 'camp')} · ${plural(keyPoints.length, 'key point')}`)}</div>
    <p class="muted small">${esc('Click a teammate above, or "See all" here, for the details')}</p>`;

  bindAgentJumps(el);
}

// Lines handed to synopsisBlock are already-escaped HTML, so a term can keep its
// mono styling and a camp its weight. Escape at the point of interpolation.
function jargonSynopsisLine(t) {
  return `<strong class="mono">${esc(t.term)}</strong>`;
}

function campSynopsisLine(c) {
  const label = c.label;
  if (!label) return '';   // a camp with no name is not a line worth printing
  const weight = esc(WEIGHT_LABEL[c.weight] || c.weight || '');
  return `<strong>${esc(label)}</strong> (${weight})`;
}

const SYNOPSIS_PREVIEW = 3;
const SYNOPSIS_JUMP = 'See all →';

function synopsisBlock(agent, lines, flags, opts = {}) {
  const limit = opts.preview || SYNOPSIS_PREVIEW;
  const lead = opts.lead ? `<li><strong>${esc(opts.lead)}</strong></li>` : '';
  // Drop lines a builder declined to write, so an untranslated or half-filled
  // section falls through to the empty note instead of printing blank bullets.
  const filled = lines.filter(Boolean);
  const preview = filled.slice(0, limit);
  const rest = filled.slice(limit);
  const body = (lead || preview.length)
    ? `<ul class="synopsis-lines">${lead}${preview.map(line => `<li>${line}</li>`).join('')}</ul>`
    : `<p class="synopsis-empty">${esc(synopsisEmptyNote(agent, flags))}</p>`;
  const more = rest.length
    ? `<details class="synopsis-more">
        <summary>${esc(`${rest.length} more`)}</summary>
        <ul class="synopsis-lines">${rest.map(line => `<li>${line}</li>`).join('')}</ul>
      </details>`
    : '';
  return `<div class="synopsis" data-agent="${esc(agent)}">
    <div class="synopsis-head">
      <span class="synopsis-who">${esc(agentLabel(agent))}</span>
      <button class="synopsis-jump" data-jump-agent="${esc(agent)}">${esc(SYNOPSIS_JUMP)}</button>
    </div>
    ${body}${more}
  </div>`;
}

// An empty block still keeps its teammate on the page: a missing section is part
// of the story, and saying which kind of missing it is beats a blank block.
function synopsisEmptyNote(agent, flags) {
  const source = (flags || {}).agent_sources?.[agent] || fallbackSource(agent, flags || {});
  if (source?.mode === 'skipped') return 'Not assigned this run.';
  if (source?.mode === 'fallback') return 'No result came back this run.';
  return 'Nothing to report this run.';
}

function bindAgentJumps(root) {
  root.querySelectorAll('[data-jump-agent]').forEach(btn => {
    btn.addEventListener('click', () => selectAgentSection(btn.dataset.jumpAgent));
  });
}

// Orchestrator's division of labour: who was told to run, skip or reuse, and why. It
// answers how the crew worked rather than what they found, so it lives in the
// Workflow inspector. Rendered here because the route and the per-role sources
// are app state; WorkflowInspector only owns showing and hiding the view.
function renderAssignments(r) {
  const el = document.querySelector('[data-workflow-assignments]');
  if (!el) return;
  const result = r || {};
  const briefing = result.briefing || latestBriefing;
  const assignments = briefing?.assignments || [];
  if (!briefing) {
    el.innerHTML = `<div class="workflow-empty">${esc('Waiting for the orchestrator to assign the work…')}</div>`;
    return;
  }
  // No heading and no route line. Graph and Timeline carry no in-panel title
  // either, the active tab already reads Assignments, and briefing.route is nothing but
  // this table's Assignments column serialized onto one line (see the captain plan in
  // src/crew/orchestrator.ts), in a second vocabulary that read as live state.
  el.innerHTML = agentStatusTable(assignments, result.flags || {}, result);
  bindAgentJumps(el);
}

// ASSIGN_ACTION_LABEL is the order Orchestrator gave, known the moment the briefing lands.
// MODE_LABEL is what the section turned out to be, which only exists on the
// finished result. Two facts, two vocabularies, two columns.
const MODE_LABEL = {
  real: 'Real analysis',
  fallback: 'Fallback',
  skipped: 'Skipped',
  cache: 'Cache',
};
const ASSIGN_COLUMNS = [
  'Agent',
  'Assigned',
  'Result',
  'Why',
];
// Shown wherever a fact has not arrived yet. Matches the Workflow inspector's
// placeholder for an unstarted duration.
const UNKNOWN_CELL = '—';

function agentStatusTable(assignments, flags, r) {
  const rows = assignments.map(a => statusRow(a.agent, a.action, flags, a.reason, r)).join('');
  // synth is never assigned: it always runs, so it has an outcome but no order.
  const synthRow = statusRow('synth', null, flags, 'Integrates every teammate’s output and does QA.', r);
  const head = `<div class="agent-status-head" aria-hidden="true">${
    ASSIGN_COLUMNS.map(column => `<span>${esc(column)}</span>`).join('')}</div>`;
  return `<div class="agent-status-table">
    ${head}${rows}${synthRow}
  </div>`;
}

// Order and outcome are two different facts that arrive at two different times,
// so they get two columns. One chip could only ever guess at the outcome, which
// is why mid-run every row used to claim a real analysis while the route line directly
// above it said cache. An unknown fact now says so.
function statusRow(agent, order, flags, fallbackReason, r) {
  const source = flags.agent_sources?.[agent] || fallbackSource(agent, flags);
  const outcome = source?.mode || '';
  const reason = source?.reason || fallbackReason || 'Waiting for status.';
  const orderLabel = order ? (ASSIGN_ACTION_LABEL[order] || order) : UNKNOWN_CELL;
  const outcomeLabel = outcome ? (MODE_LABEL[outcome] || outcome) : UNKNOWN_CELL;
  // A role ordered to skip will not run, so dim it now instead of waiting for a
  // report that can only say the same thing. Its outcome cell still reads unknown.
  const tone = outcome || (order === 'skip' ? 'skipped' : '');
  return `<button class="agent-status-row ${esc(tone)}" data-jump-agent="${esc(agent)}"
    aria-label="${esc([
      agentLabel(agent),
      `${ASSIGN_COLUMNS[1]} ${orderLabel}`,
      `${ASSIGN_COLUMNS[2]} ${outcomeLabel}`,
      reason,
    ].join(' · '))}">
    <span class="agent-status-name">${esc(agentLabel(agent))}</span>
    <span class="agent-status-order">${esc(orderLabel)}</span>
    <span class="agent-status-outcome">${esc(outcomeLabel)}</span>
    <span class="agent-status-reason">${esc(reason)}</span>
  </button>`;
}

function agentOutputCount(agent, r) {
  if (agent === 'jargon') return plural((r.jargon || []).length, 'term');
  if (agent === 'comments') return plural(((r.comment_digest || {}).camps || []).length, 'camp');
  if (agent === 'sum') return plural(((r.summary || {}).key_points || []).length, 'point');
  if (agent === 'ctx') return r.verdict?.tier ? (TIER_LABEL[r.verdict.tier] || r.verdict.tier) : 'Verdict';
  if (agent === 'synth') return textOf(r.editor_note) ? 'Has note' : 'Done';
  return '';
}

function trustBadges(flags) {
  const bits = [];
  if (flags?.comments_sampled) bits.push('Comments sampled: high-signal threads only');
  if (flags?.fallback_agents?.length) bits.push(`Fallback content: ${flags.fallback_agents.map(agentLabel).join(', ')}`);
  if (flags?.skipped_agents?.length) bits.push(`Orchestrator skipped: ${flags.skipped_agents.map(agentLabel).join(', ')}`);
  if (!bits.length) return '';
  return `<div class="trust-notes">${bits.map(b => `<span class="badge badge-muted">${esc(b)}</span>`).join('')}</div>`;
}

function agentLabel(id) {
  return AGENT_NAMES[id] || id;
}

function sectionTrustNote(agent) {
  const flags = currentResult?.flags || {};
  const source = flags.agent_sources?.[agent] || fallbackSource(agent, flags);
  if (!source) return '';
  const spec = {
    real: { label: 'Real analysis', cls: 'real' },
    cache: { label: 'Using cache', cls: 'cache' },
    fallback: { label: 'Fallback content', cls: 'fallback' },
    skipped: { label: 'Orchestrator skipped', cls: 'skipped' },
  }[source.mode] || { label: source.mode, cls: 'cache' };
  return `<div class="source-note ${esc(spec.cls)}">
    <span class="source-note-label">${esc(agentLabel(agent))} · ${esc(spec.label)}</span>
    <span class="source-note-reason">${esc(source.reason || (typeof source.reason === 'string' ? source.reason : ''))}</span>
  </div>`;
}

function fallbackSource(agent, flags) {
  if ((flags.fallback_agents || []).includes(agent)) {
    return { mode: 'fallback', reason: "Didn't get a reply from the agent, using fallback content." };
  }
  if ((flags.skipped_agents || []).includes(agent)) {
    return { mode: 'skipped', reason: 'Orchestrator decided this section didn’t need an agent call.' };
  }
  return null;
}

// Synthesiser (Synthesizer) — the editing record. What it cut, not what survived: the
// other four cards already are what survived, so a kept-count says nothing about
// the work this role did. Cutting is the whole job, so the cut is the report.
const EDIT_LOG_ROWS = [
  { key: 'jargon',     label: 'Jargon terms',  unit: '' },
  { key: 'key_points', label: 'Key points',    unit: '' },
  { key: 'camps',      label: 'Comment camps', unit: '' },
];

function renderSynth(r) {
  const en = r.editor_note || {};
  // Absent on results cached before the editing record existed, and whenever synth
  // fell back. Both cases fall back to the kept-counts line: an absent record is
  // not the same claim as "reviewed everything and cut nothing".
  const curation = (r.flags || {}).curation;
  const nJ = (r.jargon || []).length;
  const nC = ((r.comment_digest || {}).camps || []).length;
  const nK = ((r.summary || {}).key_points || []).length;
  const record = curation
    ? `<div class="edit-log">${EDIT_LOG_ROWS.map(row => editLogRow(row, curation[row.key])).join('')}</div>`
    : `<div class="brief-index mono small">${esc(`No editing record this run. Currently kept: ${nJ} terms · ${nK} points · ${nC} camps`)}</div>`;
  document.getElementById('synth-content').innerHTML = `
    ${sectionTrustNote('synth')}
    ${record}
    ${ en ? `
      <p class="editor-note">📋 ${esc(en)}</p>`
      : `<p class="muted small">${esc('(No additional editor notes this time)')}</p>`}`;
}

function editLogRow(row, trim) {
  const before = Math.max(0, Number(trim?.before) || 0);
  const after = Math.max(0, Number(trim?.after) || 0);
  const cut = Math.max(0, before - after);
  const unit = row.unit;
  let value;
  if (!before) {
    value = `<span class="edit-log-kept">${esc('Nothing came in')}</span>`;
  } else if (cut) {
    value = `<span class="edit-log-v">${before} → ${after}</span>
      <span class="edit-log-cut">${esc(`cut ${cut}`)}</span>`;
  } else {
    value = `<span class="edit-log-v">${after}</span>
      <span class="edit-log-kept">${esc('kept as-is')}</span>`;
  }
  return `<div class="edit-log-row">
    <span class="edit-log-k mono">${esc(row.label)}</span>
    ${value}
  </div>`;
}

// Progressive: render one section as soon as its agent finishes, and reveal the
// report so panels visibly populate while the office keeps animating.
function renderSection(agent, data) {
  if (data?.briefing) {
    renderAssignments(null);
    return;
  }
  const shouldShowProgress = currentPhase === 'results' || reportReady;
  if (agent === 'sum') renderSummary(data);
  else if (agent === 'jargon') renderJargon(Array.isArray(data) ? data : []);
  else if (agent === 'comments') renderCommentDigest(data, 0, {});
  else if (agent === 'ctx') { renderVerdictBar(data, undefined, {}); renderContextFromVerdict(data); }
  // Mid-run, open the card of whoever just finished, so the audience watches the
  // cards come alive one by one. Not Orchestrator's report: its synopsis blocks are still
  // empty this early, and it is the reveal's payoff — showing it now spends it.
  if (shouldShowProgress && !document.querySelector('.result-panel.active')) selectAgentSection(agent);
}

function renderContextFromVerdict(v) {
  document.getElementById('context-content').innerHTML = `
    <p class="verdict-why">${esc(v.why_frontpage || '')}</p>`;
}

// Which panel each teammate owns — each now has its own report.
const AGENT_SECTION = {
  orch: 'briefing-section', sum: 'summary-section', jargon: 'jargon-section',
  comments: 'comments-section', ctx: 'context-section', synth: 'synth-section',
};
let selectedAgent = 'orch';   // the reveal opens on Orchestrator's overall report

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
  openAgentPanel(id);
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
  const sourceLabels = { real: 'Real analysis', cache: 'Using cache', fallback: 'Fallback content', skipped: 'Orchestrator skipped' };
  if (sandboxDownAgents.has(id)) {
    return {
      state: 'sandbox asleep',
      source: source ? (sourceLabels[source.mode] || source.mode) : 'runtime offline',
      reason: source?.reason || sandboxDownReasons[id] || "This agent's runtime isn't alive, so fallback content was used.",
    };
  }
  if (source) {
    return {
      state: sourceLabels[source.mode] || source.mode,
      source: agentOutputCount(id, currentResult),
      reason: source.reason,
    };
  }
  if (st?.label) {
    const state = {
      running: 'Processing', done: 'Done',
      error: 'Needs fallback', idle: 'Standby',
    }[st.state] || st.state;
    return { state: `${state} · ${st.label}`, source: '', reason: '' };
  }
  if (workflowStage === 'recall') return { state: 'Returning to seat', source: '', reason: 'Orchestrator is gathering everyone.' };
  if (latestBriefing?.assignments) {
    const a = latestBriefing.assignments.find(x => x.agent === id);
    if (a) {
      const prep = { run: 'Preparing real analysis', reuse: 'Preparing to use cache', skip: 'Preparing to skip' }[a.action] || a.action;
      return { state: 'Assigned', source: prep, reason: a.reason };
    }
  }
  return { state: currentPhase === 'running' ? 'Waiting for task' : 'Standby', source: '', reason: '' };
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
  return `<span class="jpill-diff ${cls}" data-tip="${esc(`difficulty ${n}/5`)}">${'●'.repeat(n)}${'○'.repeat(5 - n)}</span>`;
}

function renderJargon(terms) {
  const list = document.getElementById('jargon-list');
  const note = currentResult ? sectionTrustNote('jargon') : '';
  if (!terms.length) {
    list.innerHTML = `${note}<p class="muted">${esc('No terms identified.')}</p>`;
    return;
  }
  list.innerHTML = note + terms.map((t, i) => {
    const known = kbHas(t.term);
    return `<div class="jpill${known ? ' known' : ''}" data-index="${i}">
      <div class="jpill-head">
        <span class="jpill-term">${esc(t.term)}</span>
        ${difficultyTag(t.difficulty)}
        ${known ? `<span class="jpill-tag">${esc(KB_KNOWN_LABEL)}</span>` : ''}
        <span class="jpill-caret">▶</span>
      </div>
      <div class="jpill-body">
        ${t.appeared_as ? `<blockquote class="term-quote">"${esc(t.appeared_as)}"</blockquote>` : ''}
        <p class="term-explain">${esc(t.explain)}</p>
        <button class="save-btn" data-index="${i}"${known ? ' disabled' : ''}>${known ? esc(SAVED_LABEL) : esc(SAVE_LABEL)}</button>
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
      btn.textContent = SAVED_LABEL;
      btn.disabled = true;
      btn.closest('.jpill')?.classList.add('known');
    });
  });
}

function kbHas(term) {
  const key = normalizeTermKey(term);
  return kbLoad().some(i => normalizeTermKey(i.term) === key);
}

function renderSummary(s) {
  if (!s) return;
  document.getElementById('summary-content').innerHTML = `
    ${sectionTrustNote('sum')}
    <div class="tldr">
      <p>${esc(s.tldr)}</p>
    </div>
    <ul class="key-points">${(s.key_points || []).map(kp => `
      <li>
        <span>${esc(kp)}</span>
      </li>`).join('')}
    </ul>`;
}

function renderCommentDigest(d, itemId, flags) {
  if (!d) return;
  if (flags?.no_discussion) {
    document.getElementById('comments-content').innerHTML =
      `<p class="muted">Not found on Hacker News — analysed the content alone, no discussion to dig into.</p>`;
    return;
  }
  const weightLabel = weight => WEIGHT_LABEL[weight] || weight || 'stance';
  const wc = { majority: 'badge-green', 'vocal-minority': 'badge-amber', fringe: 'badge-muted' };
  const camps = (d.camps || []).filter(c => textOf(c?.label) || textOf(c?.stance) || c?.quote);
  const disputes = (d.disputes || []).filter(textOf);
  const corrections = (d.expert_corrections || []).filter(ec => textOf(ec?.correction));
  const spicy = (d.spicy || []).filter(s => s?.quote || s?.note);
  const hnLink = (id, label) => {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return '';
    return `<a href="https://news.ycombinator.com/item?id=${n}" target="_blank" rel="noopener" class="hn-link">${esc(label || 'View original comment')} ↗</a>`;
  };
  const emptyDiscussion = !camps.length && !disputes.length && !corrections.length && !spicy.length && !textOf(d.consensus);

  const el = document.getElementById('comments-content');
  el.innerHTML = `
    ${sectionTrustNote('comments')}
    ${flags?.comments_sampled ? `<p class="trust-line">${esc('Analysed high-signal threads only, not the full comment section verbatim.')}</p>` : ''}
    <p class="overview">${esc(d.overview || '')}</p>
    ${emptyDiscussion ? `<p class="muted">${esc("Comments didn't surface clear camps, disputes, or quotable comments.")}</p>` : ''}

    ${camps.length ? `<div class="digest-group">
      <strong class="small mono digest-heading">${esc(`Camps · ${camps.length}`)}</strong>
      <div class="camp-deck">
      ${camps.map((c, i) => `<details class="camp-item"${i === 0 ? ' open' : ''}>
        <summary>
          <span class="camp-label">${esc(c.label || '')}</span>
          <span class="badge ${wc[c.weight] || 'badge-muted'}">${esc(weightLabel(c.weight))}</span>
          <span class="camp-peek">${esc(c.stance || '')}</span>
        </summary>
        <div class="camp-body">
          <p class="camp-stance">${esc(c.stance || '')}</p>
          ${c.quote ? `<blockquote class="camp-quote">"${esc(c.quote)}" ${hnLink(c.comment_id)}</blockquote>` : hnLink(c.comment_id)}
        </div>
      </details>`).join('')}
      </div>
    </div>` : ''}

    ${textOf(d.consensus) ? `<p class="consensus-line">
      <span class="digest-k">${esc('Consensus')}</span>
      <span>${esc(d.consensus || '')}</span>
    </p>` : ''}

    ${digestFold('Disputes', disputes.map(x => `
      <span>${esc(x || '')}</span>`))}

    ${digestFold('Expert Corrections', corrections.map(ec => `
      <span>${esc(ec.correction || '')}</span>
      ${hnLink(ec.comment_id)}`))}

    ${digestFold('Spicy Takes', spicy.map(s => `
      ${s.quote ? `<blockquote>"${esc(s.quote)}"</blockquote>` : ''}
      <span>${esc(s.note || '')}</span>
      ${hnLink(s.comment_id)}`))}`;

  bindCampDeck(el);
}

// Disputes, corrections and spicy takes were four tinted full-width blocks with
// one card per item, and together they cost more height than the camps and the
// overview put together. Each is now one row. The count on the label is the part
// that matters: a collapsed row that only says Disputes reads as an empty section,
// while Disputes 2 says there is something behind it. Items arrive as already-escaped
// HTML, the same contract synopsisBlock uses.
function digestFold(label, items) {
  const filled = items.filter(html => html && html.trim());
  if (!filled.length) return '';
  return `<details class="digest-fold">
    <summary>${esc(label)}<span class="digest-fold-n">${filled.length}</span></summary>
    <div class="digest-fold-body">
      ${filled.map(html => `<div class="digest-item">${html}</div>`).join('')}
    </div>
  </details>`;
}

// One camp open at a time, so the card keeps a predictable height while a reader
// clicks through the deck. `<details name="…">` does this natively but is too
// recent to depend on, and closing a sibling re-enters this handler with
// `open === false`, which returns before it can cascade.
function bindCampDeck(root) {
  const deck = root.querySelector('.camp-deck');
  if (!deck) return;
  const items = [...deck.querySelectorAll('.camp-item')];
  items.forEach(item => item.addEventListener('toggle', () => {
    if (!item.open) return;
    items.forEach(other => { if (other !== item) other.open = false; });
  }));
}

// Sections are plain strings now. A result retained by a durable job from before
// this change still carries the old {zh, en} shape for up to 24 hours, so accept
// it and take whichever side has text rather than printing "[object Object]".
function textOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  return String(v.en || v.zh || '').trim();
}

// A result written before the language collapse holds {en, zh} objects where the
// renderers interpolate a string, so an uncoerced one reaches the reader as the
// literal "[object Object]". The Worker coerces what it reads from its cache, but
// the browser cannot assume the Worker wrote what it is being handed: a Durable
// Object retains a result for 24 hours and replays it verbatim on reload.
//
// An explicit field walk, not a deep traversal — `quote`, `appeared_as` and
// `comment_id` have to survive untouched.
function coerceLegacyResult(r) {
  if (!r || typeof r !== 'object') return r;
  r.title = textOf(r.title);
  if (r.editor_note !== undefined) r.editor_note = textOf(r.editor_note);
  if (r.verdict) r.verdict.why_frontpage = textOf(r.verdict.why_frontpage);
  if (r.summary) coerceLegacySummary(r.summary);
  if (Array.isArray(r.jargon)) r.jargon = coerceLegacyJargon(r.jargon);
  if (r.comment_digest) coerceLegacyDigest(r.comment_digest);
  if (r.briefing) {
    r.briefing.route = textOf(r.briefing.route);
    r.briefing.assignments = (r.briefing.assignments || [])
      .map(a => ({ ...a, reason: textOf(a.reason) }));
  }
  const sources = r.flags?.agent_sources;
  if (sources) {
    for (const key of Object.keys(sources)) {
      if (sources[key]) sources[key].reason = textOf(sources[key].reason);
    }
  }
  return r;
}

function coerceLegacySummary(s) {
  if (!s || typeof s !== 'object') return s;
  s.tldr = textOf(s.tldr);
  s.key_points = (s.key_points || []).map(textOf).filter(Boolean);
  return s;
}

function coerceLegacyJargon(terms) {
  if (!Array.isArray(terms)) return terms;
  return terms.map(t => ({ ...t, explain: textOf(t.explain) }));
}

function coerceLegacyDigest(d) {
  if (!d || typeof d !== 'object') return d;
  d.overview = textOf(d.overview);
  d.consensus = textOf(d.consensus);
  d.camps = (d.camps || []).map(c => ({ ...c, label: textOf(c.label), stance: textOf(c.stance) }));
  d.disputes = (d.disputes || []).map(textOf).filter(Boolean);
  d.expert_corrections = (d.expert_corrections || [])
    .map(e => ({ ...e, correction: textOf(e.correction) }));
  // `note` was named `zh` while the remark was written in Chinese.
  d.spicy = (d.spicy || []).map(x => ({ ...x, note: textOf(x.note ?? x.zh) }));
  return d;
}

// A section arrives on its own before the result does, so it needs the same
// treatment; which coercion applies depends on whose section it is.
function coerceLegacySection(agent, data) {
  if (agent === 'sum') return coerceLegacySummary(data);
  if (agent === 'jargon') return coerceLegacyJargon(data);
  if (agent === 'comments') return coerceLegacyDigest(data);
  if (agent === 'ctx' && data && typeof data === 'object') {
    data.why_frontpage = textOf(data.why_frontpage);
    return data;
  }
  return data;
}

function renderMetaBar(r) {
  document.getElementById('meta-bar').innerHTML = `
    <span class="mono small">${r.meta.points} pts</span>
    <span class="mono small">${r.meta.comments} comments</span>
    ${r.meta.age ? `<span class="mono small">${esc(r.meta.age)}</span>` : ''}
    <a href="https://news.ycombinator.com/item?id=${r.item_id}" target="_blank" rel="noopener" class="hn-link mono small">HN ↗</a>`;
}

// ── Ask Jargon ───────────────────────────────────────────────────────────────
async function onAskXici() {
  const term = document.getElementById('ask-term').value.trim();
  if (!term) return;
  const btn = document.getElementById('ask-btn');
  btn.disabled = true;
  btn.textContent = 'Asking…';
  document.getElementById('ask-result').innerHTML = `<div class="loading">${esc('Jargon is thinking…')}</div>`;
  try {
    const res = await fetch('/api/define', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term }),
    });
    const d = await res.json();
    const termObj = { term: d.term, explain: d.explain || '' };
    document.getElementById('ask-result').innerHTML = `
      <div class="term-card ask-result-card">
        <div class="term-header">
          <span class="term-name mono">${esc(d.term)}</span>
          <button class="save-btn" id="ask-save">${esc(SAVE_LABEL)}</button>
        </div>
        <p class="term-explain">${esc(d.explain || '')}</p>
      </div>`;
    document.getElementById('ask-save')?.addEventListener('click', function() {
      kbAdd(termObj);
      this.textContent = SAVED_LABEL;
      this.disabled = true;
    });
  } catch (e) {
    document.getElementById('ask-result').innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ask';
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
    list.innerHTML = `<span class="muted small">${esc('Could not load')}</span>`;
  }
}

// ── Knowledge base (localStorage) ─────────────────────────────────────────
const KB_KEY = 'hnlens_kb_v1';
const KB_STATUS = {
  new: { label: 'New', next: 'learning' },
  learning: { label: 'Learning', next: 'known' },
  known: { label: 'Known', next: 'new' },
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
    // One definition now. An entry saved by an older build carries the English
    // one in `def_en` and a Chinese one in `def`, so prefer `def_en` and fall
    // back to `def` — a reader keeps the terms they already saved either way.
    def: String(item.def_en || item.explain || item.def || '').trim(),
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
    def: term?.explain || term?.def_en || term?.def,
    source_item_id: currentResult?.item_id ?? 0,
  });
  if (!normalized) return;

  const items = kbLoad();
  const ts = new Date().toISOString();
  const key = normalizeTermKey(normalized.term);
  const existing = items.find(i => normalizeTermKey(i.term) === key);
  if (existing) {
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
    list.innerHTML = `<p class="kb-empty muted">${esc("No saved terms yet. When you see one worth remembering, ask Jargon to add it.")}</p>`;
    return;
  }
  if (!filtered.length) {
    list.innerHTML = `<p class="kb-empty muted">${esc('No terms match your filters.')}</p>`;
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
        <button class="kb-remove" data-term="${esc(item.term)}" aria-label="Remove ${esc(item.term)}">✕</button>
      </div>
      <div class="kb-meta">
        <button class="kb-status kb-status-${esc(item.status)}" data-term="${esc(item.term)}">${esc(status.label)}</button>
        <span class="kb-seen">${esc(`Seen ${item.seen_count}×`)}</span>
        ${source}
      </div>
      <p class="kb-def small">${esc(item.def || '')}</p>
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
    const haystack = `${item.term} ${item.def}`.toLowerCase();
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
    kbNotice('Import failed: please choose a JSON file exported by HN Lens.');
  } finally {
    input.value = '';
  }
}

// In-drawer notice. This used to be alert(), an OS dialog that steals focus and
// looks nothing like the rest of the page.
let kbNoticeTimer = 0;
function kbNotice(message) {
  const el = document.getElementById('kb-notice');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(kbNoticeTimer);
  kbNoticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
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
