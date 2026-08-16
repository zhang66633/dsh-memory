/**
 * dsh-memory — lightweight entity graph (P2).
 *
 * Entity extraction (paths, identifiers, versions, URL hosts, quoted
 * phrases, and statistically frequent CJK terms) plus a co-occurrence graph:
 * two entities in the same memory share an edge weighted by count and recency.
 * The graph serves two consumers — recall fusion (a query matching an entity
 * boosts every memory sharing related entities) and the panel's force-directed
 * visualization.
 *
 * @module dsh-memory/graph
 */

/** Function-word CJK terms never treated as entities. */
const CJK_STOP = new Set([
  '我们', '他们', '你们', '这个', '那个', '一个', '什么', '怎么', '为什么',
  '因为', '所以', '但是', '如果', '就是', '可以', '需要', '应该', '已经',
  '正在', '然后', '还有', '这些', '那些', '知道', '觉得', '认为', '可能',
  '通过', '对于', '关于', '以及', '或者', '并且', '不是', '没有', '只是',
  '这样', '那样', '时候', '东西', '地方', '大家', '自己', '现在', '以后',
  '之前', '之后', '里面', '外面', '上面', '下面', '进行', '出现', '存在',
  '工作', '表示', '非常', '比较', '开始', '继续', '完成', '处理',
  // 开发/运维散文高频词：单独出现无实体价值
  '修复', '重建', '目标', '检查', '必须', '需要', '注意', '验证', '问题',
  '报错', '症状', '根因', '原因', '方式', '方法', '情况', '时候', '结果',
  '解决', '方案', '版本', '默认', '相关', '对应', '使用', '安装', '更新',
  '重启', '消失', '路径', '目录', '文件', '依赖', '配置', '注册', '加载',
  '启动', '失败', '成功', '生效', '跳过', '保留', '删除', '损坏', '备份',
  '恢复', '迁移', '合并', '拆分', '切换', '解析', '编码', '解码', '复制',
  '移动', '创建', '新建', '打开', '关闭', '读取', '写入', '执行', '运行',
  '测试', '构建', '发布', '提交', '推送', '拉取', '同步', '异步', '错误',
  '警告', '提示', '说明', '文档', '示例', '案例', '步骤', '流程', '过程',
])

/** Generic development/English words never treated as entities. */
const IDENTIFIER_STOP = new Set([
  'state', 'data', 'code', 'list', 'node', 'view', 'test', 'file', 'text',
  'info', 'api', 'url', 'http', 'https', 'type', 'name', 'key', 'value',
  'user', 'time', 'date', 'new', 'old', 'true', 'false', 'null', 'main',
  'index', 'app', 'web', 'the', 'and', 'for', 'with', 'from', 'this',
  'that', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'all',
  'some', 'more', 'most', 'only', 'also', 'just', 'very', 'too', 'not',
  'but', 'now', 'then', 'else', 'good', 'bad', 'via', 'per',
  // common English prose words that never name an entity
  'absolute', 'relative', 'using', 'path', 'paths', 'drive', 'causes',
  'create', 'broken', 'pointing', 'fake', 'prefixed', 'under', 'directory',
  'use', 'verify', 'targets', 'after', 'before', 'without', 'within',
  'could', 'should', 'must', 'never', 'always', 'instead', 'still',
  'other', 'another', 'same', 'different', 'both', 'each', 'every',
  'such', 'much', 'less', 'first', 'last', 'next', 'above', 'below',
  'between', 'during', 'through', 'over', 'back', 'again', 'often',
  'usually', 'here', 'there', 'into', 'onto', 'about', 'across',
  'along', 'around', 'until', 'while', 'because', 'since', 'though',
  'although', 'however', 'therefore', 'thus', 'hence', 'despite',
  'regarding', 'including', 'according', 'following', 'given', 'based',
  'related', 'issue', 'issues', 'error', 'errors', 'case', 'cases',
])

const QUOTED = /["“”'‘「」]([^"“”'‘「」\n]{2,30})["“”'‘「」]/g
// Unix-style paths must be ASCII segments (≥2) so prose slashes around CJK
// text never masquerade as paths; drive-anchored Windows paths stay permissive
// but stop at Chinese/full-width punctuation (（） would otherwise leak CJK).
const PATH_END = '\\s，。;；：:！？、\'"(){}（）【】《》'
const WHOLE = new RegExp(
  `(workspace:[^${PATH_END}]+|[a-zA-Z]:[\\\\/][^${PATH_END}]+|(?:\\/[A-Za-z0-9._-]+){2,}\\/?|https?:\\/\\/[^${PATH_END}]+|\\bv?\\d+\\.\\d+(?:\\.\\d+)?(?:[-+][\\w.-]+)?|[A-Za-z_][A-Za-z0-9_-]{2,})`,
  'g',
)
const CJK_RUN = /[\u4e00-\u9fff]+/g

/**
 * Extract rule-based entities from one text (no corpus statistics).
 * @param content - one memory content string.
 * @returns unique `{text, kind}` pairs in appearance order.
 */
export function extractRuleEntities(content) {
  const text = String(content ?? '')
  const seen = new Set()
  const push = (value, kind) => {
    const key = `${kind}\u0000${value}`
    if (!seen.has(key)) {
      seen.add(key)
      return { text: value, kind }
    }
    return undefined
  }
  const entities = []
  for (const match of text.matchAll(QUOTED)) {
    const item = push(match[1].trim(), 'quoted')
    if (item) entities.push(item)
  }
  for (const match of text.matchAll(WHOLE)) {
    let token = match[0]
    let kind = 'identifier'
    if (token.startsWith('http')) {
      try { token = new URL(token).hostname } catch { /* keep the raw token */ }
      kind = 'url'
    } else if (/^workspace:/.test(token)) {
      kind = 'scope'
    } else if (/[\\/]/.test(token)) {
      kind = 'path'
    } else if (/^\d/.test(token)) {
      kind = 'version'
    } else if (IDENTIFIER_STOP.has(token.toLowerCase())) {
      continue
    }
    const item = push(token, kind)
    if (item) entities.push(item)
  }
  return entities
}

/**
 * Collect CJK term candidates across a corpus and keep the statistically
 * notable ones: appearing in at least `minDocs` distinct documents.
 * @param contents - every memory content string.
 * @param minDocs - appearance threshold (default 2).
 */
export function extractCjkTerms(contents, minDocs = 2) {
  const docs = contents.map((content) => new Set())
  const counts = new Map()
  contents.forEach((content, index) => {
    const text = String(content ?? '')
    for (const match of text.matchAll(CJK_RUN)) {
      const run = match[0]
      const terms = new Set()
      // n-grams of length 2..6; the maximal-term prune below collapses
      // overlapping fragments back into the longest surviving phrase.
      for (let len = 2; len <= 6 && len <= run.length; len++) {
        for (let i = 0; i + len <= run.length; i++) terms.add(run.slice(i, i + len))
      }
      for (const term of terms) {
        if (CJK_STOP.has(term)) continue
        counts.set(term, (counts.get(term) ?? 0) + 1)
        docs[index].add(term)
      }
    }
  })
  const documentFrequency = new Map()
  for (let i = 0; i < contents.length; i++) {
    for (const term of docs[i]) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  }
  const kept = [...documentFrequency.entries()]
    .filter(([, freq]) => freq >= minDocs)
    .sort((a, b) => b[0].length - a[0].length)
  // Maximal-term pruning: a term absorbed by a longer kept term is a
  // fragment, not an entity ("绝对盘符路径" absorbs 绝对/对盘/盘符/绝对盘/…).
  const maximal = []
  for (const [text] of kept) {
    if (maximal.some((longer) => longer.includes(text))) continue
    maximal.push(text)
  }
  return maximal
}

/** Extract one entry's full entity set: rule-based + corpus CJK terms. */
export function entitiesOf(content, cjkTerms, identifierDf) {
  let entities = extractRuleEntities(content).map(({ text, kind }) => ({ text, kind }))
  // Identifiers are only entities when the corpus repeats them — except
  // strong names (uppercase acronyms, snake_case, kebab-case), which are
  // signals even once. One-off lowercase prose words are noise.
  const strong = (text) => /[A-Z_-]/.test(text)
  if (identifierDf !== undefined) {
    entities = entities.filter(({ text, kind }) =>
      kind !== 'identifier' || strong(text) || (identifierDf.get(text) ?? 0) >= 2)
  }
  const text = String(content ?? '')
  for (const term of cjkTerms) {
    if (text.includes(term) && !entities.some((entity) => entity.text === term)) {
      entities.push({ text: term, kind: 'term' })
    }
  }
  return entities
}

/**
 * Build the co-occurrence graph over live entries.
 * @param entries - memory records (any fields; only id/content are read).
 * @returns nodes (entity → stats) and edges (entity pair → weight/lastSeen),
 *   plus per-entry entity sets for recall fusion.
 */
export function buildGraph(entries) {
  const contents = entries.map((entry) => String(entry.content ?? ''))
  const cjkTerms = extractCjkTerms(contents)
  const identifierDf = new Map()
  contents.forEach((content) => {
    const identifiers = extractRuleEntities(content)
      .filter(({ kind }) => kind === 'identifier')
      .map(({ text }) => text)
    for (const identifier of new Set(identifiers)) {
      identifierDf.set(identifier, (identifierDf.get(identifier) ?? 0) + 1)
    }
  })
  const nodes = new Map()
  const edges = new Map()
  const entryEntities = new Map()
  for (const entry of entries) {
    const entities = entitiesOf(entry.content, cjkTerms, identifierDf)
    entryEntities.set(entry.id, entities.map(({ text: name }) => name))
    const at = entry.last_accessed_at ?? entry.created_at ?? 0
    for (const entity of entities) {
      const node = nodes.get(entity.text)
        ?? { text: entity.text, kind: entity.kind, count: 0, degree: 0, lastSeen: 0 }
      node.count += 1
      node.lastSeen = Math.max(node.lastSeen, at)
      nodes.set(entity.text, node)
    }
    const names = entities.map(({ text: name }) => name)
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = names[i] <= names[j] ? [names[i], names[j]] : [names[j], names[i]]
        const key = `${a}\u0000${b}`
        const edge = edges.get(key) ?? { source: a, target: b, weight: 0, lastSeen: 0 }
        if (edge.weight === 0) {
          nodes.get(a).degree += 1
          nodes.get(b).degree += 1
        }
        edge.weight += 1
        edge.lastSeen = Math.max(edge.lastSeen, at)
        edges.set(key, edge)
      }
    }
  }
  return { nodes, edges, entryEntities }
}

/** Query entities: rule extraction only (a query has no corpus statistics). */
export function queryEntities(query) {
  return extractRuleEntities(query).map(({ text }) => text)
}

/**
 * Graph boost for one entry given query entities: 0.5 per shared entity plus
 * the entry's internal edge density, capped at 1.
 * @param graph - the `buildGraph` result.
 * @param entry - one memory record.
 * @param query - query entities.
 */
export function graphBoost(graph, entry, query) {
  const own = graph.entryEntities.get(entry.id) ?? []
  const shared = own.filter((entity) => query.includes(entity))
  if (shared.length === 0) return 0
  let density = 0
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const [x, y] = own[i] <= own[j] ? [own[i], own[j]] : [own[j], own[i]]
      const edge = graph.edges.get(`${x}\u0000${y}`)
      if (edge !== undefined) density += edge.weight
    }
  }
  return Math.min(1, shared.length * 0.5 + Math.min(1, density / 4) * 0.5)
}
