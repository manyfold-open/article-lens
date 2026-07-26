(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WorkflowModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const TERMINAL = new Set(['done', 'error']);

  function iso(value, fallback) {
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
    return fallback || new Date().toISOString();
  }

  function createAttempt(number) {
    return {
      number,
      state: 'queued',
      plan: null,
      nodes: {},
      calls: {},
      usage: { total: 0, byAgent: {} },
      escalateDecision: null,
      error: '',
      startedAt: '',
      endedAt: '',
    };
  }

  function createState(analysisId) {
    return {
      analysisId: analysisId || '',
      cursor: 0,
      seenSeq: {},
      phase: 'queued',
      activeAttempt: 0,
      maxAttempts: 1,
      attempts: {},
      result: null,
      error: '',
      reconnecting: false,
      updatedAt: '',
    };
  }

  function ensureAttempt(state, number) {
    const safeNumber = Math.max(0, Number(number) || state.activeAttempt || 1);
    if (!state.attempts[safeNumber]) state.attempts[safeNumber] = createAttempt(safeNumber);
    if (safeNumber > state.activeAttempt) state.activeAttempt = safeNumber;
    return state.attempts[safeNumber];
  }

  function ensureNode(attempt, id) {
    if (!attempt.nodes[id]) {
      attempt.nodes[id] = {
        id,
        state: 'pending',
        mode: '',
        label: null,
        startedAt: '',
        endedAt: '',
        tokens: 0,
        error: '',
      };
    }
    return attempt.nodes[id];
  }

  function setNodeState(node, state, at, mode) {
    if (!node.startedAt && (state === 'running' || state === 'retrying')) node.startedAt = at;
    node.state = state;
    if (mode) node.mode = mode;
    if (['success', 'cache', 'skipped', 'fallback', 'error'].includes(state)) node.endedAt = at;
  }

  function initializePlan(attempt, event, at) {
    attempt.plan = event;
    for (const config of event.nodes || []) {
      const node = ensureNode(attempt, config.id);
      node.config = config;
      if (!config.enabled) setNodeState(node, 'skipped', at, 'skipped');
    }
    setNodeState(ensureNode(attempt, 'input'), 'success', at, 'real');
  }

  function callKey(agent, callId) {
    return `${agent || 'system'}:${callId || 'workflow'}`;
  }

  function ensureCall(attempt, event, at) {
    const key = callKey(event.agent, event.call_id);
    if (!attempt.calls[key]) {
      attempt.calls[key] = {
        key,
        agent: event.agent,
        callId: event.call_id || 'workflow',
        state: 'pending',
        startedAt: at,
        endedAt: '',
        prompt: '',
        output: '',
        error: '',
        transportAttempts: 0,
        events: [],
      };
    }
    return attempt.calls[key];
  }

  function statusState(event) {
    if (event.state === 'error') return 'error';
    if (event.state === 'running') return 'running';
    if (event.mode === 'cache') return 'cache';
    if (event.mode === 'skipped') return 'skipped';
    if (event.mode === 'fallback') return 'fallback';
    if (event.state === 'done') return 'success';
    return 'pending';
  }

  function applyResultModes(attempt, result, at) {
    const sources = result?.flags?.agent_sources || {};
    const fallbacks = new Set(result?.flags?.fallback_agents || []);
    const skipped = new Set(result?.flags?.skipped_agents || []);
    for (const id of ['sum', 'jargon', 'comments', 'ctx', 'synth']) {
      const node = ensureNode(attempt, id);
      const mode = sources[id]?.mode || (fallbacks.has(id) ? 'fallback' : skipped.has(id) ? 'skipped' : '');
      if (node.mode && node.mode !== 'real') {
        setNodeState(node, node.mode === 'real' ? 'success' : node.mode, at, node.mode);
      } else if (mode) {
        setNodeState(node, mode === 'real' ? 'success' : mode, at, mode);
      }
      else if (node.state === 'pending' && id === 'synth') setNodeState(node, 'skipped', at, 'skipped');
    }
    setNodeState(ensureNode(attempt, 'report'), 'success', at, 'real');
  }

  function applyEvent(state, event, receivedAt) {
    if (!event || typeof event.event !== 'string') return state;
    const at = iso(event.at, receivedAt);
    state.updatedAt = at;
    if (event.analysis_id) state.analysisId = event.analysis_id;

    if (event.event === 'workflow_plan') {
      const attempt = ensureAttempt(state, event.attempt);
      state.maxAttempts = Math.max(state.maxAttempts, Number(event.max_attempts) || 1);
      initializePlan(attempt, event, at);
      return state;
    }

    if (event.event === 'workflow_state') {
      const attempt = ensureAttempt(state, event.attempt || state.activeAttempt || 1);
      state.maxAttempts = Math.max(state.maxAttempts, Number(event.max_attempts) || 1);
      attempt.state = event.state;
      if (event.reason) attempt.error = event.reason;
      if (event.state === 'running' && !attempt.startedAt) attempt.startedAt = at;
      if (TERMINAL.has(event.state)) attempt.endedAt = at;
      state.phase = event.state === 'retry_wait' ? 'queued' : event.state;
      if (event.state === 'error') state.error = event.reason || state.error;
      return state;
    }

    const attempt = ensureAttempt(state, state.activeAttempt || 1);
    switch (event.event) {
      case 'status': {
        const node = ensureNode(attempt, event.agent);
        node.label = event.label;
        setNodeState(node, statusState(event), at, event.mode);
        break;
      }
      case 'step': {
        const node = ensureNode(attempt, event.agent);
        node.label = event.label;
        if (!['error', 'fallback', 'skipped', 'cache', 'success'].includes(node.state)) {
          setNodeState(node, 'running', at);
        }
        break;
      }
      case 'agent_trace': {
        const call = ensureCall(attempt, event, at);
        call.events.push({
          phase: event.phase,
          at,
          label: event.label,
          content: event.content || '',
          attempt: event.attempt,
          willRetry: event.will_retry === true,
        });
        call.transportAttempts = Math.max(call.transportAttempts, Number(event.attempt) || 1);
        if (event.phase === 'input') {
          call.prompt = event.content || '';
          call.state = 'running';
          if (!call.startedAt) call.startedAt = at;
        } else if (event.phase === 'output') {
          call.output = event.content || '';
          call.state = 'success';
          call.endedAt = at;
        } else if (event.phase === 'error') {
          call.error = event.content || '';
          call.state = event.will_retry ? 'retrying' : 'error';
          if (!event.will_retry) call.endedAt = at;
        } else {
          call.state = 'running';
        }
        const node = ensureNode(attempt, event.agent);
        if (event.phase === 'error') {
          node.error = event.content || '';
          setNodeState(node, event.will_retry ? 'retrying' : 'error', at);
        } else if (!['success', 'cache', 'skipped', 'fallback'].includes(node.state)) {
          setNodeState(node, 'running', at);
        }
        break;
      }
      case 'usage': {
        if (event.agent) {
          attempt.usage.byAgent[event.agent] = (attempt.usage.byAgent[event.agent] || 0) + (Number(event.tokens) || 0);
          ensureNode(attempt, event.agent).tokens = attempt.usage.byAgent[event.agent];
        }
        if (Number.isFinite(event.total)) {
          attempt.usage.total = Number(event.total);
        } else {
          attempt.usage.total = Object.values(attempt.usage.byAgent).reduce((sum, value) => sum + value, 0);
        }
        break;
      }
      case 'escalate':
        attempt.escalateDecision = { decision: event.decision, reason: event.reason || '', at };
        break;
      case 'retry':
        attempt.state = 'retry_wait';
        attempt.error = event.reason || '';
        attempt.endedAt = at;
        state.maxAttempts = Math.max(state.maxAttempts, Number(event.max_attempts) || 1);
        break;
      case 'result':
        state.result = event.data;
        attempt.state = 'done';
        attempt.endedAt = at;
        state.phase = 'done';
        applyResultModes(attempt, event.data, at);
        break;
      case 'error':
        if (event.agent) {
          const node = ensureNode(attempt, event.agent);
          node.error = event.message || '';
          setNodeState(node, 'error', at);
        } else if (event.kind !== 'orchestration_error') {
          state.error = event.message || '';
        }
        break;
      default:
        break;
    }
    return state;
  }

  function applyEnvelope(state, envelope, receivedAt) {
    if (!envelope) return state;
    const seq = Number(envelope.seq);
    if (Number.isFinite(seq)) {
      if (state.seenSeq[seq]) return state;
      state.seenSeq[seq] = true;
      state.cursor = Math.max(state.cursor, seq);
    }
    return applyEvent(state, envelope.data || envelope, receivedAt);
  }

  function applySnapshot(state, snapshot, receivedAt) {
    if (!snapshot) return state;
    if (snapshot.analysis_id) state.analysisId = snapshot.analysis_id;
    const events = Array.isArray(snapshot.events) ? [...snapshot.events] : [];
    events.sort((left, right) => (Number(left.seq) || 0) - (Number(right.seq) || 0));
    for (const envelope of events) applyEnvelope(state, envelope, receivedAt);
    state.cursor = Math.max(state.cursor, Number(snapshot.cursor) || 0);
    state.maxAttempts = Math.max(state.maxAttempts, Number(snapshot.max_attempts) || 1);
    if (snapshot.phase) state.phase = snapshot.phase;
    if (snapshot.error) state.error = snapshot.error;
    if (snapshot.result && !state.result) {
      applyEvent(state, { event: 'result', data: snapshot.result, at: snapshot.updated_at }, receivedAt);
    }
    state.updatedAt = iso(snapshot.updated_at, state.updatedAt || receivedAt);
    return state;
  }

  function currentAttempt(state) {
    return state.attempts[state.activeAttempt] || null;
  }

  function calls(state) {
    const rows = [];
    for (const number of Object.keys(state.attempts).map(Number).sort((a, b) => a - b)) {
      const attempt = state.attempts[number];
      for (const call of Object.values(attempt.calls)) rows.push({ ...call, workflowAttempt: number });
    }
    return rows.sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  }

  return { createState, applyEvent, applyEnvelope, applySnapshot, currentAttempt, calls };
});
