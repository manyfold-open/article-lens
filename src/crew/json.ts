import type { UnparseableKind } from '../schema'

// ── Lenient JSON parsing for LLM output ───────────────────────────
// Small models frequently emit JSON wrapped in ```fences``` and — worst of
// all — unescaped ASCII double-quotes *inside* string values, especially in
// Chinese text like 与"开源"有别. Strict JSON.parse throws on those. We try a
// strict parse first, then a targeted repair, before giving up.

export function extractJSON(text: string): string {
  // Prefer a fenced ```json ... ``` block when present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fence ? fence[1] : text
  const m = body.match(/[\[{][\s\S]*[\]}]/)
  return (m ? m[0] : body).trim()
}

// Escape any ASCII double-quote that sits *between* two word/CJK characters —
// these are almost always stray inner quotes, not string delimiters. A real
// delimiter is adjacent to structural context (`:`, `,`, `{`, `[`, `}`, `]`,
// whitespace, or string end), never letter-to-letter.
function repairInnerQuotes(s: string): string {
  return s.replace(/(?<=[\p{L}\p{N}）)】」』])"(?=[\p{L}\p{N}（(【「『])/gu, '\\"')
}

export function parseLoose<T>(text: string): T | null {
  const raw = extractJSON(text)
  try { return JSON.parse(raw) as T } catch { /* fall through to repair */ }
  try { return JSON.parse(repairInnerQuotes(raw)) as T } catch { return null }
}

// ── Why an output could not be parsed ─────────────────────────────
// parseLoose collapses every failure to null, but the two causes need different
// fixes: 'truncated' means the role wrote more than its output cap allowed, so
// the fix is to ask for less; 'not_json' means the prompt or format is not
// landing, so the fix is the prompt. Both look identical in the UI today, which
// is why a timeout and a cut-off response reach the reader as the same sentence.
export type { UnparseableKind } from '../schema'

// A JSON value that opened and never closed is a cut-off response. Counting
// brackets outside string literals is enough to tell that from prose, and it
// does not require the value to be otherwise valid.
function looksTruncated(raw: string): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (escaped) { escaped = false; continue }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return inString || depth > 0
}

export function classifyUnparseable(text: string): UnparseableKind | null {
  if (!text || !text.trim()) return 'empty'
  if (parseLoose<unknown>(text) !== null) return null
  // An unclosed ```json fence has no closing bracket to match, so extractJSON
  // hands back the opening fragment — still a cut-off response.
  const raw = extractJSON(text).replace(/^```(?:json)?\s*/i, '').trim()
  if (!/^[[{]/.test(raw)) return 'not_json'
  return looksTruncated(raw) ? 'truncated' : 'not_json'
}

// Thrown when every completed call returned output that could not be parsed.
// Distinct from a transport failure: the peer did answer, so reporting this as
// "did not respond in time" misattributes the cause.
export class UnparseableOutputError extends Error {
  constructor(
    readonly classification: UnparseableKind,
    readonly windows: { returned: number; parsed: number },
  ) {
    super(
      `Agent output could not be parsed (${classification}): `
      + `${windows.parsed}/${windows.returned} completed calls returned usable JSON.`,
    )
    this.name = 'UnparseableOutputError'
  }
}

export function isUnparseableOutputError(error: unknown): error is UnparseableOutputError {
  return error instanceof UnparseableOutputError
}
