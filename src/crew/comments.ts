import type { HNComment, HNItem } from '../schema'
// Explicit extension so `node --experimental-transform-types` can load this
// module directly from tests/comment-selection.test.js.
import { stripHtml } from '../extract.ts'

// Rough token estimate: ~4 chars/token for mixed en, ~1.7 for CJK. Use a
// conservative blended 2.5 chars/token so we budget by tokens, not raw chars.
const CHARS_PER_TOKEN = 2.5
const tokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN)
// Per-comment excerpt cap. 小潛 needs the stance, not the whole essay.
const COMMENT_TEXT_LIMIT = 400
// Deep replies keep their marker but stop indenting, so a 20-deep thread does
// not spend the budget on whitespace.
const MAX_INDENT_DEPTH = 3

interface ThreadNode {
  id: number
  author: string
  text: string
  depth: number
}

interface Thread {
  nodes: ThreadNode[]
  score: number
}

export interface CommentSelection {
  /** Ranked, thread-structured comment text for the reduce prompt. */
  text: string
  /** Comments actually included in `text`. */
  included: number
  /** Comments that had text to include. */
  total: number
  /** Threads represented in `text`. */
  threads: number
}

// Score a top-level comment thread by signal: the discussion it spawned
// (replies) + its own substance (length), with earlier (higher-ranked by HN)
// threads favoured via their original position.
function buildThreads(item: HNItem): Thread[] {
  const roots = (item.children ?? []).filter(c => stripHtml(c.text ?? '').trim().length > 0)
  return roots.map((root, index) => {
    const nodes: ThreadNode[] = []
    const walk = (comment: HNComment, depth: number): void => {
      const text = stripHtml(comment.text ?? '').trim()
      if (text) {
        nodes.push({ id: comment.id, author: comment.author ?? 'anon', text, depth })
      }
      for (const child of comment.children ?? []) walk(child, depth + 1)
    }
    walk(root, 0)
    const own = nodes[0]?.text.length ?? 0
    const replies = nodes.length - 1
    // position bonus: earlier top-level comments rank higher on HN
    const posBonus = Math.max(0, 30 - index) * 4
    return { nodes, score: own + replies * 60 + posBonus }
  })
}

function renderNode(node: ThreadNode): string {
  const excerpt = node.text.slice(0, COMMENT_TEXT_LIMIT)
  if (node.depth === 0) return `[id:${node.id}] ${node.author}: ${excerpt}`
  const indent = '  '.repeat(Math.min(node.depth, MAX_INDENT_DEPTH))
  return `${indent}↳ [id:${node.id}] ${node.author}: ${excerpt}`
}

// Fit the highest-signal discussion into `budgetTokens`, breadth before depth:
// first every selected thread's opening comment (so the distinct stances that
// become camps all survive), then replies thread by thread in signal order.
// Replies are taken as a DFS prefix, so a reply always ships with its parents.
function select(item: HNItem, budgetTokens: number): CommentSelection {
  const threads = buildThreads(item).sort((a, b) => b.score - a.score)
  const total = threads.reduce((sum, thread) => sum + thread.nodes.length, 0)
  const take = threads.map(() => 0)
  let used = 0
  let included = 0

  const fits = (node: ThreadNode): boolean => {
    const cost = tokens(renderNode(node))
    // Always admit the first line, even under an unusably small budget.
    if (included && used + cost > budgetTokens) return false
    used += cost
    included += 1
    return true
  }

  for (const [index, thread] of threads.entries()) {
    if (!fits(thread.nodes[0])) break
    take[index] = 1
  }
  for (const [index, thread] of threads.entries()) {
    if (!take[index]) break
    while (take[index] < thread.nodes.length) {
      if (!fits(thread.nodes[take[index]])) return render(threads, take, included, total)
      take[index] += 1
    }
  }
  return render(threads, take, included, total)
}

function render(threads: Thread[], take: number[], included: number, total: number): CommentSelection {
  const blocks: string[] = []
  for (const [index, thread] of threads.entries()) {
    if (!take[index]) continue
    blocks.push(thread.nodes.slice(0, take[index]).map(renderNode).join('\n'))
  }
  return { text: blocks.join('\n\n'), included, total, threads: blocks.length }
}

// The same item is selected for the prompt, for the sampling flag, and for the
// provenance reason within one run. Memoize so all three agree by construction.
const cache = new WeakMap<HNItem, Map<number, CommentSelection>>()

export function selectComments(item: HNItem, budgetTokens: number): CommentSelection {
  let byBudget = cache.get(item)
  if (!byBudget) {
    byBudget = new Map()
    cache.set(item, byBudget)
  }
  const hit = byBudget.get(budgetTokens)
  if (hit) return hit
  const selection = select(item, budgetTokens)
  byBudget.set(budgetTokens, selection)
  return selection
}

// True when the budget forced us to leave comments out, i.e. the report is
// based on a sample. Drives the "留言採樣" badge and trust line.
export function commentsWereSampled(item: HNItem, budgetTokens: number): boolean {
  const selection = selectComments(item, budgetTokens)
  return selection.total > 0 && selection.included < selection.total
}
