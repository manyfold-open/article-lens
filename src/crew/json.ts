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
