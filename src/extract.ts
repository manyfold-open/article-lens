import type { HNItem, ItemType } from './schema'

const MAX_TEXT = 18_000
const MIN_MAIN_TEXT = 450

export function detectItemType(item: HNItem): ItemType {
  const title = item.title ?? ''
  if (title.startsWith('Ask HN:')) return 'ask'
  if (title.startsWith('Show HN:')) return 'show'
  if (!item.url) return 'ask'
  try {
    const url = new URL(item.url)
    if (url.pathname.toLowerCase().endsWith('.pdf')) return 'pdf'
  } catch { /* invalid url */ }
  return 'article'
}

export async function extractArticle(
  url: string,
  hnItem: HNItem
): Promise<{ text: string; paywalled: boolean }> {
  // Self-hosted or Ask/Show HN → use the item's own text
  if (!url || url.includes('news.ycombinator.com')) {
    return { text: stripHtml(hnItem.text ?? ''), paywalled: false }
  }

  // PDF: no extraction in Worker
  if (url.toLowerCase().endsWith('.pdf')) {
    return { text: '', paywalled: true }
  }

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HNLens/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })

    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/pdf')) return { text: '', paywalled: true }

    if (!res.ok) return { text: '', paywalled: true }

    const html = await res.text()
    if (isPaywalled(html)) return { text: '', paywalled: true }

    return { text: extractReadableText(html).slice(0, MAX_TEXT), paywalled: false }
  } catch {
    return { text: '', paywalled: true }
  }
}

// Fetch any article URL directly (not via HN) and pull readable text + title.
export async function extractFromUrl(
  url: string
): Promise<{ text: string; title: string; paywalled: boolean }> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HNLens/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    })
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/pdf')) return { text: '', title: '', paywalled: true }
    if (!res.ok) return { text: '', title: '', paywalled: true }
    const html = await res.text()
    const title = extractTitle(html)
    if (isPaywalled(html)) return { text: '', title, paywalled: true }
    return { text: extractReadableText(html).slice(0, MAX_TEXT), title, paywalled: false }
  } catch {
    return { text: '', title: '', paywalled: true }
  }
}

function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
  if (og) return decodeEntities(og[1]).trim()
  const t = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return t ? decodeEntities(t[1]).trim() : ''
}

function isPaywalled(html: string): boolean {
  const lower = html.toLowerCase()
  return [
    'subscribe to continue', 'subscribe to read', 'sign in to read',
    'log in to read', 'login to read', 'register to continue',
    'create an account to', 'create a free account to continue',
    'already a subscriber', 'become a subscriber',
    'for subscribers only', 'subscriber-only', 'subscriber only',
    'subscribers only', 'members-only', 'members only',
    'premium content', 'premium article', 'exclusive content',
    'paywall', 'metered-paywall', 'metered paywall', 'hard-paywall',
    'data-paywall', 'subscription-wall', 'article-gate',
    'continue reading your', 'continue reading with', 'to continue reading',
    'unlock this article', 'this article is for subscribers',
    'this content is for subscribers', 'you have reached your free article limit',
  ].some(s => lower.includes(s))
}

function extractReadableText(html: string): string {
  return extractText(isolateMain(stripDocumentNoise(html)))
}

// Isolate the main article body so we read the actual content, not site
// chrome (nav, table-of-contents, related posts, comment widgets). Scores
// article/main/role=main/content-like blocks and falls back to the document.
function isolateMain(html: string): string {
  const candidates: Array<{ body: string; score: number; textLen: number }> = []
  collectCandidates(html, /<(article|main)\b([^>]*)>([\s\S]*?)<\/\1>/gi, candidates)
  collectCandidates(html, /<(section|div)\b([^>]*)>([\s\S]*?)<\/\1>/gi, candidates)

  const best = candidates
    .filter(c => c.textLen >= MIN_MAIN_TEXT)
    .sort((a, b) => b.score - a.score)[0]
  return best && best.score > 0 ? best.body : html
}

function collectCandidates(
  html: string,
  re: RegExp,
  out: Array<{ body: string; score: number; textLen: number }>
): void {
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase()
    const attrs = m[2] ?? ''
    const body = m[3] ?? ''
    if (!body || isNoiseAttrs(attrs)) continue
    if ((tag === 'div' || tag === 'section') && !isMainAttrs(attrs)) continue
    const textLen = extractText(body).length
    out.push({ body, textLen, score: scoreCandidate(tag, attrs, body, textLen) })
  }
}

function scoreCandidate(tag: string, attrs: string, body: string, textLen: number): number {
  if (textLen < 200) return -100

  const linkDensity = linkTextLength(body) / Math.max(textLen, 1)
  const paragraphCount = (body.match(/<(p|li|blockquote|pre)\b/gi) ?? []).length
  const headingCount = (body.match(/<h[1-6]\b/gi) ?? []).length
  const positive = scoreAttrs(attrs, POSITIVE_ATTR_RE) * 120
  const negative = scoreAttrs(attrs, NOISE_ATTR_RE) * 180
  const tagBonus = tag === 'article' ? 260 : tag === 'main' ? 220 : 0
  const textScore = Math.min(textLen, 10_000) / 12

  return tagBonus + positive + textScore + paragraphCount * 45 + headingCount * 20
    - negative - linkDensity * 900
}

function stripDocumentNoise(html: string): string {
  let out = html
    .replace(/<!doctype[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|dialog)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(button|select|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')

  out = stripAttrNoise(out)
  for (let i = 0; i < 3; i++) {
    out = out.replace(
      /<(?!html\b|body\b|head\b|main\b|article\b)([a-z][a-z0-9:-]*)\b([^>]*)>[\s\S]*?<\/\1>/gi,
      (m, _tag, attrs) => isNoiseAttrs(attrs) ? ' ' : m
    )
  }

  return out
}

function stripAttrNoise(html: string): string {
  return html.replace(
    /<(?!html\b|body\b|head\b|main\b|article\b)([a-z][a-z0-9:-]*)\b([^>]*(?:class|id|role|itemprop|aria-label)\s*=\s*["'](?:[^"']*[\s_-])?(?:ad|advert|advertisement|aside|banner|bio|breadcrumb|carousel|comment|comments|community|cookie|footer|header|hidden|masthead|menu|modal|nav|newsletter|paywall|promo|rail|recommend|recommended|related|reply|share|sidebar|signin|signup|smallhead|social|sponsor|sponsored|subscribe|subscription|toc|toolbar|topbar|widget)(?=["'\s_-])[^"']*["'][^>]*)>[\s\S]*?<\/\1>/gi,
    ' '
  )
}

function extractText(html: string): string {
  const text = decodeEntities(
    stripDocumentNoise(html)
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|section|article|main)>/gi, '\n')
      .replace(/<(p|div|li|h[1-6]|blockquote|pre|tr|section|article|main)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/¶/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return dedupeAdjacentLines(text)
}

const POSITIVE_ATTR_RE = /\b(article|articlebody|article-body|body|content|entry|entry-content|hentry|main|post|post-content|prose|story|text|writeup)\b/i
const NOISE_ATTR_RE = /\b(ad|advert|advertisement|aside|banner|bio|breadcrumb|byline|caption|carousel|comment|comments|community|cookie|drawer|footer|header|hero|hidden|masthead|menu|modal|nav|newsletter|paywall|promo|rail|recommend|recommended|related|reply|share|sidebar|signin|signup|smallhead|social|sponsor|sponsored|subscribe|subscription|tag|toc|toolbar|topbar|widget)\b/i

function isMainAttrs(attrs: string): boolean {
  return /\brole\s*=\s*["']?main\b/i.test(attrs) || POSITIVE_ATTR_RE.test(attrSignal(attrs))
}

function isNoiseAttrs(attrs: string): boolean {
  const signal = attrSignal(attrs)
  return /\b(aria-hidden|hidden)\b/i.test(attrs)
    || /\brole\s*=\s*["']?(banner|complementary|contentinfo|navigation|search)\b/i.test(attrs)
    || NOISE_ATTR_RE.test(signal)
}

function attrSignal(attrs: string): string {
  return attrs
    .replace(/\b(class|id|role|itemprop|aria-label)\s*=\s*(['"])(.*?)\2/gi, ' $3 ')
    .replace(/[^a-z0-9_-]+/gi, ' ')
}

function scoreAttrs(attrs: string, re: RegExp): number {
  const hits = attrSignal(attrs).match(re)
  return hits ? hits.length : 0
}

function linkTextLength(html: string): number {
  let len = 0
  let m: RegExpExecArray | null
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi
  while ((m = re.exec(html)) !== null) len += extractText(m[1]).length
  return len
}

function dedupeAdjacentLines(text: string): string {
  const out: string[] = []
  let previousNonEmpty = ''
  for (const line of text.split('\n')) {
    const current = line.trim()
    if (current && previousNonEmpty && current.toLowerCase() === previousNonEmpty) continue
    out.push(line)
    if (current) previousNonEmpty = current.toLowerCase()
  }
  return out.join('\n').trim()
}

export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

// Decode the HTML entities commonly seen in HN/article text.
function decodeEntities(s: string): string {
  const NAMED: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
    rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
    sbquo: '‚', bdquo: '„', prime: '′', Prime: '″',
    laquo: '«', raquo: '»', mdash: '—', ndash: '–',
    hellip: '…', middot: '·', bull: '•', shy: '',
    times: '×', divide: '÷', plusmn: '±', deg: '°',
    trade: '™', reg: '®', copy: '©',
    euro: '€', pound: '£', yen: '¥', cent: '¢',
    sect: '§', para: '¶',
  }
  return s
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => safeCp(parseInt(d, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);?/g, (m, name) => {
      const hit = NAMED[name] ?? NAMED[name.toLowerCase()]
      return hit ?? m
    })
}

function safeCp(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return ''
  const cp1252: Record<number, number> = {
    128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e,
    133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6,
    137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152,
    142: 0x017d, 145: 0x2018, 146: 0x2019, 147: 0x201c,
    148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014,
    152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a,
    156: 0x0153, 158: 0x017e, 159: 0x0178,
  }
  const normalized = cp1252[cp] ?? cp
  if (normalized >= 0xd800 && normalized <= 0xdfff) return ''
  try { return String.fromCodePoint(normalized) } catch { return '' }
}
