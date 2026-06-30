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
  { term: 'pgvector', ci: true, zh_term: 'PostgreSQL 向量擴充套件',
    en: 'A free add-on for the PostgreSQL database that lets it store and search lists of numbers (the kind AI models use to represent meaning) without running a separate service.',
    zh: 'PostgreSQL 資料庫的免費外掛，讓你直接在一般資料庫裡儲存與搜尋「向量」（AI 模型用來表示語意的一串數字），不必另外架一套專門服務。' },
  { term: 'Pinecone', ci: true, zh_term: 'Pinecone（向量資料庫雲端服務）',
    en: 'A hosted cloud service built only for storing and searching vectors. Convenient, but you pay a fixed monthly fee to keep it running whether you use it or not.',
    zh: '一個專門用來存放與搜尋向量的雲端託管服務。好處是省事，壞處是每月固定收費，不論你用不用都要付。' },
  { term: 'vector database', ci: true, zh_term: '向量資料庫', aliases: ['vector db', 'vector store'],
    en: 'A database tuned to find items whose meaning is "closest" to a query, rather than matching exact keywords — the backbone of AI search and recommendations.',
    zh: '一種專門用來找「語意最接近」的資料庫，而不是比對關鍵字字面，是 AI 搜尋與推薦的核心。' },
  { term: 'embedding', ci: true, zh_term: '嵌入向量', aliases: ['embeddings'],
    en: 'A list of numbers an AI model produces to capture the meaning of a piece of text or an image, so a computer can compare meanings mathematically.',
    zh: 'AI 模型把一段文字或圖片轉成的一串數字，用來代表它的「意思」，讓電腦能用數學方式比較語意相近程度。' },
  { term: 'HNSW', zh_term: '階層可導航小世界圖（一種索引）',
    en: 'A way of organising vectors into a layered map so search can jump to the right neighbourhood fast, instead of comparing against every single item.',
    zh: '把向量組織成多層地圖的索引方法：搜尋時先跳到大概的「區域」再細找，比逐筆比對快得多。' },
  { term: 'ANN', zh_term: '近似最近鄰搜尋', aliases: ['approximate nearest neighbor', 'approximate nearest neighbour'],
    en: 'Search that returns results that are "close enough" instead of guaranteed-perfect, trading a tiny bit of accuracy for a huge speed-up.',
    zh: '不保證找到「最精準」答案、只求「夠接近」的搜尋；用一點點準確度換取大幅的速度提升。' },
  { term: 'RAG', zh_term: '檢索增強生成', aliases: ['retrieval augmented generation', 'retrieval-augmented generation'],
    en: 'A trick where an AI first looks up relevant documents and then writes its answer using them, so it can cite real facts instead of guessing.',
    zh: '一種做法：AI 先檢索相關文件，再根據文件內容作答，讓它引用真實資料而非憑空編造。' },
  { term: 'LLM', zh_term: '大型語言模型', aliases: ['large language model'],
    en: 'A program trained on huge amounts of text that predicts the next words, which lets it answer questions, write, and summarise.',
    zh: '用海量文字訓練、會預測下一個字的程式；因此能回答問題、寫作與摘要，例如 ChatGPT 背後的模型。' },
  { term: 'recall', ci: true, zh_term: '召回率', aliases: ['recall@10', 'recall@k'],
    en: 'A score for search quality: of all the truly best matches, what fraction did the system actually return? 0.95 means it found 95% of them.',
    zh: '衡量搜尋品質的指標：真正該找到的最佳結果中，系統實際找回了多少比例。0.95 代表找回了 95%。' },
  { term: 'token', ci: true, zh_term: '詞元（token）', aliases: ['tokens'],
    en: 'The small chunk of text (roughly a word piece) that language models read and count one at a time — pricing and limits are usually measured in tokens.',
    zh: '語言模型逐一讀取與計算的小文字片段（大約是一個詞或詞的一部分）；計費與長度上限通常以詞元數計算。' },
  { term: 'fine-tuning', ci: true, zh_term: '微調', aliases: ['fine tuning', 'finetune', 'fine-tune'],
    en: 'Taking an already-trained AI model and training it a bit more on your own examples so it behaves the way you want.',
    zh: '拿一個已經訓練好的 AI 模型，再用你自己的範例多訓練一點，讓它的行為更符合你的需求。' },
  { term: 'quantization', ci: true, zh_term: '量化', aliases: ['quantized', 'quantisation'],
    en: 'Shrinking an AI model by storing its numbers with less precision, so it runs on cheaper hardware with only a small quality drop.',
    zh: '用較低精度儲存模型的數字來縮小模型，使它能在更便宜的硬體上跑，且品質只略微下降。' },

  // ── Infra / devops ──
  { term: 'Kubernetes', ci: true, zh_term: 'Kubernetes（容器調度系統）', aliases: ['k8s'],
    en: 'A system that automatically runs, restarts, and spreads your app across many servers so it stays up under load.',
    zh: '自動部署、重啟並把應用分散到多台伺服器的系統，讓服務在高負載下仍維持運作。' },
  { term: 'Docker', ci: true, zh_term: 'Docker（容器化工具）',
    en: 'A tool that packages an app with everything it needs into a "container" that runs the same way on any machine.',
    zh: '把應用程式和它所需的一切打包成「容器」的工具，讓它在任何機器上都能一致地執行。' },
  { term: 'serverless', ci: true, zh_term: '無伺服器運算',
    en: 'Running code without managing servers yourself — the platform spins it up on demand and you pay only for what runs.',
    zh: '不必自己管理伺服器的運算方式：平台依需求啟動你的程式，按實際執行量計費。' },
  { term: 'Redis', ci: true, zh_term: 'Redis（記憶體資料庫）',
    en: 'A very fast database that keeps data in memory, commonly used as a cache to avoid repeating slow work.',
    zh: '把資料放在記憶體中的高速資料庫，常被當作快取，避免重複執行緩慢的運算。' },
  { term: 'Postgres', ci: true, zh_term: 'PostgreSQL（關聯式資料庫）', aliases: ['PostgreSQL'],
    en: 'A popular free database for storing structured data in tables, known for being reliable and feature-rich.',
    zh: '熱門的免費關聯式資料庫，用表格儲存結構化資料，以穩定與功能豐富著稱。' },
  { term: 'RDS', zh_term: 'AWS RDS（託管資料庫服務）',
    en: 'Amazon\'s service that runs and maintains a database for you, handling backups and updates so you don\'t have to.',
    zh: 'Amazon 提供的託管資料庫服務，幫你執行與維護資料庫，自動處理備份與更新。' },
  { term: 'p99', zh_term: 'p99 延遲（第 99 百分位）', aliases: ['p95', 'p50', 'tail latency'],
    en: 'A "worst realistic case" speed measure: the response time that 99% of requests beat. It shows how slow your unluckiest users feel.',
    zh: '一種「實際最差情況」的速度指標：99% 的請求都比這個時間快。它反映最不幸使用者的等待感受。' },
  { term: 'latency', ci: true, zh_term: '延遲',
    en: 'How long you wait between asking for something and getting a response — lower is faster.',
    zh: '從你發出請求到收到回應之間的等待時間，數字越低代表越快。' },
  { term: 'throughput', ci: true, zh_term: '吞吐量',
    en: 'How much work a system handles per second — higher means it can serve more requests at once.',
    zh: '系統每秒能處理的工作量，數字越高代表能同時服務越多請求。' },
  { term: 'CDN', zh_term: '內容傳遞網路',
    en: 'A network of servers spread around the world that keeps copies of your files close to users so pages load faster.',
    zh: '遍布全球的伺服器網路，把你的檔案副本放在離使用者近的地方，讓網頁載入更快。' },

  // ── Languages / runtimes ──
  { term: 'Rust', ci: true, zh_term: 'Rust（程式語言）',
    en: 'A programming language designed for speed and safety: it catches whole classes of memory bugs before the program ever runs.',
    zh: '一種兼顧效能與安全的程式語言：能在程式執行前就攔截整類記憶體錯誤。' },
  { term: 'Go', zh_term: 'Go / Golang（程式語言）', aliases: ['Golang'],
    en: 'A programming language from Google built for simple, fast server software and easy handling of many tasks at once.',
    zh: 'Google 推出的程式語言，主打簡潔、快速的伺服器程式，並能輕鬆同時處理大量任務。' },
  { term: 'WASM', zh_term: 'WebAssembly', aliases: ['WebAssembly'],
    en: 'A compact format that lets code written in languages like Rust or C run inside the browser at near-native speed.',
    zh: '一種精簡的格式，讓 Rust、C 等語言寫的程式能在瀏覽器中以接近原生的速度執行。' },
  { term: 'borrow checker', ci: true, zh_term: '借用檢查器（Rust）',
    en: 'The part of the Rust compiler that enforces who is allowed to read or change each piece of data, preventing memory bugs.',
    zh: 'Rust 編譯器中負責管控「誰能讀寫每塊資料」的機制，用來防止記憶體錯誤。' },
  { term: 'garbage collection', ci: true, zh_term: '垃圾回收', aliases: ['garbage collector', 'GC'],
    en: 'An automatic cleanup system that frees memory the program no longer needs, so developers don\'t have to track it by hand.',
    zh: '自動清理機制，會釋放程式不再需要的記憶體，讓開發者不必手動管理。' },

  // ── Web / data ──
  { term: 'BM25', zh_term: 'BM25（全文搜尋排序演算法）',
    en: 'A classic formula for ranking text search results by keyword relevance — the proven workhorse behind traditional full-text search.',
    zh: '依關鍵字相關度為文字搜尋結果排序的經典公式，是傳統全文搜尋背後成熟可靠的主力演算法。' },
  { term: 'GraphQL', ci: true, zh_term: 'GraphQL（API 查詢語言）',
    en: 'A way to ask a server for exactly the data fields you want in one request, instead of calling many fixed endpoints.',
    zh: '一種 API 查詢方式：在一次請求中向伺服器精確指定你要的欄位，而非呼叫多個固定端點。' },
  { term: 'SSE', zh_term: '伺服器發送事件', aliases: ['server-sent events'],
    en: 'A simple way for a server to keep pushing live updates to the browser over one long-lived connection.',
    zh: '一種簡單機制，讓伺服器透過單一長連線持續把即時更新推送到瀏覽器。' },
  { term: 'WebSocket', ci: true, zh_term: 'WebSocket（雙向即時連線）', aliases: ['websockets'],
    en: 'A two-way live connection between browser and server, used for chat, games, and anything needing instant back-and-forth.',
    zh: '瀏覽器與伺服器之間的雙向即時連線，用於聊天、遊戲等需要即時來回的場景。' },
  { term: 'JWT', zh_term: 'JSON Web Token（憑證）',
    en: 'A signed, tamper-evident token a server hands a user to prove who they are on later requests, without re-checking a database each time.',
    zh: '伺服器發給使用者、帶簽章且可驗真偽的憑證；之後的請求靠它證明身分，不必每次都查資料庫。' },
  { term: 'CRDT', zh_term: '無衝突複製資料型別',
    en: 'A data structure that lets many people edit the same document offline and merges everyone\'s changes automatically without conflicts.',
    zh: '一種資料結構，讓多人離線編輯同一份文件後，能自動合併彼此的修改且不產生衝突。' },
  { term: 'SQLite', ci: true, zh_term: 'SQLite（嵌入式資料庫）',
    en: 'A tiny database that lives in a single file inside your app — no server to run, great for local or embedded use.',
    zh: '存在單一檔案中、嵌在應用程式裡的小型資料庫，不需架伺服器，適合本機或嵌入式使用。' },

  // ── Security / general ──
  { term: 'zero-day', ci: true, zh_term: '零時差漏洞', aliases: ['0-day', 'zero day'],
    en: 'A security hole that attackers know about before the vendor does, so there is no fix available yet when it\'s first exploited.',
    zh: '攻擊者比廠商更早得知的安全漏洞；被利用時尚無修補程式可用。' },
  { term: 'end-to-end encryption', ci: true, zh_term: '端對端加密', aliases: ['e2ee', 'end to end encryption'],
    en: 'Scrambling messages so only the sender and receiver can read them — not even the company running the service can.',
    zh: '把訊息加密成只有寄件者與收件者能讀的形式，連提供服務的公司也無法解讀。' },
  { term: 'open source', ci: true, zh_term: '開源', aliases: ['open-source', 'FOSS', 'OSS'],
    en: 'Software whose source code is published for anyone to read, use, and modify, usually for free.',
    zh: '原始碼公開、任何人都能閱讀、使用與修改的軟體，通常免費。' },
  { term: 'self-hosted', ci: true, zh_term: '自架（self-hosted）', aliases: ['self host', 'selfhost', 'self hosting'],
    en: 'Running software on your own servers instead of paying a company to host it for you — more control, more maintenance.',
    zh: '把軟體跑在自己的伺服器上，而非付費讓廠商代管；掌控度更高，但維護負擔也更大。' },
  { term: 'YAGNI', zh_term: 'YAGNI（你不會需要它）',
    en: '"You Aren\'t Gonna Need It" — advice not to build features for imagined future needs until they\'re actually required.',
    zh: '「你不會需要它」的縮寫：勸你別為想像中的未來需求預先開發功能，等真正需要時再做。' },
  { term: 'technical debt', ci: true, zh_term: '技術債', aliases: ['tech debt'],
    en: 'The future cost of taking shortcuts in code today — like a loan you repay later with slower, harder changes.',
    zh: '今天為了省事而走捷徑，未來要付出的代價；像借貸一樣，日後得用更慢、更難改的程式碼償還。' },
  { term: 'idempotent', ci: true, zh_term: '冪等',
    en: 'An operation you can safely repeat and get the same result — running it twice does no extra harm.',
    zh: '可以安全重複執行、結果都相同的操作；做兩次也不會造成額外影響。' },
  { term: 'eventual consistency', ci: true, zh_term: '最終一致性',
    en: 'A design where different copies of data may briefly disagree but are guaranteed to match up shortly after.',
    zh: '一種設計：不同副本的資料可能短暫不一致，但保證很快會趨於一致。' },
  { term: 'rate limit', ci: true, zh_term: '速率限制', aliases: ['rate-limiting', 'rate limiting'],
    en: 'A cap on how many requests you can make in a time window, used to stop abuse and keep a service stable.',
    zh: '在一段時間內限制你能發出的請求數量，用來防止濫用並維持服務穩定。' },
  { term: 'benchmark', ci: true, zh_term: '基準測試', aliases: ['benchmarks'],
    en: 'A standardised test that measures how fast or efficient something is, so different options can be compared fairly.',
    zh: '用標準化測試衡量某事物的速度或效率，以便公平比較不同方案。' },
  { term: 'API', zh_term: '應用程式介面',
    en: 'A defined set of requests one program can send to another to ask for data or actions — the contract between software pieces.',
    zh: '一個程式能向另一個程式發出的、用來索取資料或執行動作的標準請求集合，是軟體之間的「合約」。' },
  { term: 'cache', ci: true, zh_term: '快取', aliases: ['caching'],
    en: 'A stash of already-computed answers kept close at hand so repeated work can be skipped and things load faster.',
    zh: '把已經算好的結果暫存在手邊，避免重複運算、加快載入速度的機制。' },
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

// ── Public: define a single term (Ask 小詞) ───────────────────────
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
    zh_term: `${term}（術語）`,
    explain: {
      en: `"${term}" is a specialised term used in this area.${context ? ` It appears here in: "${truncate(context, 120)}".` : ''} A general definition isn\'t in this demo glossary — connect a Manyfold agent for a full explanation.`,
      zh: `「${term}」是這個領域的專門用語。${context ? `本文中出現於：「${truncate(context, 60)}」。` : ''}此示範詞庫尚未收錄它的完整定義——接上 Manyfold 代理人即可取得完整解釋。`,
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
        zh_term: `${ac}（縮寫術語）`,
        explain: {
          en: `An acronym specific to this topic. The thread uses it as established shorthand; see the quote for how it appears in context.`,
          zh: `這個主題特有的縮寫，討論串將它當作既定簡稱使用；可參考下方引文了解其上下文用法。`,
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
        zh: '一個由程式設計師與創業者分享、辯論科技、新創與科學的社群新聞網站。',
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
  const typeZh = { article: '文章', ask: 'Ask HN 提問', show: 'Show HN 作品', pdf: 'PDF 文件', paywalled: '文章' }[itemType]
  const body = articleText || item.text || ''
  const sentences = cleanSentences(splitSentences(stripHtml(body)))

  if (!hasText || sentences.length === 0) {
    return {
      tldr: {
        en: `This ${typeEn} ("${item.title}") reached the HN front page with ${item.points ?? 0} points, but its full text couldn't be extracted (paywall, PDF, or self-post). Open it on HN to read the source.`,
        zh: `這篇${typeZh}〈${item.title}〉以 ${item.points ?? 0} 分登上 HN 首頁，但無法擷取全文（可能因付費牆、PDF 或站內貼文）。請至 HN 開啟原文閱讀。`,
      },
      key_points: [
        { en: `Title: ${item.title}`, zh: `標題：${item.title}` },
        { en: `${item.points ?? 0} points · ${(item.children ?? []).length} top-level comments`, zh: `${item.points ?? 0} 分 · ${(item.children ?? []).length} 則主留言` },
        { en: 'Full text unavailable — the discussion below is the best signal.', zh: '無法取得全文——下方的討論是最佳參考訊號。' },
      ],
    }
  }

  const lead = sentences.slice(0, 2).join(' ')
  const points = pickKeySentences(sentences, 3)
  return {
    tldr: {
      en: truncate(lead, 320),
      zh: `（原文摘錄）${truncate(lead, 200)}`,
    },
    key_points: points.map(s => ({ en: truncate(s, 220), zh: `（原文重點）${truncate(s, 160)}` })),
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
    itemType === 'ask' ? `一則社群熱烈參與的 Ask HN 討論（${nComments} 則留言）——價值在於眾人匯集的答案。`
    : itemType === 'show' ? `一個獲得 ${points} 分的 Show HN 作品——大家認為值得一試或討論。`
    : `它累積到 ${points} 分、${nComments} 則留言，顯示社群認為這${worth === 'high' ? '相當重要' : worth === 'medium' ? '頗有意思' : '較為小眾'}。`

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
        zh: '這篇貼文目前還沒有留言。',
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
    { en: 'Main thread of discussion', zh: '主要討論方向' },
    { en: 'A different angle', zh: '另一種觀點' },
    { en: 'Pushback & caveats', zh: '質疑與提醒' },
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
      zh: `${correctionHit.c.author ?? '一位留言者'}對文中說法提出更正：「${truncate(correctionHit.text, 120)}」`,
    },
    comment_id: correctionHit.c.id,
  }] : []

  // Spicy: strongest-sentiment comment (punctuation / opinion markers).
  const spicyHit = ranked
    .map(x => ({ ...x, heat: heatScore(x.text) }))
    .sort((a, b) => b.heat - a.heat)[0]
  const spicy = spicyHit && spicyHit.heat > 0 ? [{
    quote: truncate(spicyHit.text, 200),
    zh: `（最具火藥味的一則留言，原文如上）來自 ${spicyHit.c.author ?? '匿名'}。`,
    comment_id: spicyHit.c.id,
  }] : []

  const topAuthor = ranked[0]?.c.author ?? 'commenters'
  return {
    overview: {
      en: `${n} top-level comments. The most-developed threads are led by ${topAuthor} and others; below are the main strands, a likely correction, and the spiciest take — each links to the original comment.`,
      zh: `共 ${n} 則主留言。討論最深入的串由 ${topAuthor} 等人帶起；以下整理主要脈絡、可能的更正，以及最辛辣的一則評論，每項都可點回原始留言。`,
    },
    camps,
    consensus: {
      en: camps.length
        ? `Most engagement clusters around: "${truncate(camps[0].quote, 120)}"`
        : 'No clear consensus.',
      zh: camps.length
        ? `多數討論集中於：「${truncate(camps[0].quote, 90)}」`
        : '尚無明確共識。',
    },
    disputes: camps.length >= 2 ? [{
      en: `Tension between "${truncate(camps[0].quote, 90)}" and "${truncate(camps[1].quote, 90)}".`,
      zh: `「${truncate(camps[0].quote, 60)}」與「${truncate(camps[1].quote, 60)}」之間存在分歧。`,
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
