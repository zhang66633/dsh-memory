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

const contents = [
  '在 dsh-memory 修了 BOM 的坑',
  'dsh-memory 的面板加了三页签',
  'dsh-memory 支持外部 agent 读写',
  '伙伴叫哲，喜欢喝咖啡',
]
const terms = extractCjkTerms(contents)
assert.ok(terms.includes('dsh-memory') === false, 'cjk terms are CJK-only')
const graph = buildGraph(contents.map((content, i) => ({ id: `e${i}`, content })))
assert.ok(graph.nodes.has('dsh-memory'), 'shared entity is a node')
assert.equal(graph.nodes.get('dsh-memory').count, 3, 'node counts occurrences')
assert.ok(graph.nodes.has('BOM'))
assert.ok(graph.edges.has('BOM\u0000dsh-memory'), 'co-occurrence edge exists')

const q = queryEntities('BOM 问题')
assert.ok(q.includes('BOM'), 'query entities extracted')
const e0 = { id: 'e0' }
const e3 = { id: 'e3' }
assert.ok(graphBoost(graph, e0, q) > 0, 'entry sharing a query entity gets boosted')
assert.equal(graphBoost(graph, e3, q), 0, 'entry without shared entities gets nothing')

assert.deepEqual(entitiesOf('伙伴叫哲', terms).filter((t) => t === '伙伴'), [], 'rule-only extraction for unknown CJK')
console.log('graph-test: all assertions passed')
