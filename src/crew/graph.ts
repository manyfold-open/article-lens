import type {
  AgentName,
  BiStr,
  Effort,
  GraphConfig,
  SSEWorkflowPlan,
  WorkflowNodeId,
} from '../schema'

export type Stage1Agent = 'sum' | 'jargon' | 'comments'
export type EffortAgent = Stage1Agent

export interface NormalizedGraph {
  enabled: Partial<Record<'sum' | 'jargon' | 'comments' | 'ctx' | 'synth', boolean>>
  effort: Record<EffortAgent, Effort>
  replicas: Record<EffortAgent, number>
  groups: { members: Stage1Agent[]; mode: 'parallel' | 'relay' }[]
}

export const STAGE1: Stage1Agent[] = ['sum', 'jargon', 'comments']

function bi(zh: string, en: string): BiStr {
  return { zh, en }
}

function isStage1(value: string): value is Stage1Agent {
  return value === 'sum' || value === 'jargon' || value === 'comments'
}

function normEffort(value: unknown): Effort {
  return value === 'low' || value === 'high' ? value : 'med'
}

function normReplicas(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1
  return Math.min(3, Math.max(1, number))
}

export function normalizeGraph(config: GraphConfig | null | undefined): NormalizedGraph | null {
  if (!config || typeof config.v !== 'number') return null
  const effort: Record<EffortAgent, Effort> = { sum: 'med', jargon: 'med', comments: 'med' }
  const replicas: Record<EffortAgent, number> = { sum: 1, jargon: 1, comments: 1 }
  let enabled: NormalizedGraph['enabled']
  if (config.nodes && typeof config.nodes === 'object') {
    enabled = {}
    for (const agent of ['sum', 'jargon', 'comments', 'ctx', 'synth'] as const) {
      const node = config.nodes[agent]
      if (node && typeof node === 'object' && node.enabled === false) enabled[agent] = false
    }
    for (const agent of STAGE1) {
      const node = config.nodes[agent]
      if (!node || typeof node !== 'object') continue
      effort[agent] = normEffort(node.effort)
      replicas[agent] = normReplicas(node.replicas)
    }
  } else {
    enabled = config.enabled && typeof config.enabled === 'object' ? { ...config.enabled } : {}
  }

  const groups: NormalizedGraph['groups'] = []
  const assigned = new Set<Stage1Agent>()
  for (const group of Array.isArray(config.groups) ? config.groups : []) {
    if (!group || !Array.isArray(group.members)) continue
    const members: Stage1Agent[] = []
    for (const member of group.members) {
      if (!isStage1(member) || assigned.has(member)) continue
      assigned.add(member)
      members.push(member)
    }
    if (members.length) groups.push({ members, mode: group.mode === 'relay' ? 'relay' : 'parallel' })
  }
  return { enabled, effort, replicas, groups }
}

const LABELS: Record<WorkflowNodeId, BiStr> = {
  input: bi('輸入', 'Input'),
  sum: bi('小摘', 'Summarizer'),
  jargon: bi('小詞', 'Jargon'),
  comments: bi('小潛', 'Comments'),
  ctx: bi('小導', 'Context'),
  synth: bi('合成', 'Synthesizer'),
  report: bi('報告', 'Report'),
}

export function buildWorkflowPlan(
  analysisId: string,
  attempt: number,
  maxAttempts: number,
  config: GraphConfig | null | undefined,
): SSEWorkflowPlan {
  const graph = normalizeGraph(config)
  const enabled = graph?.enabled ?? {}
  const effort = graph?.effort ?? { sum: 'med' as const, jargon: 'med' as const, comments: 'med' as const }
  const replicas = graph?.replicas ?? { sum: 1, jargon: 1, comments: 1 }
  const nodes: SSEWorkflowPlan['nodes'] = [
    { id: 'input', kind: 'source', label: LABELS.input, enabled: true },
    ...STAGE1.map(agent => ({
      id: agent,
      kind: 'agent' as const,
      label: LABELS[agent],
      enabled: enabled[agent] !== false,
      effort: effort[agent],
      replicas: replicas[agent],
    })),
    {
      id: 'ctx',
      kind: 'agent',
      label: LABELS.ctx,
      enabled: enabled.ctx !== false,
      debate: Boolean(config?.debate),
    },
    {
      id: 'synth',
      kind: 'agent',
      label: LABELS.synth,
      enabled: enabled.synth !== false,
    },
    { id: 'report', kind: 'sink', label: LABELS.report, enabled: true },
  ]
  const edges: SSEWorkflowPlan['edges'] = []
  const addEdge = (
    from: WorkflowNodeId,
    to: WorkflowNodeId,
    kind: SSEWorkflowPlan['edges'][number]['kind'],
    label?: BiStr,
  ) => edges.push({ id: `${kind}:${from}:${to}`, from, to, kind, label })

  if (config?.escalate) {
    addEdge('input', 'sum', 'dependency')
    addEdge('sum', 'ctx', 'dependency')
    addEdge('ctx', 'jargon', 'conditional', bi('升級 go/stop', 'Escalate go/stop'))
    addEdge('ctx', 'comments', 'conditional', bi('升級 go/stop', 'Escalate go/stop'))
  } else {
    const grouped = new Set<Stage1Agent>()
    for (const group of graph?.groups ?? []) {
      group.members.forEach(agent => grouped.add(agent))
      if (group.mode === 'relay') {
        if (group.members[0]) addEdge('input', group.members[0], 'dependency')
        for (let index = 1; index < group.members.length; index += 1) {
          addEdge(group.members[index - 1], group.members[index], 'relay', bi('接力', 'Relay'))
        }
      } else {
        group.members.forEach(agent => addEdge('input', agent, 'dependency'))
      }
    }
    STAGE1.filter(agent => !grouped.has(agent)).forEach(agent => addEdge('input', agent, 'dependency'))
    STAGE1.forEach(agent => addEdge(agent, 'ctx', 'dependency'))
  }
  addEdge('ctx', 'synth', 'dependency')
  addEdge('synth', 'report', 'dependency')

  return {
    event: 'workflow_plan',
    analysis_id: analysisId,
    attempt,
    max_attempts: maxAttempts,
    nodes,
    edges,
    groups: (graph?.groups ?? []).map(group => ({
      members: group.members as AgentName[],
      mode: group.mode,
    })),
    escalate: Boolean(config?.escalate),
    debate: Boolean(config?.debate),
    audience: config?.audience === 'beginner' || config?.audience === 'expert' ? config.audience : undefined,
  }
}
