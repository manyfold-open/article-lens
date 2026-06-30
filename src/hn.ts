import type { HNItem, HNComment } from './schema'

const ALGOLIA = 'https://hn.algolia.com/api/v1'

export async function fetchHNItem(id: number): Promise<HNItem> {
  const res = await fetch(`${ALGOLIA}/items/${id}`)
  if (!res.ok) throw new Error(`HN fetch failed: ${res.status}`)
  return res.json() as Promise<HNItem>
}

export async function fetchFrontPage(): Promise<HNItem[]> {
  const res = await fetch(`${ALGOLIA}/search?tags=front_page&hitsPerPage=20`)
  if (!res.ok) throw new Error(`Front page fetch failed: ${res.status}`)
  const data = await res.json() as { hits: HNItem[] }
  return data.hits
}

// Returns top-level comment subtrees, each as a flat array (top comment + all descendants)
export function getSubtrees(item: HNItem): HNComment[][] {
  return (item.children ?? [])
    .filter(c => c.text && c.text.trim().length > 0)
    .map(c => flattenSubtree(c))
}

function flattenSubtree(comment: HNComment): HNComment[] {
  const result: HNComment[] = [{ ...comment, children: [] }]
  for (const child of comment.children ?? []) {
    result.push(...flattenSubtree(child))
  }
  return result
}

export function flattenComments(item: HNItem): HNComment[] {
  return (item.children ?? []).flatMap(c => flattenSubtree(c))
}

// Extracts item id from HN URLs or plain numbers
export function parseHNUrl(input: string): number | null {
  input = input.trim()
  if (/^\d+$/.test(input)) return parseInt(input, 10)
  try {
    const url = new URL(input)
    if (url.hostname.includes('ycombinator.com')) {
      const id = url.searchParams.get('id')
      if (id && /^\d+$/.test(id)) return parseInt(id, 10)
    }
  } catch { /* not a URL */ }
  const m = input.match(/[?&]id=(\d+)/)
  if (m) return parseInt(m[1], 10)
  return null
}

// Find the HN story (if any) that links to this article URL, so a bare article
// URL can pick up its discussion thread. Returns the best match or null.
export async function searchHNByUrl(articleUrl: string): Promise<{ id: number; num_comments: number } | null> {
  try {
    const q = encodeURIComponent(articleUrl)
    const res = await fetch(`${ALGOLIA}/search?query=${q}&restrictSearchableAttributes=url&tags=story&hitsPerPage=5`)
    if (!res.ok) return null
    const data = await res.json() as { hits?: Array<{ objectID: string; url?: string; num_comments?: number }> }
    const hits = data.hits ?? []
    if (!hits.length) return null
    const norm = (u?: string) => (u || '').replace(/\/+$/, '').toLowerCase()
    const exact = hits.filter(h => norm(h.url) === norm(articleUrl))
    const pool = (exact.length ? exact : hits).slice()
    pool.sort((a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0))
    const id = parseInt(pool[0].objectID, 10)
    return isNaN(id) ? null : { id, num_comments: pool[0].num_comments ?? 0 }
  } catch {
    return null
  }
}

export function ageString(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 3600)  return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
