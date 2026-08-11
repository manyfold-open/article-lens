/**
 * Symmetric primitives shared by the admin settings store and the Manyfold
 * credential store.
 *
 * Every key is derived as SHA-256("article-lens:<purpose>:<password>"), so a
 * purpose string is part of the key material: settings ciphertext can never be
 * decrypted with the connect key, and a signed session token can never be
 * replayed against a different purpose. The purpose strings are load-bearing —
 * changing one makes every record written under the old string unreadable.
 *
 * `ADMIN_SETTINGS_PASSWORD` is the only password in this app, which means
 * rotating it invalidates saved settings *and* stored agent credentials. That
 * is documented behaviour, not an accident: without the password there is no
 * key, so there is nothing that could have kept them readable.
 */

const PROJECT_ID = 'article-lens'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export async function deriveBytes(password: string, purpose: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', textEncoder.encode(`${PROJECT_ID}:${purpose}:${password}`))
}

export async function sign(value: string, password: string, purpose = 'session'): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, purpose),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, textEncoder.encode(value))))
}

/** Constant-time-ish compare: hashes both sides first so length never leaks. */
export async function safeEqual(left: string, right: string): Promise<boolean> {
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

/** AES-GCM seal with a fresh 12-byte IV. Returns a self-describing envelope. */
export async function seal(value: unknown, password: string, purpose: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, purpose),
    'AES-GCM',
    false,
    ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(JSON.stringify(value)),
  )
  return JSON.stringify({
    v: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encrypted)),
  })
}

/**
 * Reverse of `seal`. Throws on a malformed envelope, a wrong key, or a tampered
 * ciphertext (AES-GCM authenticates). Callers validate the decoded shape
 * themselves — this layer only guarantees the bytes are authentic.
 */
export async function unseal<T>(raw: string, password: string, purpose: string): Promise<T> {
  const envelope = JSON.parse(raw) as { v?: number; iv?: string; ciphertext?: string }
  if (envelope.v !== 1 || !envelope.iv || !envelope.ciphertext) {
    throw new Error('unsupported envelope format')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    await deriveBytes(password, purpose),
    'AES-GCM',
    false,
    ['decrypt'],
  )
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64UrlToBytes(envelope.iv) },
    key,
    base64UrlToBytes(envelope.ciphertext),
  )
  return JSON.parse(textDecoder.decode(decrypted)) as T
}
