/** dsh-memory graph test: entity extraction, co-occurrence graph, boost. */
import assert from 'node:assert/strict'
import { buildGraph, entitiesOf, extractCjkTerms, extractRuleEntities, graphBoost, queryEntities } from '../lib/graph.js'

const rule = extractRuleEntities('在 dsh-memory 修了 BOM 坑，见 D:\\_Projects\\dsh-memory\\README.md，版本 0.2.1，见 https://example.com/docs，详见「插件商店」')
const texts = rule.map(({ text }) => text)
assert.ok(texts.includes('dsh-memory'), 'identifier entity')
assert.ok(texts.includes('BOM'), 'uppercase identifier entity')
assert.ok(texts.includes('D:\\_Projects\\dsh-memory\\README.md'), 'path entity')
assert.ok(texts.includes('0.2.1'), 'version entity')
assert.ok(texts.includes('example.com'), 'url host entity')
assert.ok(texts.includes('插件商店'), 'quoted CJK entity')

// noise rejection: prose slashes around CJK are not paths; generic words are not entities
const prose = extractRuleEntities('事件流/片段流渲染/durable state 是其认可的参考标准')
const proseTexts = prose.map(({ text }) => text)
assert.ok(!proseTexts.some((t) => t.includes('/')), 'CJK prose slashes are not path entities')
assert.ok(!proseTexts.includes('state'), 'generic identifier stopwords are dropped')
assert.ok(proseTexts.includes('durable'), 'non-stopword identifiers survive')

const contents = [
  '在 dsh-memory 修了 BOM 的坑',
  'dsh-memory 的面板加了三页签',
  'dsh-memory 支持外部 agent 读写',
  '伙伴叫哲，喜欢喝咖啡',
  '通过 agent 调 dsh-memory 的 API',
]
const terms = extractCjkTerms(contents)
assert.ok(terms.includes('dsh-memory') === false, 'cjk terms are CJK-only')
const graph = buildGraph(contents.map((content, i) => ({ id: `e${i}`, content })))
assert.ok(graph.nodes.has('dsh-memory'), 'shared entity is a node')
assert.equal(graph.nodes.get('dsh-memory').count, 4, 'node counts occurrences')
assert.ok(graph.nodes.has('BOM'))
assert.ok(graph.nodes.has('agent'), 'repeated identifier is an entity')
assert.ok(graph.edges.has('BOM\u0000dsh-memory'), 'co-occurrence edge exists')
assert.ok(graph.edges.has('agent\u0000dsh-memory'), 'second co-occurrence edge exists')
assert.equal(graph.nodes.get('dsh-memory').degree, 2, 'degree counts distinct co-occurrence edges')
assert.equal(graph.nodes.get('BOM').degree, 1)

// single-occurrence identifiers are prose, not entities
const sparse = buildGraph([
  { id: 's0', content: 'using an absolute drive path causes junction issues' },
  { id: 's1', content: 'using junction install is fine' },
])
assert.ok(!sparse.nodes.has('absolute'), 'one-off prose word dropped')
assert.ok(!sparse.nodes.has('drive'), 'stopword dropped')
assert.ok(!sparse.nodes.has('install'), 'one-off lowercase identifier dropped')
assert.ok(sparse.nodes.has('junction'), 'repeated identifier kept')

// full-width parens stop path matches: CJK never leaks into a path entity
const parenPath = extractRuleEntities('link:D:/_Projects/x）经 pnpm install')
const pathEntity = parenPath.find(({ kind }) => kind === 'path')
assert.ok(pathEntity !== undefined && pathEntity.text === 'D:/_Projects/x', 'path stops at full-width paren')

const q = queryEntities('BOM 问题')
assert.ok(q.includes('BOM'), 'query entities extracted')
const e0 = { id: 'e0' }
const e3 = { id: 'e3' }
assert.ok(graphBoost(graph, e0, q) > 0, 'entry sharing a query entity gets boosted')
assert.equal(graphBoost(graph, e3, q), 0, 'entry without shared entities gets nothing')

// maximal-term pruning: fragments absorbed by longer kept terms; stopwords gone
const phraseTerms = extractCjkTerms([
  '绝对盘符路径被当成相对路径拼接',
  '绝对盘符路径会生成坏 junction',
])
assert.ok(phraseTerms.includes('绝对盘符路径'), 'maximal phrase survives')
assert.ok(!phraseTerms.includes('绝对盘'), 'trigram fragment absorbed')
assert.ok(!phraseTerms.includes('盘符'), 'bigram fragment absorbed')
assert.ok(!phraseTerms.includes('路径'), 'stopword dropped')
const proseTerms = extractCjkTerms([
  '修复损坏的 junction 需要重建',
  '修复后必须验证 junction 目标',
])
assert.ok(!proseTerms.includes('修复'), 'generic prose word dropped')
assert.ok(!proseTerms.includes('重建'), 'generic prose word dropped')

assert.deepEqual(entitiesOf('伙伴叫哲', terms).filter((t) => t === '伙伴'), [], 'rule-only extraction for unknown CJK')
console.log('graph-test: all assertions passed')
