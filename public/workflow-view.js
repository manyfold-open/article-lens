(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkflowInspector = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  let options = {};
  let activeTab = 'graph';
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
      pending: 'Pending',
      running: 'Running',
      success: 'Success',
      cache: 'Cache',
      skipped: 'Skipped',
      fallback: 'Fallback',
      retrying: 'Retrying',
      error: 'Error',
      queued: 'Queued',
      retry_wait: 'Retry wait',
      done: 'Done',
    })[value] || value || 'Pending';
  }

  function init(config) {
    options = config || {};
  }

  // Which view is showing is chosen by the workbench tab row, which also owns the
  // one collapse control, so this module no longer binds either itself.
  function setTab(tab) {
    activeTab = tab || 'graph';
    render(lastState);
  }

  function render(state) {
    lastState = state;
    const root = document.getElementById('workflow-inspector');
    if (!root || !state) return;
    const attempt = window.WorkflowModel?.currentAttempt(state);
    root.dataset.workflowState = state.phase || 'queued';
    const status = root.querySelector('[data-workflow-status]');
    if (status) {
      status.className = `workflow-overall status-${esc(state.phase || 'queued')}`;
      status.textContent = state.reconnecting
        ? 'Reconnecting…'
        : stateLabel(state.phase);
    }
    const attemptEl = root.querySelector('[data-workflow-attempt]');
    if (attemptEl) attemptEl.textContent = `Attempt ${state.activeAttempt || 0}/${state.maxAttempts || 1}`;
    const durationEl = root.querySelector('[data-workflow-duration]');
    if (durationEl) durationEl.textContent = attempt?.startedAt
      ? duration(attempt.startedAt, attempt.endedAt)
      : '—';
    const tokenEl = root.querySelector('[data-workflow-tokens]');
    const tokenTotal = attempt?.usage?.total || 0;
    if (tokenEl) tokenEl.textContent = `${tokenTotal} tokens`;
    const errorBanner = root.querySelector('[data-workflow-error]');
    if (errorBanner) {
      const reason = state.error || attempt?.error || '';
      errorBanner.hidden = !reason;
      errorBanner.textContent = reason ? `${state.phase === 'error' ? 'Failure reason' : 'Retry reason'}: ${reason}` : '';
    }
    root.querySelectorAll('[data-workflow-view]').forEach(view => {
      view.hidden = view.dataset.workflowView !== activeTab;
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
      return `<div class="workflow-empty">${esc('Waiting for the backend execution graph…')}</div>`;
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
      const summary = `${plan.nodes.find(node => node.id === edge.from)?.label || edge.from} → ${plan.nodes.find(node => node.id === edge.to)?.label || edge.to} · ${edge.kind}${decision}`;
      const labelX = (x1 + x2) / 2;
      const labelY = (y1 + y2) / 2 - 7;
      return `<g class="workflow-edge edge-${esc(edge.kind)}" data-tip="${esc(summary)}">
        <path d="${esc(d)}" marker-end="url(#wf-arrow)"></path>
        ${edge.kind !== 'dependency'
          ? `<text x="${labelX}" y="${labelY}">${esc(edge.kind === 'relay' ? 'relay' : (attempt.escalateDecision?.decision || 'condition'))}</text>`
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
        config.debate ? 'debate' : '',
      ].filter(Boolean).join(' · ');
      const metrics = [
        duration(node.startedAt, node.endedAt),
        node.tokens ? `${node.tokens}t` : '',
        calls ? `${calls} call${calls === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ');
      const clickable = config.kind === 'agent';
      return `<button type="button"
        class="workflow-node state-${esc(node.state || 'pending')} ${config.enabled ? '' : 'disabled'}"
        style="left:${position[0]}px;top:${position[1]}px"
        ${clickable ? `data-workflow-agent="${esc(config.id)}"` : 'disabled'}
        aria-label="${esc(`${config.label} · ${stateLabel(node.state)}`)}">
        <span class="workflow-node-title">${esc(config.label)}</span>
        <span class="workflow-node-state">${esc(stateLabel(node.state))}</span>
        ${metadata ? `<span class="workflow-node-meta">${esc(metadata)}</span>` : ''}
        ${metrics ? `<span class="workflow-node-metrics">${esc(metrics)}</span>` : ''}
      </button>`;
    }).join('');
    const accessibleEdges = (plan.edges || []).map(edge => {
      const from = plan.nodes.find(node => node.id === edge.from);
      const to = plan.nodes.find(node => node.id === edge.to);
      return `<li>${esc(`${from?.label || edge.from} → ${to?.label || edge.to} (${edge.kind})`)}</li>`;
    }).join('');
    return `<div class="workflow-graph-canvas">
      <svg class="workflow-edges" width="1088" height="390" viewBox="0 0 1088 390" role="img" aria-label="${esc('Agent workflow dependency graph')}">
        ${marker}${edgeSvg}
      </svg>
      ${nodeHtml}
      <ul class="sr-only">${accessibleEdges}</ul>
    </div>`;
  }

  function timelineHtml(state) {
    const attempts = Object.keys(state.attempts).map(Number).sort((a, b) => a - b);
    if (!attempts.length) {
      return `<div class="workflow-empty">${esc('Waiting for execution events…')}</div>`;
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
            data-tip="${esc(`A2A attempt ${transportAttempt} · ${stateLabel(segmentState)}`)}">
            <span>A2A ${transportAttempt}</span>
          </span>`;
        }).join('');
        return `<button type="button" class="workflow-timeline-row" data-workflow-agent="${esc(call.agent)}"
          aria-label="${esc(`${call.agent} ${call.callId} ${stateLabel(call.state)}`)}">
          <span class="workflow-timeline-label">
            <strong>${esc(options.agentNames?.[call.agent] || call.agent)}</strong>
            <small>${esc(call.callId.slice(0, 8))}${call.transportAttempts > 1 ? ` · A2A ×${call.transportAttempts}` : ''}</small>
          </span>
          <span class="workflow-timeline-track">
            <span class="workflow-timeline-bar state-${esc(call.state)}" style="left:${left.toFixed(2)}%;width:${Math.min(100 - left, width).toFixed(2)}%"></span>
            ${segments}
            ${retries ? `<span class="workflow-timeline-badge retry">${esc(`${retries} retry`)}</span>` : ''}
            ${errors ? `<span class="workflow-timeline-badge error">${esc('error')}</span>` : ''}
          </span>
        </button>`;
      }).join('') : `<div class="workflow-empty small">${esc('No A2A calls in this attempt yet')}</div>`;
      return `<section class="workflow-attempt">
        <header>
          <strong>${esc(`Attempt ${number}`)}</strong>
          <span class="state-${esc(attempt.state)}">${esc(stateLabel(attempt.state))}</span>
          <time>${esc(duration(attempt.startedAt, attempt.endedAt) || '—')}</time>
          ${attempt.error ? `<span class="workflow-attempt-error" data-tip="${esc(attempt.error)}">${esc(attempt.error)}</span>` : ''}
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

  return { init, render, setTab };
});
