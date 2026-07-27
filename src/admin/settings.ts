import type { Env } from '../schema'

type RuntimeValues = Record<string, string>

interface StoredSettings {
  updatedAt: string
  values: RuntimeValues
}

interface SettingsField {
  key: string
  label: string
  description: string
  secret?: boolean
  required?: boolean
  kind?: 'text' | 'url' | 'number' | 'passcode'
}

const PROJECT_ID = 'article-lens'
const COOKIE_NAME = 'article_lens_admin'
const ACCESS_COOKIE_NAME = 'article_lens_access'
const SETTINGS_KEY = '__admin:runtime-settings:v1'
const SESSION_TTL_SECONDS = 8 * 60 * 60
const ACCESS_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
const ACCESS_RATE_LIMIT_ATTEMPTS = 5
const ACCESS_RATE_LIMIT_SECONDS = 10 * 60
const AGENT_ROUTING_KEYS = [
  'MF_AGENT_ID',
  'AGENT_SUMMARIZER',
  'AGENT_CONTEXT',
  'AGENT_SYNTHESIZER',
  'AGENT_COMMENT_MAP',
  'AGENT_JARGON',
  'AGENT_COMMENT_REDUCE',
] as const
const LEGACY_GEMINI_AGENT_IDS = new Set([
  'agt_agpzmem6af5rrbztanib4gxfkm',
  'agt_agpzmenybn42znpqy4izl7lwou',
  'agt_agpzmeozpvzvfdc7ejvwk7ix2u',
  'agt_agpzmepvgf4ghjs2awkl2zv5jq',
  'agt_agpzmeqnlf6qlex4vnwtlnm3gu',
  'agt_agpzmerdrn65lfptmniusgt3jy',
  'agt_agpzmer57f3blmw2ewnqivcxfy',
])

const FIELDS: SettingsField[] = [
  {
    key: 'ACCESS_PASSCODE',
    label: 'Application access passcode',
    description: 'Exactly 6 digits. Visitors must enter it before Article Lens or its APIs can be used.',
    secret: true,
    required: true,
    kind: 'passcode',
  },
  {
    key: 'MF_API_URL',
    label: 'Manyfold API URL',
    description: 'Manyfold REST API base URL.',
    required: true,
    kind: 'url',
  },
  {
    key: 'MF_AGENT_ID',
    label: 'Manyfold source agent',
    description: 'Agent identity used when minting peer A2A tokens.',
    required: true,
  },
  {
    key: 'MF_API_TOKEN',
    label: 'Manyfold API token',
    description: 'Secret token for the source agent. Leave blank to keep the current value.',
    secret: true,
    required: true,
  },
  {
    key: 'SPEC_VERSION',
    label: 'Result spec version',
    description: 'Positive integer included in cache keys and analysis results.',
    required: true,
    kind: 'number',
  },
  {
    key: 'AGENT_SUMMARIZER',
    label: 'Summarizer agent',
    description: 'Peer used by the article summary stage.',
    required: true,
  },
  {
    key: 'AGENT_CONTEXT',
    label: 'Context agent',
    description: 'Peer used for reading guidance and debate.',
    required: true,
  },
  {
    key: 'AGENT_SYNTHESIZER',
    label: 'Synthesizer agent',
    description: 'Peer used to assemble the final analysis.',
    required: true,
  },
  {
    key: 'AGENT_COMMENT_MAP',
    label: 'Comment map agent',
    description: 'Peer used to process comment batches.',
    required: true,
  },
  {
    key: 'AGENT_JARGON',
    label: 'Jargon agent',
    description: 'Peer used to identify and explain technical terms.',
    required: true,
  },
  {
    key: 'AGENT_COMMENT_REDUCE',
    label: 'Comment reduce agent',
    description: 'Peer used to combine comment batch results.',
    required: true,
  },
]

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function deriveBytes(password: string, purpose: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', textEncoder.encode(`${PROJECT_ID}:${purpose}:${password}`))
}

async function sign(value: string, password: string, purpose = 'session'): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, purpose),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))))
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', textEncoder.encode(left)),
    crypto.subtle.digest('SHA-256', textEncoder.encode(right)),
  ])
  const leftBytes = new Uint8Array(leftHash)
  const rightBytes = new Uint8Array(rightHash)
  let difference = leftBytes.length ^ rightBytes.length
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

async function encryptSettings(settings: StoredSettings, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, 'settings'),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(JSON.stringify(settings)),
  )
  return JSON.stringify({
    v: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
  })
}

async function decryptSettings(raw: string, password: string): Promise<StoredSettings> {
  const envelope = JSON.parse(raw) as { v?: number; iv?: string; ciphertext?: string }
  if (envelope.v !== 1 || !envelope.iv || !envelope.ciphertext) {
    throw new Error('unsupported settings format')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, 'settings'),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv) },
    key,
    base64UrlToBytes(envelope.ciphertext),
  )
  const parsed = JSON.parse(textDecoder.decode(decrypted)) as StoredSettings
  if (!parsed || typeof parsed.values !== 'object' || Array.isArray(parsed.values)) {
    throw new Error('invalid settings payload')
  }
  return parsed
}

async function readStoredSettings(env: Env): Promise<{ settings: StoredSettings; warning?: string }> {
  const empty = { updatedAt: '', values: {} }
  if (!env.ADMIN_SETTINGS_PASSWORD) return { settings: empty }
  const raw = await env.CACHE.get(SETTINGS_KEY)
  if (!raw) return { settings: empty }
  try {
    const settings = await decryptSettings(raw, env.ADMIN_SETTINGS_PASSWORD)
    settings.values = migrateLegacyAgentSettings(env, settings.values)
    return { settings }
  } catch {
    return {
      settings: empty,
      warning: 'Saved settings could not be decrypted. Re-enter them after changing the admin password.',
    }
  }
}

function envValue(env: Env, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function migrateLegacyAgentSettings(env: Env, values: RuntimeValues): RuntimeValues {
  const migrated = { ...values }
  for (const key of AGENT_ROUTING_KEYS) {
    const saved = migrated[key]
    if (!saved || !LEGACY_GEMINI_AGENT_IDS.has(saved)) continue
    const replacement = envValue(env, key)
    if (replacement && !LEGACY_GEMINI_AGENT_IDS.has(replacement)) migrated[key] = replacement
  }
  return migrated
}

function effectiveValue(env: Env, values: RuntimeValues, key: string): string {
  return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : envValue(env, key)
}

export async function resolveRuntimeEnv(env: Env): Promise<Env> {
  if (!env.ADMIN_SETTINGS_PASSWORD) return env
  const { settings } = await readStoredSettings(env)
  return { ...env, ...settings.values } as Env
}

function cookieValue(request: Request, cookieName = COOKIE_NAME): string | null {
  const cookies = request.headers.get('cookie') ?? ''
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === cookieName) return value.join('=')
  }
  return null
}

async function isAuthenticated(request: Request, password: string): Promise<boolean> {
  const token = cookieValue(request)
  if (!token) return false
  const separator = token.lastIndexOf('.')
  if (separator < 1) return false
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  let parsed: { exp?: number }
  try {
    parsed = JSON.parse(textDecoder.decode(base64UrlToBytes(payload))) as { exp?: number }
  } catch {
    return false
  }
  if (!parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) return false
  return safeEqual(signature, await sign(payload, password))
}

async function makeSession(password: string): Promise<string> {
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  })))
  return `${payload}.${await sign(payload, password)}`
}

function adminJson(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8')
  responseHeaders.set('Cache-Control', 'no-store')
  responseHeaders.set('X-Content-Type-Options', 'nosniff')
  return new Response(JSON.stringify(body), { status, headers: responseHeaders })
}

function sameOrigin(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite === 'cross-site') return false
  const origin = request.headers.get('origin')
  return !origin || origin === new URL(request.url).origin
}

function validateValue(field: SettingsField, value: string): string | null {
  if (value.length > (field.secret ? 8192 : 2048)) return `${field.label} is too long`
  if (field.kind === 'url' && value) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return `${field.label} must use HTTP or HTTPS`
    } catch {
      return `${field.label} must be a valid URL`
    }
  }
  if (field.kind === 'number' && value && !/^[1-9]\d*$/.test(value)) {
    return `${field.label} must be a positive integer`
  }
  if (field.kind === 'passcode' && value && !/^\d{6}$/.test(value)) {
    return `${field.label} must contain exactly 6 digits`
  }
  return null
}

function sessionCookie(request: Request, token: string, maxAge: number, cookieName = COOKIE_NAME): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

export function isAdminSettingsPath(pathname: string): boolean {
  return pathname === '/api/admin/settings'
    || pathname === '/api/admin/settings/login'
    || pathname === '/api/admin/settings/logout'
}

export async function handleAdminSettings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const password = env.ADMIN_SETTINGS_PASSWORD
  if (!password) {
    return adminJson({ error: 'ADMIN_SETTINGS_PASSWORD is not configured for this Worker.' }, 503)
  }
  if (!sameOrigin(request)) return adminJson({ error: 'cross-site request rejected' }, 403)

  if (url.pathname === '/api/admin/settings/login') {
    if (request.method !== 'POST') return adminJson({ error: 'method not allowed' }, 405)
    let supplied = ''
    try {
      const body = await request.json() as { password?: unknown }
      supplied = typeof body.password === 'string' ? body.password : ''
    } catch {
      return adminJson({ error: 'invalid JSON body' }, 400)
    }
    if (!await safeEqual(supplied, password)) return adminJson({ error: 'incorrect password' }, 401)
    const token = await makeSession(password)
    return adminJson(
      { authenticated: true, expires_in: SESSION_TTL_SECONDS },
      200,
      { 'Set-Cookie': sessionCookie(request, token, SESSION_TTL_SECONDS) },
    )
  }

  if (url.pathname === '/api/admin/settings/logout') {
    if (request.method !== 'POST') return adminJson({ error: 'method not allowed' }, 405)
    return adminJson(
      { authenticated: false },
      200,
      { 'Set-Cookie': sessionCookie(request, '', 0) },
    )
  }

  if (!await isAuthenticated(request, password)) {
    return adminJson({ error: 'authentication required' }, 401)
  }

  if (request.method === 'GET') {
    const { settings, warning } = await readStoredSettings(env)
    return adminJson({
      project: 'Article Lens',
      updated_at: settings.updatedAt || null,
      warning: warning ?? null,
      fields: FIELDS.map((field) => {
        const saved = Object.prototype.hasOwnProperty.call(settings.values, field.key)
        const environment = Boolean(envValue(env, field.key))
        const value = effectiveValue(env, settings.values, field.key)
        return {
          ...field,
          value: field.secret ? '' : value,
          configured: Boolean(value),
          source: saved ? 'settings' : environment ? 'environment' : 'unset',
        }
      }),
      infrastructure: [
        { name: 'CACHE', configured: Boolean(env.CACHE), note: 'KV; stores cache and encrypted settings' },
        { name: 'ANALYSIS_JOBS', configured: Boolean(env.ANALYSIS_JOBS), note: 'Durable Object workflow coordinator' },
        { name: 'ANALYSIS_TASK_QUEUE', configured: Boolean(env.ANALYSIS_TASK_QUEUE), note: 'Queue worker pool' },
        { name: 'ASSETS', configured: Boolean(env.ASSETS), note: 'Static asset binding' },
      ],
    })
  }

  if (request.method !== 'PUT') return adminJson({ error: 'method not allowed' }, 405)

  let body: { values?: unknown; clear?: unknown }
  try {
    body = await request.json() as { values?: unknown; clear?: unknown }
  } catch {
    return adminJson({ error: 'invalid JSON body' }, 400)
  }
  if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
    return adminJson({ error: 'values must be an object' }, 400)
  }
  const submitted = body.values as Record<string, unknown>
  const clear = new Set(Array.isArray(body.clear) ? body.clear.filter((key): key is string => typeof key === 'string') : [])
  const { settings } = await readStoredSettings(env)
  const next = { ...settings.values }
  const errors: string[] = []

  for (const field of FIELDS) {
    if (clear.has(field.key)) delete next[field.key]
    if (!Object.prototype.hasOwnProperty.call(submitted, field.key)) continue
    if (typeof submitted[field.key] !== 'string') {
      errors.push(`${field.label} must be a string`)
      continue
    }
    const value = (submitted[field.key] as string).trim()
    if (field.secret && !value) continue
    const error = validateValue(field, value)
    if (error) {
      errors.push(error)
    } else if (value) {
      next[field.key] = value
    } else {
      delete next[field.key]
    }
  }

  for (const field of FIELDS.filter((candidate) => candidate.required)) {
    if (!effectiveValue(env, next, field.key)) errors.push(`${field.label} is required`)
  }
  if (errors.length) return adminJson({ error: 'validation failed', details: [...new Set(errors)] }, 400)

  const saved: StoredSettings = { updatedAt: new Date().toISOString(), values: next }
  await env.CACHE.put(SETTINGS_KEY, await encryptSettings(saved, password))
  return adminJson({ saved: true, updated_at: saved.updatedAt })
}

interface AccessSessionPayload {
  exp?: number
  passcodeVersion?: string
  nonce?: string
}

interface ArticleAccessGuard {
  runtimeEnv: Env
  response?: Response
}

function accessJson(body: unknown, status = 200, headers?: HeadersInit): Response {
  return adminJson(body, status, headers)
}

async function accessPasscodeVersion(passcode: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await deriveBytes(passcode, 'access-version'))).slice(0, 24)
}

async function makeAccessSession(signingSecret: string, passcode: string): Promise<string> {
  const payload = bytesToBase64Url(textEncoder.encode(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + ACCESS_SESSION_TTL_SECONDS,
    passcodeVersion: await accessPasscodeVersion(passcode),
    nonce: crypto.randomUUID(),
  } satisfies AccessSessionPayload)))
  return `${payload}.${await sign(payload, signingSecret, 'access-session')}`
}

async function isAccessAuthenticated(
  request: Request,
  signingSecret: string,
  passcode: string,
): Promise<boolean> {
  const token = cookieValue(request, ACCESS_COOKIE_NAME)
  if (!token) return false
  const separator = token.lastIndexOf('.')
  if (separator < 1) return false
  const payload = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  let parsed: AccessSessionPayload
  try {
    parsed = JSON.parse(textDecoder.decode(base64UrlToBytes(payload))) as AccessSessionPayload
  } catch {
    return false
  }
  if (!parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000) || !parsed.passcodeVersion) return false
  const [validSignature, currentVersion] = await Promise.all([
    safeEqual(signature, await sign(payload, signingSecret, 'access-session')),
    accessPasscodeVersion(passcode),
  ])
  return validSignature && await safeEqual(parsed.passcodeVersion, currentVersion)
}

async function accessRateLimitKey(request: Request): Promise<string> {
  const address = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'local'
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(`${PROJECT_ID}:access-rate:${address}`),
  ))
  return `__access:rate:${bytesToBase64Url(digest).slice(0, 24)}`
}

async function readAccessRateLimit(
  request: Request,
  env: Env,
): Promise<{ key: string; attempts: number; resetAt: number }> {
  const key = await accessRateLimitKey(request)
  const now = Math.floor(Date.now() / 1000)
  const raw = await env.CACHE.get(key)
  if (!raw) return { key, attempts: 0, resetAt: now + ACCESS_RATE_LIMIT_SECONDS }
  try {
    const parsed = JSON.parse(raw) as { attempts?: number; resetAt?: number }
    if (!parsed.resetAt || parsed.resetAt <= now) {
      return { key, attempts: 0, resetAt: now + ACCESS_RATE_LIMIT_SECONDS }
    }
    return {
      key,
      attempts: Math.max(0, Number(parsed.attempts) || 0),
      resetAt: parsed.resetAt,
    }
  } catch {
    return { key, attempts: 0, resetAt: now + ACCESS_RATE_LIMIT_SECONDS }
  }
}

async function recordAccessFailure(
  env: Env,
  rate: { key: string; attempts: number; resetAt: number },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const expirationTtl = Math.max(60, rate.resetAt - now + 30)
  await env.CACHE.put(
    rate.key,
    JSON.stringify({ attempts: rate.attempts + 1, resetAt: rate.resetAt }),
    { expirationTtl },
  )
}

function accessConfiguration(runtimeEnv: Env, sourceEnv: Env): {
  configured: boolean
  ready: boolean
  passcode: string
  signingSecret: string
} {
  const passcode = runtimeEnv.ACCESS_PASSCODE?.trim() ?? ''
  const signingSecret = sourceEnv.ADMIN_SETTINGS_PASSWORD ?? ''
  return {
    configured: /^\d{6}$/.test(passcode),
    ready: /^\d{6}$/.test(passcode) && Boolean(signingSecret),
    passcode,
    signingSecret,
  }
}

export function isArticleAccessPath(pathname: string): boolean {
  return pathname === '/api/access/status'
    || pathname === '/api/access/login'
    || pathname === '/api/access/logout'
}

export function isArticleAccessPagePath(pathname: string): boolean {
  return pathname === '/access'
    || pathname === '/access/'
    || pathname === '/access.html'
    || pathname === '/access.css'
    || pathname === '/access.js'
}

export function isArticleAccessProtectedPath(pathname: string): boolean {
  return pathname === '/'
    || pathname === '/index.html'
    || pathname.startsWith('/api/')
}

export async function handleArticleAccess(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request)) return accessJson({ error: 'cross-site request rejected' }, 403)
  const url = new URL(request.url)
  const runtimeEnv = await resolveRuntimeEnv(env)
  const configuration = accessConfiguration(runtimeEnv, env)

  if (url.pathname === '/api/access/status') {
    if (request.method !== 'GET') return accessJson({ error: 'method not allowed' }, 405)
    const authenticated = configuration.ready
      ? await isAccessAuthenticated(request, configuration.signingSecret, configuration.passcode)
      : false
    return accessJson({
      configured: configuration.configured,
      ready: configuration.ready,
      authenticated,
    })
  }

  if (url.pathname === '/api/access/logout') {
    if (request.method !== 'POST') return accessJson({ error: 'method not allowed' }, 405)
    return accessJson(
      { authenticated: false },
      200,
      { 'Set-Cookie': sessionCookie(request, '', 0, ACCESS_COOKIE_NAME) },
    )
  }

  if (url.pathname !== '/api/access/login') return accessJson({ error: 'not found' }, 404)
  if (request.method !== 'POST') return accessJson({ error: 'method not allowed' }, 405)
  if (!configuration.configured) {
    return accessJson({ error: 'Access passcode is not configured. Open /settings as an administrator.' }, 503)
  }
  if (!configuration.ready) {
    return accessJson({ error: 'ADMIN_SETTINGS_PASSWORD is required to sign access sessions.' }, 503)
  }

  const rate = await readAccessRateLimit(request, env)
  const now = Math.floor(Date.now() / 1000)
  if (rate.attempts >= ACCESS_RATE_LIMIT_ATTEMPTS && rate.resetAt > now) {
    const retryAfter = Math.max(1, rate.resetAt - now)
    return accessJson(
      { error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).` },
      429,
      { 'Retry-After': String(retryAfter) },
    )
  }

  let supplied = ''
  try {
    const body = await request.json() as { passcode?: unknown }
    supplied = typeof body.passcode === 'string' ? body.passcode.trim() : ''
  } catch {
    return accessJson({ error: 'invalid JSON body' }, 400)
  }
  if (!/^\d{6}$/.test(supplied)) {
    await recordAccessFailure(env, rate)
    return accessJson({ error: 'Enter the 6-digit access passcode.' }, 401)
  }
  if (!await safeEqual(supplied, configuration.passcode)) {
    await recordAccessFailure(env, rate)
    return accessJson({ error: 'Incorrect access passcode.' }, 401)
  }

  await env.CACHE.delete(rate.key)
  const token = await makeAccessSession(configuration.signingSecret, configuration.passcode)
  return accessJson(
    { authenticated: true, expires_in: ACCESS_SESSION_TTL_SECONDS },
    200,
    { 'Set-Cookie': sessionCookie(request, token, ACCESS_SESSION_TTL_SECONDS, ACCESS_COOKIE_NAME) },
  )
}

function accessRedirect(request: Request): Response {
  const url = new URL(request.url)
  const next = `${url.pathname}${url.search}`
  const login = new URL('/access', url)
  login.searchParams.set('next', next)
  return new Response(null, {
    status: 302,
    headers: {
      Location: login.toString(),
      'Cache-Control': 'no-store',
      Vary: 'Cookie',
    },
  })
}

export async function guardArticleAccess(request: Request, env: Env): Promise<ArticleAccessGuard> {
  const runtimeEnv = await resolveRuntimeEnv(env)
  const configuration = accessConfiguration(runtimeEnv, env)
  const authenticated = configuration.ready
    ? await isAccessAuthenticated(request, configuration.signingSecret, configuration.passcode)
    : false
  if (authenticated) return { runtimeEnv }

  const url = new URL(request.url)
  if (url.pathname.startsWith('/api/')) {
    return {
      runtimeEnv,
      response: accessJson({
        error: configuration.configured
          ? 'Article Lens access passcode required.'
          : 'Article Lens access passcode is not configured.',
        code: configuration.configured ? 'ACCESS_REQUIRED' : 'ACCESS_NOT_CONFIGURED',
      }, configuration.configured ? 401 : 503),
    }
  }
  return { runtimeEnv, response: accessRedirect(request) }
}
