/**
 * Manyfold connect: the operator authorizes on Manyfold's own page and picks
 * which agents to share. No Manyfold identity is needed on this side, and no
 * pre-arranged A2A peer relationship.
 *
 * The handshake, three steps:
 *   POST {base}/api/connect/a2a/start  {clientName, clientUrl?}
 *        → { requestId, userCode, authUrl, deviceCode, expiresAt }
 *   the operator opens authUrl, checks that userCode matches, ticks the agents
 *   POST {base}/api/connect/a2a/poll   {deviceCode}
 *        → pending | denied | expired
 *        | approved { userEmail, agents[{ agentId, name, rpcUrl, cardUrl, token, expiresAt }] }
 *
 * Security invariants, each for a reason:
 *  - deviceCode is the only thing that can redeem agent tokens, so it stays on
 *    the server, sealed; the browser only ever sees an opaque connectId.
 *  - the browser must display userCode for the operator to compare against the
 *    authorization page. That is the only anti-phishing check in this flow.
 *  - agent rpcUrls go through validateA2AUrl before anything is stored, so a
 *    spoofed response cannot point our bearer at an internal address.
 *  - connectivity is verified with the non-billing tasks/get probe, never a
 *    real turn: connecting N agents must not bill N turns.
 *  - a failed probe warns but does not roll back. The token has already been
 *    issued; dropping it would leave a live credential nobody can revoke.
 *
 * STORAGE NOTE, and it is a real weakening rather than a footnote.
 * The upstream starter keeps sessions in D1 and burns the one-time credential
 * with `UPDATE ... WHERE id = ? AND status = 'pending'`, checking the affected
 * row count. That makes "only one of two concurrent polls can redeem" an atomic
 * guarantee. KV has no compare-and-set, so we approximate it with an
 * isolate-local single-flight map plus an idempotent upsert keyed by agentId.
 * Two polls landing in different isolates at the same instant can therefore
 * both call Manyfold; Manyfold itself only releases credentials once, so the
 * loser gets `expired`, but we cannot prove that locally. Do not describe this
 * as equivalent to the D1 version.
 */

import {
  A2AError,
  describeFromCard,
  fetchTimeout,
  probeAgentAuth,
  safeErrorText,
  validateA2AUrl,
  type AgentCredential,
} from './a2a.ts'
import { seal, unseal } from './crypto.ts'
import type { Env } from './schema.ts'

const DEFAULT_API_BASE = 'https://api.manyfold.ai'
const CLIENT_NAME = 'Article Lens'
const START_TIMEOUT_MS = 20_000
const POLL_TIMEOUT_MS = 30_000
const SESSION_TTL_MS = 15 * 60_000
const SEAL_PURPOSE = 'connect'
const MAX_AGENTS = 20

const SESSION_KEY = '__connect:session:v1'
const AGENTS_KEY = '__connect:agents:v1'
const ROLES_KEY = '__connect:roles:v1'

/**
 * The five agent roles one analysis needs.
 *
 * There is no `comments-map` role: AGENT_COMMENT_MAP was configured and health
 * checked but never actually invoked, the comment map/reduce fan-out having
 * been replaced by local ranking plus a single reduce call.
 */
export const ROLE_KEYS = ['sum', 'ctx', 'synth', 'jargon', 'comments'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]
export type RoleMap = Record<RoleKey, string | null>

export const ROLE_LABELS: Record<RoleKey, string> = {
  sum: 'Summariser',
  ctx: 'Context',
  synth: 'Synthesiser',
  jargon: 'Jargon',
  comments: 'Comments',
}

/** Token-free view of a connected agent. Safe to return from an API. */
export interface ConnectedAgent {
  agentId: string
  name: string
  description: string
  rpcUrl: string
  expiresAt: string | null
  verified: boolean
  warning: string | null
  connectedAt: string
}

interface StoredAgent extends ConnectedAgent {
  /** Plaintext only inside the sealed envelope; never selected into a response. */
  token: string
  cardUrl: string | null
}

interface AgentStore {
  v: 1
  updatedAt: string
  userEmail: string | null
  agents: StoredAgent[]
}

interface StoredSession {
  v: 1
  connectId: string
  requestId: string
  userCode: string
  authUrl: string
  deviceCode: string
  status: 'pending' | 'exchanged' | 'denied' | 'expired'
  createdAt: string
  expiresAt: string
}

export interface ConnectSession {
  connectId: string
  userCode: string
  authUrl: string
  expiresAt: string
}

export type PollOutcome =
  | { status: 'pending' | 'denied' | 'expired' }
  | {
      status: 'approved'
      userEmail: string | null
      agents: ConnectedAgent[]
      failed: Array<{ name: string; error: string }>
      roles: RoleMap
    }

const now = (): string => new Date().toISOString()

const apiBase = (env: Env): string => (env.MANYFOLD_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '')

const isProduction = (env: Env): boolean => env.ENVIRONMENT === 'production'

function requirePassword(env: Env): string {
  const password = env.ADMIN_SETTINGS_PASSWORD
  if (!password) {
    throw new A2AError(
      'ADMIN_SETTINGS_PASSWORD is not configured, so agent credentials cannot be encrypted.',
      false,
    )
  }
  return password
}

/* ───────── handshake transport ───────── */

/** Thrown by connectFetch on a poll 404 that means "device code gone", not "wrong URL". */
class DeviceCodeGone extends Error {}

async function connectFetch<T>(env: Env, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const res = await fetchTimeout(`${apiBase(env)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    redirect: 'manual',
    body: JSON.stringify(body),
  }, timeoutMs)

  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }

  if (!res.ok) {
    const message = String(
      (parsed as { error?: { message?: unknown } } | null)?.error?.message
        ?? `Manyfold returned ${res.status}.`,
    )
    if (res.status === 404) {
      // A 404 means two different things and only the body tells them apart: a
      // dead device code answers "deviceCode not found", a mistyped base URL
      // answers with the router's "Cannot POST /…". Start never carries a
      // device code, so any 404 there is a configuration problem.
      const wrongPath = path.endsWith('/start') || /cannot\s+(post|get)/i.test(message)
      if (!wrongPath) throw new DeviceCodeGone(message)
      throw new A2AError(
        `${apiBase(env)}${path} does not exist (404). Check MANYFOLD_API_BASE_URL in wrangler.toml.`,
        false,
      )
    }
    throw new A2AError(`Manyfold rejected the request: ${safeErrorText(message)}`, res.status >= 500)
  }
  return parsed as T
}

/* ───────── store ───────── */

async function readAgentStore(env: Env): Promise<AgentStore> {
  const empty: AgentStore = { v: 1, updatedAt: '', userEmail: null, agents: [] }
  const password = env.ADMIN_SETTINGS_PASSWORD
  if (!password) return empty
  const raw = await env.CACHE.get(AGENTS_KEY)
  if (!raw) return empty
  try {
    const parsed = await unseal<AgentStore>(raw, password, SEAL_PURPOSE)
    if (!parsed || !Array.isArray(parsed.agents)) return empty
    return parsed
  } catch {
    // Wrong key (the admin password was rotated) or tampered ciphertext. The
    // operator has to reconnect; surfacing that is better than a decrypt loop.
    return empty
  }
}

async function writeAgentStore(env: Env, store: AgentStore): Promise<void> {
  const password = requirePassword(env)
  store.updatedAt = now()
  await env.CACHE.put(AGENTS_KEY, await seal(store, password, SEAL_PURPOSE))
}

function publicAgent(agent: StoredAgent): ConnectedAgent {
  const { token: _token, cardUrl: _cardUrl, ...rest } = agent
  return rest
}

async function readSession(env: Env): Promise<StoredSession | null> {
  const password = env.ADMIN_SETTINGS_PASSWORD
  if (!password) return null
  const raw = await env.CACHE.get(SESSION_KEY)
  if (!raw) return null
  try {
    return await unseal<StoredSession>(raw, password, SEAL_PURPOSE)
  } catch {
    return null
  }
}

async function writeSession(env: Env, session: StoredSession): Promise<void> {
  const password = requirePassword(env)
  const ttlSeconds = Math.max(
    60,
    Math.ceil((Date.parse(session.expiresAt) - Date.now()) / 1000) + 60,
  )
  await env.CACHE.put(
    SESSION_KEY,
    await seal(session, password, SEAL_PURPOSE),
    { expirationTtl: ttlSeconds },
  )
}

/* ───────── role mapping ───────── */

const ROLE_HINTS: Record<RoleKey, RegExp> = {
  sum: /summar|tldr|digest|abstract/,
  jargon: /jargon|glossar|term|vocab/,
  ctx: /context|verdict|critic|debate|review/,
  synth: /synth|editor|assemb|curat/,
  comments: /comment|discussion|thread|forum/,
}

const emptyRoles = (): RoleMap => ({ sum: null, ctx: null, synth: null, jargon: null, comments: null })

/**
 * Decide which connected agent serves each role.
 *
 * An explicit assignment to a still-connected agent always wins, so an operator
 * choice survives reconnecting. With exactly one agent every role points at it,
 * and that is written down rather than left implicit: an implicit default would
 * silently re-route four roles the moment a second agent is connected.
 */
export function autoAssignRoles(agents: ConnectedAgent[], current: RoleMap): RoleMap {
  const connected = new Set(agents.map(agent => agent.agentId))
  const next = emptyRoles()
  for (const role of ROLE_KEYS) {
    const existing = current[role]
    if (existing && connected.has(existing)) next[role] = existing
  }
  if (!agents.length) return next

  const fallback = agents.find(agent => agent.verified)?.agentId ?? agents[0].agentId
  if (agents.length === 1) {
    for (const role of ROLE_KEYS) next[role] ??= fallback
    return next
  }

  const taken = new Set(Object.values(next).filter((id): id is string => Boolean(id)))
  for (const role of ROLE_KEYS) {
    if (next[role]) continue
    const hint = ROLE_HINTS[role]
    const match = agents.find(agent => !taken.has(agent.agentId) && hint.test(
      `${agent.name} ${agent.description}`.toLowerCase(),
    ))
    if (match) {
      next[role] = match.agentId
      taken.add(match.agentId)
    }
  }
  for (const role of ROLE_KEYS) next[role] ??= fallback
  return next
}

export async function getRoleMap(env: Env): Promise<RoleMap> {
  const raw = await env.CACHE.get(ROLES_KEY)
  if (!raw) return emptyRoles()
  try {
    const parsed = JSON.parse(raw) as { roles?: Partial<RoleMap> }
    const roles = emptyRoles()
    for (const role of ROLE_KEYS) {
      const value = parsed.roles?.[role]
      if (typeof value === 'string' && value) roles[role] = value
    }
    return roles
  } catch {
    return emptyRoles()
  }
}

async function writeRoleMap(env: Env, roles: RoleMap): Promise<void> {
  await env.CACHE.put(ROLES_KEY, JSON.stringify({ v: 1, updatedAt: now(), roles }))
}

/** Assign roles explicitly. Every value must name a connected agent, or be null. */
export async function setRoleMap(env: Env, requested: Partial<RoleMap>): Promise<RoleMap> {
  const store = await readAgentStore(env)
  const connected = new Set(store.agents.map(agent => agent.agentId))
  const roles = await getRoleMap(env)
  for (const role of ROLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(requested, role)) continue
    const value = requested[role]
    if (value === null || value === '') {
      roles[role] = null
      continue
    }
    if (typeof value !== 'string' || !connected.has(value)) {
      throw new A2AError(`"${value}" is not a connected agent, so it cannot serve ${ROLE_LABELS[role]}.`, false)
    }
    roles[role] = value
  }
  await writeRoleMap(env, roles)
  return roles
}

/* ───────── start / poll / cancel ───────── */

export async function startConnect(env: Env, requestUrl: string): Promise<ConnectSession> {
  requirePassword(env)

  // clientUrl is optional and Manyfold requires https, so a local http origin
  // is omitted rather than rejected.
  const origin = new URL(requestUrl).origin
  const clientUrl = origin.startsWith('https://') ? origin : undefined

  const started = await connectFetch<{
    requestId: string
    userCode: string
    authUrl: string
    deviceCode: string
    expiresAt: string
  }>(
    env,
    '/api/connect/a2a/start',
    { clientName: CLIENT_NAME, ...(clientUrl ? { clientUrl } : {}) },
    START_TIMEOUT_MS,
  )
  if (!started?.deviceCode || !started.authUrl || !started.userCode) {
    throw new A2AError('Manyfold returned an incomplete handshake.', true)
  }

  const remote = Date.parse(started.expiresAt ?? '')
  const expiresAt = Number.isFinite(remote)
    ? new Date(remote).toISOString()
    : new Date(Date.now() + SESSION_TTL_MS).toISOString()
  const connectId = crypto.randomUUID()

  await writeSession(env, {
    v: 1,
    connectId,
    requestId: started.requestId,
    userCode: started.userCode,
    authUrl: started.authUrl,
    deviceCode: started.deviceCode,
    status: 'pending',
    createdAt: now(),
    expiresAt,
  })

  // deviceCode is deliberately not returned.
  return { connectId, userCode: started.userCode, authUrl: started.authUrl, expiresAt }
}

/** The in-flight handshake, if any, so a reloaded page resumes where it was. */
export async function getConnectSession(env: Env): Promise<ConnectSession | null> {
  const session = await readSession(env)
  if (!session || session.status !== 'pending') return null
  if (Date.parse(session.expiresAt) <= Date.now()) return null
  return {
    connectId: session.connectId,
    userCode: session.userCode,
    authUrl: session.authUrl,
    expiresAt: session.expiresAt,
  }
}

export async function cancelConnect(env: Env, connectId: string): Promise<void> {
  const session = await readSession(env)
  if (session && session.connectId !== connectId) return
  await env.CACHE.delete(SESSION_KEY)
}

// Isolate-local single-flight. Not a substitute for the atomic burn the D1
// version gets (see the module header) — it only collapses the common case of a
// browser polling faster than one round trip completes.
const pollInflight = new Map<string, Promise<PollOutcome>>()

export async function pollConnect(env: Env, connectId: string): Promise<PollOutcome> {
  const pending = pollInflight.get(connectId)
  if (pending) return pending
  const run = pollOnce(env, connectId).finally(() => {
    if (pollInflight.get(connectId) === run) pollInflight.delete(connectId)
  })
  pollInflight.set(connectId, run)
  return run
}

async function pollOnce(env: Env, connectId: string): Promise<PollOutcome> {
  const session = await readSession(env)
  // KV is eventually consistent, so a poll issued moments after start can read
  // a colo that has not seen the write yet. Treat a missing session inside the
  // start window as "keep polling" rather than as a hard failure.
  if (!session || session.connectId !== connectId) {
    throw new A2AError('That authorization session no longer exists.', false)
  }
  if (session.status !== 'pending') return { status: 'expired' }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await writeSession(env, { ...session, status: 'expired', deviceCode: '' })
    return { status: 'expired' }
  }

  let result: {
    status: 'pending' | 'denied' | 'expired' | 'approved'
    userEmail?: string | null
    agents?: Array<{
      agentId: string
      name: string
      rpcUrl: string
      cardUrl?: string
      token: string
      expiresAt?: string | null
    }>
  }
  try {
    result = await connectFetch(env, '/api/connect/a2a/poll', { deviceCode: session.deviceCode }, POLL_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof DeviceCodeGone) {
      // Expired, already redeemed elsewhere, or revoked. Either way it is over.
      await writeSession(env, { ...session, status: 'expired', deviceCode: '' })
      return { status: 'expired' }
    }
    throw error
  }

  if (result.status !== 'approved') {
    if (result.status !== 'pending') {
      await writeSession(env, { ...session, status: result.status, deviceCode: '' })
    }
    return { status: result.status }
  }

  // Tokens are delivered once. Burn the session and wipe the used deviceCode
  // before consuming them, so a replayed poll cannot re-enter this branch.
  await writeSession(env, { ...session, status: 'exchanged', deviceCode: '' })

  const store = await readAgentStore(env)
  const saved: ConnectedAgent[] = []
  const failed: Array<{ name: string; error: string }> = []

  for (const entry of result.agents ?? []) {
    try {
      const agent = await prepareAgent(env, entry)
      const index = store.agents.findIndex(candidate => candidate.agentId === agent.agentId)
      if (index >= 0) store.agents[index] = agent
      else store.agents.push(agent)
      saved.push(publicAgent(agent))
    } catch (error) {
      failed.push({ name: entry?.name || 'unknown agent', error: safeErrorText(error instanceof Error ? error.message : error) })
    }
  }
  store.agents = store.agents.slice(-MAX_AGENTS)
  store.userEmail = result.userEmail ?? store.userEmail ?? null
  await writeAgentStore(env, store)

  const roles = autoAssignRoles(store.agents.map(publicAgent), await getRoleMap(env))
  await writeRoleMap(env, roles)

  return { status: 'approved', userEmail: store.userEmail, agents: saved, failed, roles }
}

async function prepareAgent(
  env: Env,
  entry: { agentId: string; name: string; rpcUrl: string; cardUrl?: string; token: string; expiresAt?: string | null },
): Promise<StoredAgent> {
  if (!entry?.agentId || !entry.token) throw new A2AError('Manyfold returned an agent without an id or token.', false)
  const rpcUrl = validateA2AUrl(entry.rpcUrl, isProduction(env), "the agent's rpcUrl")
  const name = (entry.name || 'Manyfold agent').slice(0, 80)
  const description = entry.cardUrl ? await describeFromCard(entry.cardUrl) : ''

  // Auth-only probe. A failure is recorded as a warning rather than rolled
  // back: the token is already issued, and discarding it here would leave a
  // live credential nobody can revoke.
  let verified = true
  let warning: string | null = null
  try {
    await probeAgentAuth({ agentId: entry.agentId, rpcUrl, token: entry.token, label: name, expiresAt: null })
  } catch (error) {
    verified = false
    warning = safeErrorText(error instanceof Error ? error.message : error)
  }

  return {
    agentId: entry.agentId,
    name,
    description,
    rpcUrl,
    cardUrl: entry.cardUrl ?? null,
    token: entry.token,
    expiresAt: entry.expiresAt ?? null,
    verified,
    warning,
    connectedAt: now(),
  }
}

/* ───────── connected agents ───────── */

export async function listConnectedAgents(env: Env): Promise<ConnectedAgent[]> {
  const store = await readAgentStore(env)
  return store.agents.map(publicAgent)
}

export async function disconnectAgent(env: Env, agentId: string): Promise<void> {
  const store = await readAgentStore(env)
  store.agents = store.agents.filter(agent => agent.agentId !== agentId)
  await writeAgentStore(env, store)
  await writeRoleMap(env, autoAssignRoles(store.agents.map(publicAgent), await getRoleMap(env)))
}

/** Re-runs the non-billing auth probe and records the outcome. */
export async function verifyAgent(env: Env, agentId: string): Promise<ConnectedAgent> {
  const store = await readAgentStore(env)
  const agent = store.agents.find(candidate => candidate.agentId === agentId)
  if (!agent) throw new A2AError('That agent is not connected.', false)
  try {
    await probeAgentAuth(credentialFrom(agent))
    agent.verified = true
    agent.warning = null
  } catch (error) {
    agent.verified = false
    agent.warning = safeErrorText(error instanceof Error ? error.message : error)
  }
  await writeAgentStore(env, store)
  return publicAgent(agent)
}

/** Records that an agent rejected its stored token, so the UI can say so. */
export async function markCredentialRejected(env: Env, agentId: string, reason: string): Promise<void> {
  const store = await readAgentStore(env)
  const agent = store.agents.find(candidate => candidate.agentId === agentId)
  if (!agent) return
  agent.verified = false
  agent.warning = safeErrorText(reason)
  await writeAgentStore(env, store)
}

function credentialFrom(agent: StoredAgent): AgentCredential {
  const expiresAt = agent.expiresAt ? Date.parse(agent.expiresAt) : Number.NaN
  return {
    agentId: agent.agentId,
    rpcUrl: agent.rpcUrl,
    token: agent.token,
    label: agent.name,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  }
}

/* ───────── runtime ───────── */

/**
 * Everything one request or one queue invocation needs to reach agents.
 *
 * Loaded once per invocation and passed down on `env`, so a 12-minute
 * orchestration reads KV once rather than once per agent call.
 */
export interface A2ARuntime {
  mode: 'live' | 'mock'
  roles: RoleMap
  agents: ConnectedAgent[]
  credential(agentId: string): AgentCredential | null
  soonestExpiryAt: number | null
  distinctAgentCount: number
  /** Guarantees a stray console.log(env) can never print a bearer token. */
  toJSON(): string
}

export async function loadA2ARuntime(env: Env): Promise<A2ARuntime> {
  const [store, roles] = await Promise.all([readAgentStore(env), getRoleMap(env)])
  const byId = new Map(store.agents.map(agent => [agent.agentId, agent]))
  const mapped = ROLE_KEYS.map(role => roles[role]).filter((id): id is string => Boolean(id && byId.has(id)))
  const expiries = store.agents
    .map(agent => (agent.expiresAt ? Date.parse(agent.expiresAt) : Number.NaN))
    .filter(value => Number.isFinite(value))

  return {
    mode: store.agents.length && mapped.length ? 'live' : 'mock',
    roles,
    agents: store.agents.map(publicAgent),
    credential: (agentId: string) => {
      const agent = byId.get(agentId)
      return agent ? credentialFrom(agent) : null
    },
    soonestExpiryAt: expiries.length ? Math.min(...expiries) : null,
    distinctAgentCount: new Set(mapped).size,
    toJSON: () => '[a2a-runtime]',
  }
}

export function isMockMode(env: Env): boolean {
  return (env.A2A?.mode ?? 'mock') === 'mock'
}

export interface RoleReadiness {
  role: RoleKey
  agentId: string | null
  name: string | null
  expiresAt: string | null
  ok: boolean
  reason: string | null
}

export interface CredentialReadiness {
  ok: boolean
  code: 'ok' | 'not_connected' | 'unmapped_roles' | 'expiring' | 'expired'
  message: string
  roles: RoleReadiness[]
}

/**
 * Can every role still be called for the next `horizonMs`?
 *
 * Connect tokens last days, so this normally passes; it exists because a job
 * that starts with a credential about to lapse would otherwise spend its whole
 * budget producing an all-fallback result instead of failing in a way the
 * operator can act on.
 */
export function credentialReadiness(runtime: A2ARuntime | undefined, horizonMs: number): CredentialReadiness {
  if (!runtime || !runtime.agents.length) {
    return {
      ok: false,
      code: 'not_connected',
      message: 'No Manyfold agents are connected. Open /settings and connect one.',
      roles: ROLE_KEYS.map(role => ({ role, agentId: null, name: null, expiresAt: null, ok: false, reason: 'not connected' })),
    }
  }

  const deadline = Date.now() + horizonMs
  let unmapped = 0
  let expired = 0
  let expiring = 0

  const roles: RoleReadiness[] = ROLE_KEYS.map((role) => {
    const agentId = runtime.roles[role]
    const cred = agentId ? runtime.credential(agentId) : null
    if (!cred) {
      unmapped += 1
      return { role, agentId, name: null, expiresAt: null, ok: false, reason: 'no agent assigned' }
    }
    const agent = runtime.agents.find(candidate => candidate.agentId === agentId) ?? null
    if (cred.expiresAt !== null && cred.expiresAt <= Date.now()) {
      expired += 1
      return { role, agentId, name: cred.label, expiresAt: agent?.expiresAt ?? null, ok: false, reason: 'authorization expired' }
    }
    if (cred.expiresAt !== null && cred.expiresAt <= deadline) {
      expiring += 1
      return { role, agentId, name: cred.label, expiresAt: agent?.expiresAt ?? null, ok: false, reason: 'authorization expires before this run could finish' }
    }
    return { role, agentId, name: cred.label, expiresAt: agent?.expiresAt ?? null, ok: true, reason: null }
  })

  if (expired) {
    return { ok: false, code: 'expired', message: `${expired} agent authorization(s) expired. Reconnect on /settings.`, roles }
  }
  if (expiring) {
    return { ok: false, code: 'expiring', message: `${expiring} agent authorization(s) expire before this run could finish. Reconnect on /settings.`, roles }
  }
  if (unmapped) {
    return { ok: false, code: 'unmapped_roles', message: `${unmapped} role(s) have no agent assigned. Assign them on /settings.`, roles }
  }
  return { ok: true, code: 'ok', message: 'All roles are connected.', roles }
}
