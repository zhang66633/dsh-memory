/**
 * dsh-memory — lightweight semantic vectors (P2).
 *
 * Pure-JS lexical-semantic retrieval: character n-grams for CJK plus
 * whole-token extraction for paths/identifiers/versions/URLs, TF-IDF
 * weighting over the live corpus, and cosine similarity over sparse unit
 * vectors. Zero dependencies: no native binaries, works over any storage
 * backend. It is lexical-semantic, not neural — a deliberate P2 tradeoff
 * (documented in README); a pluggable embedding provider can replace it
 * later without touching callers.
 *
 * @module dsh-memory/vector
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'with', 'is',
  'are', 'be', 'at', 'by', 'it', 'this', 'that', 'from', 'as', 'we', 'you',
  'i', 'was', 'were', 'not', 'do', 'does', 'did', 'will', 'can', 'could',
  'should', 'would', 'has', 'have', 'had', 'if', 'then', 'else', 'so', 'but',
  'my', 'your', 'his', 'her', 'our', 'their', 'me', 'he', 'she', 'they',
  'them', 'us', 'no', 'yes', 'ok', 'all', 'any', 'more', 'most', 'some',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'now', 'just',
  'only', 'also', 'very', 'too', 'much', 'many', 'get', 'got', 'use', 'used',
  'using', 'make', 'made', 'new', 'one', 'two', 'per', 'via',
])

/** Whole tokens: paths, workspace scopes, URLs, versions, identifiers. */
const WHOLE = /(workspace:[^\s，。;；：:！？、"'(){}（）【】《》]+|[a-z]:[\\/][^\s，。;；：:！？、"'(){}（）【】《》]+|(?:\/[a-z0-9._-]+){2,}\/?|https?:\/\/[^\s，。;；：:！？、"'(){}（）【】《》]+|\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?|[a-z_][a-z0-9_]{1,})/g
const CJK_RUN = /[\u4e00-\u9fff]+/g

/**
 * Tokenize one text into lowercased tokens: whole tokens first (so a path
 * consumes its sub-pieces), then CJK runs as char bigrams plus a full-run
 * token for short runs.
 * @param text - the memory content (or query).
 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase()
  const tokens = []
  for (const match of lower.matchAll(WHOLE)) {
    const token = match[0]
    if (token.startsWith('http')) {
      try { tokens.push(new URL(token).hostname) } catch { tokens.push(token) }
    } else {
      tokens.push(token)
    }
  }
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length <= 8) tokens.push(`cjk:${run}`)
    for (let i = 0; i + 1 < run.length; i++) tokens.push(`bi:${run.slice(i, i + 2)}`)
  }
  return tokens.filter((token) => !STOPWORDS.has(token))
}

/** Term-frequency weights per token from one token list. */
function tfMap(tokens) {
  const map = new Map()
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1)
  return map
}

/** Sparse unit vector: token → (1+ln tf)·idf, L2-normalized. */
function unitVector(tf, idf) {
  const vector = new Map()
  let norm = 0
  for (const [token, count] of tf) {
    const weight = (1 + Math.log(count)) * (idf?.get(token) ?? 1)
    vector.set(token, weight)
    norm += weight * weight
  }
  norm = Math.sqrt(norm) || 1
  for (const [token, weight] of vector) vector.set(token, weight / norm)
  return vector
}

/**
 * Build a corpus index: per-document unit vectors plus idf weights.
 * @param texts - one content string per memory entry.
 * @returns `{fingerprint, idf, vectors}`; `vectors[i]` matches `texts[i]`.
 */
export function buildIndex(texts) {
  const docs = texts.map(tokenize)
  const df = new Map()
  for (const tokens of docs) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1)
  }
  const n = Math.max(1, docs.length)
  const idf = new Map()
  for (const [token, count] of df) idf.set(token, Math.log((n + 1) / (1 + count)))
  const vectors = docs.map((tokens) => unitVector(tfMap(tokens), idf))
  const fingerprint = `${n}:${texts.reduce((sum, text) => sum + text.length, 0)}`
  return { fingerprint, idf, vectors }
}

/** Query vector over one corpus index; empty query → null. */
export function queryVector(query, index) {
  const tokens = tokenize(query)
  if (tokens.length === 0) return null
  return unitVector(tfMap(tokens), index.idf)
}

/** Cosine similarity between two sparse unit vectors (their dot product). */
export function cosine(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let sum = 0
  for (const [token, weight] of small) {
    const other = large.get(token)
    if (other !== undefined) sum += weight * other
  }
  return sum
}
