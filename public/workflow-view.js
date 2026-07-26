(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkflowInspector = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  let options = {};
  let activeTab = 'graph';
  let collapsed = false;
  let lastState = null;

  const POSITIONS = {
    input: [42, 154],
    sum: [240, 34],
    jargon: [240, 154],
    comments: [240, 274],
    ctx: [480, 154],
    synth: [704, 154],
    report: [902, 154],
  };
  const NODE_WIDTH = 142;
  const NODE_HEIGHT = 76;

  function graphPositions(plan) {
    if (!plan?.escalate) return POSITIONS;
    return {
      input: [30, 154],
      sum: [205, 154],
      ctx: [405, 154],
      jargon: [600, 80],
      comments: [600, 228],
      synth: [790, 154],
      report: [932, 154],
    };
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function lang() {
    return options.getLang ? options.getLang() : 'en';
  }

  function localize(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const current = lang();
    return value[current] || value.zh || value.en || '';
  }

  function tr(zh, en) {
    return lang() === 'zh' ? zh : en;
  }

  function parseTime(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function duration(start, end) {
    const startMs = parseTime(start);
    if (!startMs) return '';
    const milliseconds = Math.max(0, (parseTime(end) || Date.now()) - startMs);
    if (milliseconds < 1000) return `${milliseconds}ms`;
    if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
    return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1000)}s`;
  }

  function stateLabel(value) {
    return ({
      pending: tr('等待', 'Pending'),
      running: tr('執行中', 'Running'),
      success: tr('成功', 'Success'),
      cache: tr('快取', 'Cache'),
      skipped: tr('略過', 'Skipped'),
      fallback: tr('備援', 'Fallback'),
      retrying: tr('重試中', 'Retrying'),
      error: tr('失敗', 'Error'),
      queued: tr('排隊中', 'Queued'),
      retry_wait: tr('等待重試', 'Retry wait'),
      done: tr('完成', 'Done'),
    })[value] || value || tr('等待', 'Pending');
  }

  function init(config) {
    options = config || {};
    const root = document.getElementById('workflow-inspector');
    if (!root) return;
    root.querySelectorAll('[data-workflow-tab]').forEach(button => {
      button.addEventListener('click', () => {
        activeTab = button.dataset.workflowTab || 'graph';
        render(lastState);
      });
    });
    root.querySelector('[data-workflow-collapse]')?.addEventListener('click', () => {
      collapsed = !collapsed;
      render(lastState);
    });
  }

  function render(state) {
    lastState = state;
    const root = document.getElementById('workflow-inspector');
    if (!root || !state) return;
    const attempt = window.WorkflowModel?.currentAttempt(state);
    root.classList.toggle('collapsed', collapsed);
    root.dataset.workflowState = state.phase || 'queued';
    const status = root.querySelector('[data-workflow-status]');
    if (status) {
      status.className = `workflow-overall status-${esc(state.phase || 'queued')}`;
      status.textContent = state.reconnecting
        ? tr('重連中…', 'Reconnecting…')
        : stateLabel(state.phase);
    }
    const attemptEl = root.querySelector('[data-workflow-attempt]');
    if (attemptEl) attemptEl.textContent = tr(
      `第 ${state.activeAttempt || 0}/${state.maxAttempts || 1} 輪`,
      `Attempt ${state.activeAttempt || 0}/${state.maxAttempts || 1}`,
    );
    const durationEl = root.querySelector('[data-workflow-duration]');
    if (durationEl) durationEl.textContent = attempt?.startedAt
      ? duration(attempt.startedAt, attempt.endedAt)
      : '—';
    const tokenEl = root.querySelector('[data-workflow-tokens]');
    if (tokenEl) tokenEl.textContent = `${attempt?.usage?.total || 0} tokens`;
    const collapseButton = root.querySelector('[data-workflow-collapse]');
    if (collapseButton) {
      collapseButton.textContent = collapsed ? tr('展開', 'Expand') : tr('收起', 'Collapse');
      collapseButton.setAttribute('aria-expanded', String(!collapsed));
    }
    const errorBanner = root.querySelector('[data-workflow-error]');
    if (errorBanner) {
      const reason = state.error || attempt?.error || '';
      errorBanner.hidden = collapsed || !reason;
      errorBanner.textContent = reason ? `${state.phase === 'error' ? tr('失敗原因', 'Failure reason') : tr('重試原因', 'Retry reason')}: ${reason}` : '';
    }
    root.querySelectorAll('[data-workflow-tab]').forEach(button => {
      const selected = button.dataset.workflowTab === activeTab;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
    });
    root.querySelectorAll('[data-workflow-view]').forEach(view => {
      view.hidden = collapsed || view.dataset.workflowView !== activeTab;
    });
    const graph = root.querySelector('[data-workflow-graph]');
    const timeline = root.querySelector('[data-workflow-timeline]');
    if (graph) graph.innerHTML = graphHtml(state, attempt);
    if (timeline) timeline.innerHTML = timelineHtml(state);
    bindAgentClicks(root);
  }

  function graphHtml(state, attempt) {
    const plan = attempt?.plan;
    if (!plan) {
      return `<div class="workflow-empty">${esc(tr('等待後端送出真實執行拓撲…', 'Waiting for the backend execution graph…'))}</div>`;
    }
    const positions = graphPositions(plan);
    const marker = `<defs>
      <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z"></path>
      </marker>
    </defs>`;
    const edgeSvg = (plan.edges || []).map(edge => {
      const from = positions[edge.from];
      const to = positions[edge.to];
      if (!from || !to) return '';
      let x1 = from[0] + NODE_WIDTH;
      let y1 = from[1] + NODE_HEIGHT / 2;
      let x2 = to[0];
      let y2 = to[1] + NODE_HEIGHT / 2;
      let d;
      if (edge.kind === 'relay' && to[0] <= from[0]) {
        x1 = from[0] + NODE_WIDTH / 2;
        y1 = from[1] + NODE_HEIGHT;
        x2 = to[0] + NODE_WIDTH / 2;
        y2 = to[1];
        const bend = Math.max(18, (y2 - y1) / 2);
        d = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
      } else {
        const bend = Math.max(24, (x2 - x1) / 2);
        d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
      }
      const decision = edge.kind === 'conditional' && attempt.escalateDecision
        ? ` · ${attempt.escalateDecision.decision}`
        : '';
      const summary = `${localize(plan.nodes.find(node => node.id === edge.from)?.label) || edge.from} → ${localize(plan.nodes.find(node => node.id === edge.to)?.label) || edge.to} · ${edge.kind}${decision}`;
      const labelX = (x1 + x2) / 2;
      const labelY = (y1 + y2) / 2 - 7;
      return `<g class="workflow-edge edge-${esc(edge.kind)}">
        <title>${esc(summary)}</title>
        <path d="${esc(d)}" marker-end="url(#wf-arrow)"></path>
        ${edge.kind !== 'dependency'
          ? `<text x="${labelX}" y="${labelY}">${esc(edge.kind === 'relay' ? tr('接力', 'relay') : (attempt.escalateDecision?.decision || tr('條件', 'condition')))}</text>`
          : ''}
      </g>`;
    }).join('');
    const nodeHtml = (plan.nodes || []).map(config => {
      const position = positions[config.id] || [0, 0];
      const node = attempt.nodes[config.id] || { state: config.enabled ? 'pending' : 'skipped', tokens: 0 };
      const calls = Object.values(attempt.calls).filter(call => call.agent === config.id).length;
      const metadata = [
        config.effort ? config.effort : '',
        config.replicas > 1 ? `×${config.replicas}` : '',
        config.debate ? tr('辯論', 'debate') : '',
      ].filter(Boolean).join(' · ');
      const metrics = [
        duration(node.startedAt, node.endedAt),
        node.tokens ? `${node.tokens}t` : '',
        calls ? tr(`${calls} 次呼叫`, `${calls} call${calls === 1 ? '' : 's'}`) : '',
      ].filter(Boolean).join(' · ');
      const clickable = config.kind === 'agent';
      return `<button type="button"
        class="workflow-node state-${esc(node.state || 'pending')} ${config.enabled ? '' : 'disabled'}"
        style="left:${position[0]}px;top:${position[1]}px"
        ${clickable ? `data-workflow-agent="${esc(config.id)}"` : 'disabled'}
        aria-label="${esc(`${localize(config.label)} · ${stateLabel(node.state)}`)}">
        <span class="workflow-node-title">${esc(localize(config.label))}</span>
        <span class="workflow-node-state">${esc(stateLabel(node.state))}</span>
        ${metadata ? `<span class="workflow-node-meta">${esc(metadata)}</span>` : ''}
        ${metrics ? `<span class="workflow-node-metrics">${esc(metrics)}</span>` : ''}
      </button>`;
    }).join('');
    const accessibleEdges = (plan.edges || []).map(edge => {
      const from = plan.nodes.find(node => node.id === edge.from);
      const to = plan.nodes.find(node => node.id === edge.to);
      return `<li>${esc(`${localize(from?.label) || edge.from} → ${localize(to?.label) || edge.to} (${edge.kind})`)}</li>`;
    }).join('');
    return `<div class="workflow-graph-canvas">
      <svg class="workflow-edges" width="1088" height="390" viewBox="0 0 1088 390" role="img" aria-label="${esc(tr('Agent 工作流依賴圖', 'Agent workflow dependency graph'))}">
        ${marker}${edgeSvg}
      </svg>
      ${nodeHtml}
      <ul class="sr-only">${accessibleEdges}</ul>
    </div>`;
  }

  function timelineHtml(state) {
    const attempts = Object.keys(state.attempts).map(Number).sort((a, b) => a - b);
    if (!attempts.length) {
      return `<div class="workflow-empty">${esc(tr('等待執行事件…', 'Waiting for execution events…'))}</div>`;
    }
    return attempts.map(number => {
      const attempt = state.attempts[number];
      const calls = Object.values(attempt.calls).sort((a, b) => parseTime(a.startedAt) - parseTime(b.startedAt));
      const times = calls.flatMap(call => [parseTime(call.startedAt), parseTime(call.endedAt) || Date.now()]).filter(Boolean);
      const start = Math.min(parseTime(attempt.startedAt) || Date.now(), ...times);
      const end = Math.max(parseTime(attempt.endedAt) || Date.now(), ...times, start + 1);
      const span = Math.max(1, end - start);
      const rows = calls.length ? calls.map(call => {
        const left = Math.max(0, ((parseTime(call.startedAt) - start) / span) * 100);
        const finish = parseTime(call.endedAt) || Date.now();
        const width = Math.max(1.5, ((finish - parseTime(call.startedAt)) / span) * 100);
        const retries = call.events.filter(event => event.phase === 'error' && event.willRetry).length;
        const errors = call.events.filter(event => event.phase === 'error' && !event.willRetry).length;
        const byTransportAttempt = {};
        for (const event of call.events) {
          const transportAttempt = Number(event.attempt) || 1;
          (byTransportAttempt[transportAttempt] ||= []).push(event);
        }
        const segments = Object.entries(byTransportAttempt).map(([transportAttempt, events]) => {
          const segmentStart = Math.min(...events.map(event => parseTime(event.at)).filter(Boolean));
          const segmentEnd = Math.max(...events.map(event => parseTime(event.at)).filter(Boolean), segmentStart + 1);
          const segmentLeft = Math.max(0, ((segmentStart - start) / span) * 100);
          const segmentWidth = Math.max(1.5, ((segmentEnd - segmentStart) / span) * 100);
          const terminal = events.find(event => event.phase === 'error' && !event.willRetry);
          const retry = events.find(event => event.phase === 'error' && event.willRetry);
          const output = events.find(event => event.phase === 'output');
          const segmentState = terminal ? 'error' : retry ? 'retrying' : output ? 'success' : 'running';
          return `<span class="workflow-timeline-segment state-${segmentState}"
            style="left:${segmentLeft.toFixed(2)}%;width:${Math.min(100 - segmentLeft, segmentWidth).toFixed(2)}%"
            title="${esc(`A2A attempt ${transportAttempt} · ${stateLabel(segmentState)}`)}">
            <span>A2A ${transportAttempt}</span>
          </span>`;
        }).join('');
        return `<button type="button" class="workflow-timeline-row" data-workflow-agent="${esc(call.agent)}"
          aria-label="${esc(`${call.agent} ${call.callId} ${stateLabel(call.state)}`)}">
          <span class="workflow-timeline-label">
            <strong>${esc(localize(options.agentNames?.[call.agent]) || call.agent)}</strong>
            <small>${esc(call.callId.slice(0, 8))}${call.transportAttempts > 1 ? ` · A2A ×${call.transportAttempts}` : ''}</small>
          </span>
          <span class="workflow-timeline-track">
            <span class="workflow-timeline-bar state-${esc(call.state)}" style="left:${left.toFixed(2)}%;width:${Math.min(100 - left, width).toFixed(2)}%"></span>
            ${segments}
            ${retries ? `<span class="workflow-timeline-badge retry">${esc(tr(`重試 ${retries}`, `${retries} retry`))}</span>` : ''}
            ${errors ? `<span class="workflow-timeline-badge error">${esc(tr('錯誤', 'error'))}</span>` : ''}
          </span>
        </button>`;
      }).join('') : `<div class="workflow-empty small">${esc(tr('本輪尚未開始 A2A 呼叫', 'No A2A calls in this attempt yet'))}</div>`;
      return `<section class="workflow-attempt">
        <header>
          <strong>${esc(tr(`第 ${number} 輪`, `Attempt ${number}`))}</strong>
          <span class="state-${esc(attempt.state)}">${esc(stateLabel(attempt.state))}</span>
          <time>${esc(duration(attempt.startedAt, attempt.endedAt) || '—')}</time>
          ${attempt.error ? `<span class="workflow-attempt-error" title="${esc(attempt.error)}">${esc(attempt.error)}</span>` : ''}
        </header>
        <div class="workflow-timeline-rows">${rows}</div>
      </section>`;
    }).join('');
  }

  function bindAgentClicks(root) {
    root.querySelectorAll('[data-workflow-agent]').forEach(button => {
      button.addEventListener('click', () => options.onSelectAgent?.(button.dataset.workflowAgent));
    });
  }

  return { init, render };
});
