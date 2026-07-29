// ── Mock analysis adapter ─────────────────────────────────────────
// A clean, dependency-free fallback that keeps the UI and Worker fully
// functional when no Manyfold token is configured (or a real agent call
// fails). It works from the REAL fetched HN data — title, article text,
// and the actual comment thread — so every section renders meaningfully
// and links back to real HN comments.
//
// The hero feature (jargon) is powered by an authored, genuinely bilingual
// plain-language glossary, so explanations are correct and non-circular for
// the most common HN/tech terms, with a graceful template for unknown ones.

import type {
  HNItem, HNComment, ItemType, HNLensResult, JargonTerm, BiStr, Camp,
} from '../schema'
import { stripHtml } from '../extract'

// ── Authored bilingual glossary ───────────────────────────────────
interface GlossaryEntry {
  term: string
  zh_term: string
  en: string
  zh: string
  /** extra spellings/aliases to match in text (besides `term`) */
  aliases?: string[]
  /** match case-insensitively (names) vs exact word (acronyms) */
  ci?: boolean
}

const GLOSSARY: GlossaryEntry[] = [
  // ── Vectors / search / AI ──
  { term: 'pgvector', ci: true, zh_term: 'PostgreSQL 向量扩充套件',
    en: 'A free add-on for the PostgreSQL database that lets it store and search lists of numbers (the kind AI models use to represent meaning) without running a separate service.',
    zh: 'PostgreSQL 数据库的免费插件，让你直接在一般数据库里存储与搜索「向量」（AI 模型用来表示语义的一串数字），不必另外架一套专门服务。' },
  { term: 'Pinecone', ci: true, zh_term: 'Pinecone（向量数据库云端服务）',
    en: 'A hosted cloud service built only for storing and searching vectors. Convenient, but you pay a fixed monthly fee to keep it running whether you use it or not.',
    zh: '一个专门用来存放与搜索向量的云端托管服务。好处是省事，坏处是每月固定收费，不论你用不用都要付。' },
  { term: 'vector database', ci: true, zh_term: '向量数据库', aliases: ['vector db', 'vector store'],
    en: 'A database tuned to find items whose meaning is "closest" to a query, rather than matching exact keywords — the backbone of AI search and recommendations.',
    zh: '一种专门用来找「语义最接近」的数据库，而不是比对关键字字面，是 AI 搜索与推荐的核心。' },
  { term: 'embedding', ci: true, zh_term: '嵌入向量', aliases: ['embeddings'],
    en: 'A list of numbers an AI model produces to capture the meaning of a piece of text or an image, so a computer can compare meanings mathematically.',
    zh: 'AI 模型把一段文字或图片转成的一串数字，用来代表它的「意思」，让电脑能用数学方式比较语义相近程度。' },
  { term: 'HNSW', zh_term: '阶层可导航小世界图（一种索引）',
    en: 'A way of organising vectors into a layered map so search can jump to the right neighbourhood fast, instead of comparing against every single item.',
    zh: '把向量组织成多层地图的索引方法：搜索时先跳到大概的「区域」再细找，比逐笔比对快得多。' },
  { term: 'ANN', zh_term: '近似最近邻搜索', aliases: ['approximate nearest neighbor', 'approximate nearest neighbour'],
    en: 'Search that returns results that are "close enough" instead of guaranteed-perfect, trading a tiny bit of accuracy for a huge speed-up.',
    zh: '不保证找到「最精准」答案、只求「够接近」的搜索；用一点点准确度换取大幅的速度提升。' },
  { term: 'RAG', zh_term: '检索增强生成', aliases: ['retrieval augmented generation', 'retrieval-augmented generation'],
    en: 'A trick where an AI first looks up relevant documents and then writes its answer using them, so it can cite real facts instead of guessing.',
    zh: '一种做法：AI 先检索相关文件，再根据文件内容作答，让它引用真实资料而非凭空编造。' },
  { term: 'LLM', zh_term: '大型语言模型', aliases: ['large language model'],
    en: 'A program trained on huge amounts of text that predicts the next words, which lets it answer questions, write, and summarise.',
    zh: '用海量文字训练、会预测下一个字的程序；因此能回答问题、写作与摘要，例如 ChatGPT 背后的模型。' },
  { term: 'recall', ci: true, zh_term: '召回率', aliases: ['recall@10', 'recall@k'],
    en: 'A score for search quality: of all the truly best matches, what fraction did the system actually return? 0.95 means it found 95% of them.',
    zh: '衡量搜索质量的指标：真正该找到的最佳结果中，系统实际找回了多少比例。0.95 代表找回了 95%。' },
  { term: 'token', ci: true, zh_term: '词元（token）', aliases: ['tokens'],
    en: 'The small chunk of text (roughly a word piece) that language models read and count one at a time — pricing and limits are usually measured in tokens.',
    zh: '语言模型逐一读取与计算的小文字片段（大约是一个词或词的一部分）；计费与长度上限通常以词元数计算。' },
  { term: 'fine-tuning', ci: true, zh_term: '微调', aliases: ['fine tuning', 'finetune', 'fine-tune'],
    en: 'Taking an already-trained AI model and training it a bit more on your own examples so it behaves the way you want.',
    zh: '拿一个已经训练好的 AI 模型，再用你自己的范例多训练一点，让它的行为更符合你的需求。' },
  { term: 'quantization', ci: true, zh_term: '量化', aliases: ['quantized', 'quantisation'],
    en: 'Shrinking an AI model by storing its numbers with less precision, so it runs on cheaper hardware with only a small quality drop.',
    zh: '用较低精度存储模型的数字来缩小模型，使它能在更便宜的硬件上跑，且质量只略微下降。' },

  // ── Infra / devops ──
  { term: 'Kubernetes', ci: true, zh_term: 'Kubernetes（容器调度系统）', aliases: ['k8s'],
    en: 'A system that automatically runs, restarts, and spreads your app across many servers so it stays up under load.',
    zh: '自动部署、重启并把应用分散到多台服务器的系统，让服务在高负载下仍维持运作。' },
  { term: 'Docker', ci: true, zh_term: 'Docker（容器化工具）',
    en: 'A tool that packages an app with everything it needs into a "container" that runs the same way on any machine.',
    zh: '把应用程序和它所需的一切打包成「容器」的工具，让它在任何机器上都能一致地执行。' },
  { term: 'serverless', ci: true, zh_term: '无服务器运算',
    en: 'Running code without managing servers yourself — the platform spins it up on demand and you pay only for what runs.',
    zh: '不必自己管理服务器的运算方式：平台依需求启动你的程序，按实际执行量计费。' },
  { term: 'Redis', ci: true, zh_term: 'Redis（内存数据库）',
    en: 'A very fast database that keeps data in memory, commonly used as a cache to avoid repeating slow work.',
    zh: '把资料放在内存中的高速数据库，常被当作缓存，避免重复执行缓慢的运算。' },
  { term: 'Postgres', ci: true, zh_term: 'PostgreSQL（关系型数据库）', aliases: ['PostgreSQL'],
    en: 'A popular free database for storing structured data in tables, known for being reliable and feature-rich.',
    zh: '热门的免费关系型数据库，用表格存储结构化数据，以稳定与功能丰富著称。' },
  { term: 'RDS', zh_term: 'AWS RDS（托管数据库服务）',
    en: 'Amazon\'s service that runs and maintains a database for you, handling backups and updates so you don\'t have to.',
    zh: 'Amazon 提供的托管数据库服务，帮你执行与维护数据库，自动处理备份与更新。' },
  { term: 'p99', zh_term: 'p99 延迟（第 99 百分位）', aliases: ['p95', 'p50', 'tail latency'],
    en: 'A "worst realistic case" speed measure: the response time that 99% of requests beat. It shows how slow your unluckiest users feel.',
    zh: '一种「实际最差情况」的速度指标：99% 的请求都比这个时间快。它反映最不幸用户的等待感受。' },
  { term: 'latency', ci: true, zh_term: '延迟',
    en: 'How long you wait between asking for something and getting a response — lower is faster.',
    zh: '从你发出请求到收到回应之间的等待时间，数字越低代表越快。' },
  { term: 'throughput', ci: true, zh_term: '吞吐量',
    en: 'How much work a system handles per second — higher means it can serve more requests at once.',
    zh: '系统每秒能处理的工作量，数字越高代表能同时服务越多请求。' },
  { term: 'CDN', zh_term: '内容传递网络',
    en: 'A network of servers spread around the world that keeps copies of your files close to users so pages load faster.',
    zh: '遍布全球的服务器网络，把你的文件副本放在离用户近的地方，让网页加载更快。' },

  // ── Languages / runtimes ──
  { term: 'Rust', ci: true, zh_term: 'Rust（程序语言）',
    en: 'A programming language designed for speed and safety: it catches whole classes of memory bugs before the program ever runs.',
    zh: '一种兼顾性能与安全的程序语言：能在程序执行前就拦截整类内存错误。' },
  { term: 'Go', zh_term: 'Go / Golang（程序语言）', aliases: ['Golang'],
    en: 'A programming language from Google built for simple, fast server software and easy handling of many tasks at once.',
    zh: 'Google 推出的程序语言，主打简洁、快速的服务器程序，并能轻松同时处理大量任务。' },
  { term: 'WASM', zh_term: 'WebAssembly', aliases: ['WebAssembly'],
    en: 'A compact format that lets code written in languages like Rust or C run inside the browser at near-native speed.',
    zh: '一种精简的格式，让 Rust、C 等语言写的程序能在浏览器中以接近原生的速度执行。' },
  { term: 'borrow checker', ci: true, zh_term: '借用检查器（Rust）',
    en: 'The part of the Rust compiler that enforces who is allowed to read or change each piece of data, preventing memory bugs.',
    zh: 'Rust 编译器中负责管控「谁能读写每块资料」的机制，用来防止内存错误。' },
  { term: 'garbage collection', ci: true, zh_term: '垃圾回收', aliases: ['garbage collector', 'GC'],
    en: 'An automatic cleanup system that frees memory the program no longer needs, so developers don\'t have to track it by hand.',
    zh: '自动清理机制，会释放程序不再需要的内存，让开发者不必手动管理。' },

  // ── Web / data ──
  { term: 'BM25', zh_term: 'BM25（全文搜索排序演算法）',
    en: 'A classic formula for ranking text search results by keyword relevance — the proven workhorse behind traditional full-text search.',
    zh: '依关键字相关度为文字搜索结果排序的经典公式，是传统全文搜索背后成熟可靠的主力演算法。' },
  { term: 'GraphQL', ci: true, zh_term: 'GraphQL（API 查询语言）',
    en: 'A way to ask a server for exactly the data fields you want in one request, instead of calling many fixed endpoints.',
    zh: '一种 API 查询方式：在一次请求中向服务器精确指定你要的栏位，而非调用多个固定端点。' },
  { term: 'SSE', zh_term: '服务器发送事件', aliases: ['server-sent events'],
    en: 'A simple way for a server to keep pushing live updates to the browser over one long-lived connection.',
    zh: '一种简单机制，让服务器透过单一长连线持续把即时更新推送到浏览器。' },
  { term: 'WebSocket', ci: true, zh_term: 'WebSocket（双向即时连线）', aliases: ['websockets'],
    en: 'A two-way live connection between browser and server, used for chat, games, and anything needing instant back-and-forth.',
    zh: '浏览器与服务器之间的双向即时连线，用于聊天、游戏等需要即时来回的场景。' },
  { term: 'JWT', zh_term: 'JSON Web Token（凭证）',
    en: 'A signed, tamper-evident token a server hands a user to prove who they are on later requests, without re-checking a database each time.',
    zh: '服务器发给用户、带签章且可验真伪的凭证；之后的请求靠它证明身分，不必每次都查数据库。' },
  { term: 'CRDT', zh_term: '无冲突复制资料型别',
    en: 'A data structure that lets many people edit the same document offline and merges everyone\'s changes automatically without conflicts.',
    zh: '一种资料结构，让多人离线编辑同一份文件后，能自动合并彼此的修改且不产生冲突。' },
  { term: 'SQLite', ci: true, zh_term: 'SQLite（嵌入式数据库）',
    en: 'A tiny database that lives in a single file inside your app — no server to run, great for local or embedded use.',
    zh: '存在单一文件中、嵌在应用程序里的小型数据库，不需架服务器，适合本机或嵌入式使用。' },

  // ── Security / general ──
  { term: 'zero-day', ci: true, zh_term: '零时差漏洞', aliases: ['0-day', 'zero day'],
    en: 'A security hole that attackers know about before the vendor does, so there is no fix available yet when it\'s first exploited.',
    zh: '攻击者比厂商更早得知的安全漏洞；被利用时尚无修补程序可用。' },
  { term: 'end-to-end encryption', ci: true, zh_term: '端对端加密', aliases: ['e2ee', 'end to end encryption'],
    en: 'Scrambling messages so only the sender and receiver can read them — not even the company running the service can.',
    zh: '把消息加密成只有寄件者与收件者能读的形式，连提供服务的公司也无法解读。' },
  { term: 'open source', ci: true, zh_term: '开源', aliases: ['open-source', 'FOSS', 'OSS'],
    en: 'Software whose source code is published for anyone to read, use, and modify, usually for free.',
    zh: '原始码公开、任何人都能阅读、使用与修改的软件，通常免费。' },
  { term: 'self-hosted', ci: true, zh_term: '自架（self-hosted）', aliases: ['self host', 'selfhost', 'self hosting'],
    en: 'Running software on your own servers instead of paying a company to host it for you — more control, more maintenance.',
    zh: '把软件跑在自己的服务器上，而非付费让厂商代管；掌控度更高，但维护负担也更大。' },
  { term: 'YAGNI', zh_term: 'YAGNI（你不会需要它）',
    en: '"You Aren\'t Gonna Need It" — advice not to build features for imagined future needs until they\'re actually required.',
    zh: '「你不会需要它」的缩写：劝你别为想像中的未来需求预先开发功能，等真正需要时再做。' },
  { term: 'technical debt', ci: true, zh_term: '技术债', aliases: ['tech debt'],
    en: 'The future cost of taking shortcuts in code today — like a loan you repay later with slower, harder changes.',
    zh: '今天为了省事而走捷径，未来要付出的代价；像借贷一样，日后得用更慢、更难改的程序码偿还。' },
  { term: 'idempotent', ci: true, zh_term: '幂等',
    en: 'An operation you can safely repeat and get the same result — running it twice does no extra harm.',
    zh: '可以安全重复执行、结果都相同的操作；做两次也不会造成额外影响。' },
  { term: 'eventual consistency', ci: true, zh_term: '最终一致性',
    en: 'A design where different copies of data may briefly disagree but are guaranteed to match up shortly after.',
    zh: '一种设计：不同副本的资料可能短暂不一致，但保证很快会趋于一致。' },
  { term: 'rate limit', ci: true, zh_term: '速率限制', aliases: ['rate-limiting', 'rate limiting'],
    en: 'A cap on how many requests you can make in a time window, used to stop abuse and keep a service stable.',
    zh: '在一段时间内限制你能发出的请求数量，用来防止滥用并维持服务稳定。' },
  { term: 'benchmark', ci: true, zh_term: '基准测试', aliases: ['benchmarks'],
    en: 'A standardised test that measures how fast or efficient something is, so different options can be compared fairly.',
    zh: '用标准化测试衡量某事物的速度或效率，以便公平比较不同方案。' },
  { term: 'API', zh_term: '应用程序界面',
    en: 'A defined set of requests one program can send to another to ask for data or actions — the contract between software pieces.',
    zh: '一个程序能向另一个程序发出的、用来索取资料或执行动作的标准请求集合，是软件之间的「合约」。' },
  { term: 'cache', ci: true, zh_term: '缓存', aliases: ['caching'],
    en: 'A stash of already-computed answers kept close at hand so repeated work can be skipped and things load faster.',
    zh: '把已经算好的结果暂存在手边，避免重复运算、加快加载速度的机制。' },
]

// ── Acronym stoplist (too common / not jargon) ───────────────────
const ACRONYM_STOP = new Set([
  'HN', 'US', 'UK', 'EU', 'OK', 'FAQ', 'CEO', 'CTO', 'USA', 'PM', 'AM',
  'TV', 'PC', 'OS', 'IT', 'ID', 'URL', 'HTML', 'CSS', 'PDF', 'FYI',
  'TLDR', 'TLDR;', 'IMO', 'IMHO', 'AKA', 'ETC', 'VS', 'AI', 'ML',
  'AD', 'BC', 'BCE', 'CE', 'NO', 'SO', 'IF', 'OR', 'AND', 'THE', 'A',
  'I', 'A.D', 'B.C', 'GDP', 'CPU', 'GPU', 'RAM', 'USD', 'EUR', 'GBP',
])

// ── Public: build a full mock result ──────────────────────────────
export function buildMockResult(
  item: HNItem,
  articleText: string,
  itemType: ItemType
): HNLensResult {
  const comments = (item.children ?? []).filter(c => c.text && c.text.trim())
  const commentText = comments
    .map(c => stripHtml(c.text ?? ''))
    .join('\n')
  const articleCorpus = `${item.title}\n${articleText || item.text || ''}`
  const hasText = !!(articleText || item.text)

  const jargon = extractJargon(articleCorpus, commentText)
  const summary = buildSummary(item, articleText, itemType, hasText)
  const verdict = buildVerdict(item, itemType)
  const comment_digest = buildCommentDigest(item, comments)

  return {
    item_id: item.id,
    spec_version: 1,
    type: itemType,
    title: { en: item.title, zh: item.title },
    url: item.url ?? '',
    meta: {
      points: item.points ?? 0,
      comments: comments.length,
      author: item.author ?? '',
      age: '',
    },
    verdict,
    jargon,
    summary,
    comment_digest,
    flags: { low_confidence: !hasText, comments_sampled: false },
  }
}

// ── Public: define a single term (Ask 小词) ───────────────────────
export function mockDefineTerm(
  term: string,
  context?: string
): { term: string; zh_term: string; explain: BiStr } {
  const hit = lookupGlossary(term)
  if (hit) {
    return { term: hit.term, zh_term: hit.zh_term, explain: { en: hit.en, zh: hit.zh } }
  }
  return {
    term,
    zh_term: `${term}（术语）`,
    explain: {
      en: `"${term}" is a specialised term used in this area.${context ? ` It appears here in: "${truncate(context, 120)}".` : ''} A general definition isn\'t in this demo glossary — connect a Manyfold agent for a full explanation.`,
      zh: `「${term}」是这个领域的专门用语。${context ? `本文中出现于：「${truncate(context, 60)}」。` : ''}此示范词库尚未收录它的完整定义——接上 Manyfold 代理人即可取得完整解释。`,
    },
  }
}

// ── Jargon extraction ─────────────────────────────────────────────
function extractJargon(articleCorpus: string, commentText: string): JargonTerm[] {
  const out: JargonTerm[] = []
  const seenTerms = new Set<string>()
  const combined = `${articleCorpus}\n${commentText}`

  // 1) Glossary matches (high quality, bilingual)
  for (const entry of GLOSSARY) {
    const variants = [entry.term, ...(entry.aliases ?? [])]
    let matched = false
    let inArticle = false
    let inComments = false
    let appeared: string | undefined
    for (const v of variants) {
      const re = wordRegex(v, entry.ci ?? false)
      if (re.test(articleCorpus)) { matched = true; inArticle = true }
      if (re.test(commentText))   { matched = true; inComments = true }
      if (matched && !appeared) appeared = findSentence(combined, v, entry.ci ?? false)
      if (matched && inArticle && inComments) break
    }
    if (!matched) continue
    const key = entry.term.toLowerCase()
    if (seenTerms.has(key)) continue
    seenTerms.add(key)
    out.push({
      term: entry.term,
      zh_term: entry.zh_term,
      explain: { en: entry.en, zh: entry.zh },
      seen_in: inArticle && inComments ? 'both' : inArticle ? 'article' : 'comments',
      ...(appeared ? { appeared_as: appeared } : {}),
    })
    if (out.length >= 8) break
  }

  // 2) Top up with unknown acronyms if we have < 4 confident terms.
  // Keep only ones that look like real jargon: length ≥ 3 (or contain a
  // digit) and that recur, so dates/roman-numerals/one-offs don't leak in.
  if (out.length < 4) {
    const acronyms = findAcronyms(combined)
    for (const [ac, count] of acronyms) {
      if (out.length >= 6) break
      const looksJargon = (ac.length >= 3 || /\d/.test(ac)) && count >= 2
      if (!looksJargon) continue
      const key = ac.toLowerCase()
      if (seenTerms.has(key) || lookupGlossary(ac)) continue
      seenTerms.add(key)
      const inArticle = wordRegex(ac, false).test(articleCorpus)
      const inComments = wordRegex(ac, false).test(commentText)
      out.push({
        term: ac,
        zh_term: `${ac}（缩写术语）`,
        explain: {
          en: `An acronym specific to this topic. The thread uses it as established shorthand; see the quote for how it appears in context.`,
          zh: `这个主题特有的缩写，讨论串将它当作既定简称使用；可参考下方引文了解其上下文用法。`,
        },
        seen_in: inArticle && inComments ? 'both' : inArticle ? 'article' : 'comments',
        appeared_as: findSentence(combined, ac, false),
      })
    }
  }

  // 3) Absolute fallback so the hero section is never empty
  if (out.length === 0) {
    out.push({
      term: 'Hacker News',
      zh_term: 'Hacker News（科技社群）',
      explain: {
        en: 'A community news site where programmers and founders share and debate technology, startups, and science.',
        zh: '一个由程序设计师与创业者分享、辩论科技、新创与科学的社群新闻网站。',
      },
      seen_in: 'article',
    })
  }

  return out
}

function findAcronyms(text: string): Array<[string, number]> {
  const counts = new Map<string, number>()
  const re = /\b[A-Z][A-Z0-9]{1,5}\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const a = m[0]
    if (ACRONYM_STOP.has(a)) continue
    if (/^[IVXLCDM]+$/.test(a)) continue // roman numerals (III, XIV, …)
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

// ── Summary ───────────────────────────────────────────────────────
function buildSummary(
  item: HNItem,
  articleText: string,
  itemType: ItemType,
  hasText: boolean
): HNLensResult['summary'] {
  const typeEn = { article: 'article', ask: 'Ask HN question', show: 'Show HN project', pdf: 'PDF', paywalled: 'article' }[itemType]
  const typeZh = { article: '文章', ask: 'Ask HN 提问', show: 'Show HN 作品', pdf: 'PDF 文件', paywalled: '文章' }[itemType]
  const body = articleText || item.text || ''
  const sentences = cleanSentences(splitSentences(stripHtml(body)))

  if (!hasText || sentences.length === 0) {
    return {
      tldr: {
        en: `This ${typeEn} ("${item.title}") reached the HN front page with ${item.points ?? 0} points, but its full text couldn't be extracted (paywall, PDF, or self-post). Open it on HN to read the source.`,
        zh: `这篇${typeZh}〈${item.title}〉以 ${item.points ?? 0} 分登上 HN 首页，但无法撷取全文（可能因付费墙、PDF 或站内贴文）。请至 HN 开启原文阅读。`,
      },
      key_points: [
        { en: `Title: ${item.title}`, zh: `标题：${item.title}` },
        { en: `${item.points ?? 0} points · ${(item.children ?? []).length} top-level comments`, zh: `${item.points ?? 0} 分 · ${(item.children ?? []).length} 则主留言` },
        { en: 'Full text unavailable — the discussion below is the best signal.', zh: '无法取得全文——下方的讨论是最佳参考信号。' },
      ],
    }
  }

  const lead = sentences.slice(0, 2).join(' ')
  const points = pickKeySentences(sentences, 3)
  return {
    tldr: {
      en: truncate(lead, 320),
      zh: `（原文摘录）${truncate(lead, 200)}`,
    },
    key_points: points.map(s => ({ en: truncate(s, 220), zh: `（原文重点）${truncate(s, 160)}` })),
  }
}

function pickKeySentences(sentences: string[], n: number): string[] {
  // Prefer sentences with numbers/percentages (often the substantive claims),
  // then fall back to the earliest reasonably long sentences.
  const scored = sentences
    .map((s, i) => ({ s, i, score: (/[0-9]%|\d{2,}|\bx\b|faster|cheaper|better|because/i.test(s) ? 10 : 0) - i * 0.1 }))
    .filter(x => x.s.length > 40)
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, n).sort((a, b) => a.i - b.i).map(x => x.s)
  if (top.length) return top
  return sentences.filter(s => s.length > 30).slice(0, n)
}

// ── Verdict ───────────────────────────────────────────────────────
function buildVerdict(item: HNItem, itemType: ItemType): HNLensResult['verdict'] {
  const points = item.points ?? 0
  const nComments = (item.children ?? []).length
  const worth = points >= 300 ? 'high' : points >= 80 ? 'medium' : 'low'
  const tier = nComments >= 150 ? 'deep' : nComments >= 40 ? '1min' : '10s'

  const reasonEn =
    itemType === 'ask' ? `An Ask HN thread the community engaged with heavily (${nComments} comments) — the value is in the collective answers.`
    : itemType === 'show' ? `A Show HN project that drew ${points} points — people found it worth trying or discussing.`
    : `It climbed to ${points} points with ${nComments} comments, signalling the community sees it as ${worth === 'high' ? 'important' : worth === 'medium' ? 'interesting' : 'niche'}.`
  const reasonZh =
    itemType === 'ask' ? `一则社群热烈参与的 Ask HN 讨论（${nComments} 则留言）——价值在于众人汇集的答案。`
    : itemType === 'show' ? `一个获得 ${points} 分的 Show HN 作品——大家认为值得一试或讨论。`
    : `它累积到 ${points} 分、${nComments} 则留言，显示社群认为这${worth === 'high' ? '相当重要' : worth === 'medium' ? '颇有意思' : '较为小众'}。`

  return {
    worth_reading: worth,
    why_frontpage: { en: reasonEn, zh: reasonZh },
    tier,
  }
}

// ── Comment digest ────────────────────────────────────────────────
function buildCommentDigest(item: HNItem, comments: HNComment[]): HNLensResult['comment_digest'] {
  const n = comments.length
  if (n === 0) {
    return {
      overview: {
        en: 'No comments yet on this post.',
        zh: '这篇贴文目前还没有留言。',
      },
      camps: [], consensus: { en: '', zh: '' }, disputes: [],
      expert_corrections: [], spicy: [],
    }
  }

  // Rank top-level comments by substance (length of own text).
  const ranked = [...comments]
    .map(c => ({ c, text: stripHtml(c.text ?? '') }))
    .filter(x => x.text.length > 0)
    .sort((a, b) => b.text.length - a.text.length)

  // Camps: take the most substantial distinct top-level comments.
  const camps: Camp[] = []
  const campLabels: BiStr[] = [
    { en: 'Main thread of discussion', zh: '主要讨论方向' },
    { en: 'A different angle', zh: '另一种观点' },
    { en: 'Pushback & caveats', zh: '质疑与提醒' },
  ]
  const weights: Camp['weight'][] = ['majority', 'vocal-minority', 'fringe']
  for (let i = 0; i < Math.min(3, ranked.length); i++) {
    const { c, text } = ranked[i]
    camps.push({
      label: campLabels[i],
      stance: { en: `Raised by ${c.author ?? 'a commenter'}.`, zh: `由 ${c.author ?? '某位留言者'} 提出。` },
      weight: weights[i],
      quote: truncate(text, 160),
      comment_id: c.id,
    })
  }

  // Corrections / caveats: comments that read like a correction.
  const correctionHit = ranked.find(x =>
    /\b(actually|incorrect|not true|to be clear|that'?s wrong|misleading|correction|in fact|nitpick)\b/i.test(x.text))
  const expert_corrections = correctionHit ? [{
    correction: {
      en: `${correctionHit.c.author ?? 'A commenter'} pushes back on a claim: "${truncate(correctionHit.text, 160)}"`,
      zh: `${correctionHit.c.author ?? '一位留言者'}对文中说法提出更正：「${truncate(correctionHit.text, 120)}」`,
    },
    comment_id: correctionHit.c.id,
  }] : []

  // Spicy: strongest-sentiment comment (punctuation / opinion markers).
  const spicyHit = ranked
    .map(x => ({ ...x, heat: heatScore(x.text) }))
    .sort((a, b) => b.heat - a.heat)[0]
  const spicy = spicyHit && spicyHit.heat > 0 ? [{
    quote: truncate(spicyHit.text, 200),
    zh: `（最具火药味的一则留言，原文如上）来自 ${spicyHit.c.author ?? '匿名'}。`,
    comment_id: spicyHit.c.id,
  }] : []

  const topAuthor = ranked[0]?.c.author ?? 'commenters'
  return {
    overview: {
      en: `${n} top-level comments. The most-developed threads are led by ${topAuthor} and others; below are the main strands, a likely correction, and the spiciest take — each links to the original comment.`,
      zh: `共 ${n} 则主留言。讨论最深入的串由 ${topAuthor} 等人带起；以下整理主要脉络、可能的更正，以及最辛辣的一则评论，每项都可点回原始留言。`,
    },
    camps,
    consensus: {
      en: camps.length
        ? `Most engagement clusters around: "${truncate(camps[0].quote, 120)}"`
        : 'No clear consensus.',
      zh: camps.length
        ? `多数讨论集中于：「${truncate(camps[0].quote, 90)}」`
        : '尚无明确共识。',
    },
    disputes: camps.length >= 2 ? [{
      en: `Tension between "${truncate(camps[0].quote, 90)}" and "${truncate(camps[1].quote, 90)}".`,
      zh: `「${truncate(camps[0].quote, 60)}」与「${truncate(camps[1].quote, 60)}」之间存在分歧。`,
    }] : [],
    expert_corrections,
    spicy,
  }
}

function heatScore(text: string): number {
  let s = 0
  if (/[!?]{1,}/.test(text)) s += (text.match(/[!?]/g) ?? []).length
  if (/\b(never|always|terrible|awful|nonsense|ridiculous|wrong|hate|love|amazing|garbage|hype|overrated|underrated)\b/i.test(text)) s += 5
  if (/\b(disagree|honestly|frankly|unpopular|controversial)\b/i.test(text)) s += 3
  return s
}

// ── Text helpers ──────────────────────────────────────────────────
function wordRegex(term: string, ci: boolean): RegExp {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // For multi-word or symbol-containing terms, use loose boundaries.
  const pattern = /^[\w]+$/.test(term) ? `\\b${esc}\\b` : esc.replace(/\s+/g, '\\s+')
  return new RegExp(pattern, ci ? 'i' : '')
}

function findSentence(text: string, term: string, ci: boolean): string | undefined {
  const sentences = splitSentences(stripHtml(text))
  const re = wordRegex(term, ci)
  const hit = sentences.find(s => re.test(s))
  return hit ? truncate(hit.trim(), 180) : undefined
}

// Drop nav/boilerplate sentences that survive naive HTML extraction so the
// TL;DR starts on real prose, not site chrome.
function cleanSentences(sentences: string[]): string[] {
  const BOILER = /table of contents|skip to|main content|subscribe|newsletter|cookie|sign in|log in|menu|copyright|all rights reserved|privacy policy|terms of service|share this|read more/i
  const clean = sentences.filter(s => {
    if (s.length < 30) return false
    if (s.includes('|')) return false
    if (BOILER.test(s)) return false
    const letters = (s.match(/[a-z]/g) ?? []).length
    if (letters < s.length * 0.4) return false // mostly symbols/caps → chrome
    return true
  })
  return clean.length ? clean : sentences
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

function truncate(s: string, max: number): string {
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1).trim() + '…' : s
}

function lookupGlossary(term: string): GlossaryEntry | undefined {
  const t = term.trim().toLowerCase()
  return GLOSSARY.find(e =>
    e.term.toLowerCase() === t ||
    (e.aliases ?? []).some(a => a.toLowerCase() === t))
}
