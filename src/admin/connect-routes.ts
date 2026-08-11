/**
 * Admin HTTP surface for the Manyfold connect handshake.
 *
 * Every route here sits behind the same session cookie and same-origin check
 * as /api/admin/settings — deliberately reusing that gate rather than adding a
 * second one, because a second auth surface is a second thing to get wrong.
 * Tokens never appear in any response: the browser sees an opaque connectId
 * during the handshake and token-free agent records afterwards.
 */

import {
  A2AError,
  safeErrorText,
} from '../a2a.ts'
import {
  cancelConnect,
  disconnectAgent,
  getConnectSession,
  getRoleMap,
  listConnectedAgents,
  pollConnect,
  ROLE_KEYS,
  ROLE_LABELS,
  setRoleMap,
  startConnect,
  verifyAgent,
  type RoleMap,
} from '../connect.ts'
import type { Env } from '../schema.ts'
import { adminJson, isAdminAuthenticated, sameOrigin } from './settings.ts'

const CONNECT_PREFIX = '/api/admin/connect'
const AGENTS_PREFIX = '/api/admin/agents'
const ROLES_PATH = '/api/admin/roles'

export function isAdminConnectPath(pathname: string): boolean {
  return pathname === CONNECT_PREFIX
    || pathname.startsWith(`${CONNECT_PREFIX}/`)
    || pathname === AGENTS_PREFIX
    || pathname.startsWith(`${AGENTS_PREFIX}/`)
    || pathname === ROLES_PATH
}

function failure(error: unknown): Response {
  if (error instanceof A2AError) {
    return adminJson({ error: error.message }, error.retryable ? 502 : 400)
  }
  return adminJson({ error: safeErrorText(error instanceof Error ? error.message : error) }, 500)
}

async function connectState(env: Env): Promise<{
  agents: Awaited<ReturnType<typeof listConnectedAgents>>
  roles: RoleMap
  role_labels: Record<string, string>
  session: Awaited<ReturnType<typeof getConnectSession>>
}> {
  const [agents, roles, session] = await Promise.all([
    listConnectedAgents(env),
    getRoleMap(env),
    getConnectSession(env),
  ])
  return { agents, roles, role_labels: ROLE_LABELS, session }
}

export async function handleAdminConnect(request: Request, env: Env): Promise<Response> {
  const password = env.ADMIN_SETTINGS_PASSWORD
  if (!password) {
    return adminJson({ error: 'ADMIN_SETTINGS_PASSWORD is not configured for this Worker.' }, 503)
  }
  if (!sameOrigin(request)) return adminJson({ error: 'cross-site request rejected' }, 403)
  if (!await isAdminAuthenticated(request, password)) {
    return adminJson({ error: 'authentication required' }, 401)
  }

  const { pathname } = new URL(request.url)
  const method = request.method

  try {
    if (pathname === AGENTS_PREFIX && method === 'GET') {
      return adminJson(await connectState(env))
    }

    if (pathname === CONNECT_PREFIX && method === 'POST') {
      return adminJson(await startConnect(env, request.url))
    }

    const poll = pathname.match(/^\/api\/admin\/connect\/([^/]+)\/poll$/)
    if (poll && method === 'POST') {
      const outcome = await pollConnect(env, decodeURIComponent(poll[1]))
      return adminJson(
        outcome.status === 'approved'
          ? { ...outcome, ...(await connectState(env)) }
          : outcome,
      )
    }

    const cancel = pathname.match(/^\/api\/admin\/connect\/([^/]+)$/)
    if (cancel && method === 'DELETE') {
      await cancelConnect(env, decodeURIComponent(cancel[1]))
      return adminJson({ cancelled: true })
    }

    const verify = pathname.match(/^\/api\/admin\/agents\/([^/]+)\/verify$/)
    if (verify && method === 'POST') {
      const agent = await verifyAgent(env, decodeURIComponent(verify[1]))
      return adminJson({ agent, ...(await connectState(env)) })
    }

    const remove = pathname.match(/^\/api\/admin\/agents\/([^/]+)$/)
    if (remove && method === 'DELETE') {
      await disconnectAgent(env, decodeURIComponent(remove[1]))
      return adminJson(await connectState(env))
    }

    if (pathname === ROLES_PATH && method === 'PUT') {
      let body: { roles?: unknown }
      try {
        body = await request.json() as { roles?: unknown }
      } catch {
        return adminJson({ error: 'invalid JSON body' }, 400)
      }
      if (!body.roles || typeof body.roles !== 'object' || Array.isArray(body.roles)) {
        return adminJson({ error: 'roles must be an object' }, 400)
      }
      const submitted = body.roles as Record<string, unknown>
      const requested: Partial<RoleMap> = {}
      for (const role of ROLE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(submitted, role)) continue
        const value = submitted[role]
        if (value !== null && typeof value !== 'string') {
          return adminJson({ error: `${ROLE_LABELS[role]} must be an agent id or null` }, 400)
        }
        requested[role] = value as string | null
      }
      await setRoleMap(env, requested)
      return adminJson(await connectState(env))
    }

    return adminJson({ error: 'not found' }, 404)
  } catch (error) {
    return failure(error)
  }
}
