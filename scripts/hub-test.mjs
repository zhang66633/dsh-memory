/** dsh-memory hub service behavior test over the real file backend in tmp dirs. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/hub.js'
import { BACKEND_NAME } from '../lib/backend.js'

const cleanups = []

/**
 * Mount the hub over the real MemoryFileBackend (root = fresh tmp dir) and a
 * mocked storage hub; returns the service, a live view of the entries table,
 * and the collected routes.
 */
async function mountHub(config = {}, getFn = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-hub-'))
  cleanups.push(root)
  const backends = {}
  const routes = []
  const provided = {}
  const ctx = {
    storage: {
      backend: {
        register: (name, backend) => { backends[name] = backend; return () => {} },
      },
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn, label) => { void fn(); return () => {} },
    provide: (name, value) => { provided[name] = value },
    get: getFn,
    logger: { warn: () => {}, info: () => {} },
  }
  apply(ctx, { ...config, storage: { root, ...(config.storage ?? {}) } })
  const backend = backends[BACKEND_NAME]
  assert.ok(backend, 'hub registers its storage backend')
  // The unit open is async (mkdir + read); poll until it exists.
  for (let i = 0; i < 200 && backend.units.size === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const unit = backend.units.get('memory')
  assert.ok(unit, 'hub opens its memory unit')
  const entries = () => unit.snapshot().tables.entries ?? {}
  return { memory: provided.memory, records: { get: (id) => entries()[id], raw: entries }, routes }
}

const fakeRes = () => {
  const res = { code: 0, body: '' }
  res.writeHead = (code) => { res.code = code }
  res.end = (body) => { res.body = body }
  return res
}
const postReq = (authorization, body) => ({
  method: 'POST',
  url: '/',
  headers: authorization === undefined ? {} : { authorization },
  on: (event, callback) => {
    if (event === 'data' && body !== undefined) callback(Buffer.from(body))
    if (event === 'end') callback()
  },
})

async function main() {
  const { memory, records, routes } = await mountHub({ importanceLearningRate: 0.01 })

  // remember + dedup merge
  const first = await memory.remember({ content: '伙伴叫哲', type: 'semantic', importance: 0.5 })
  assert.equal(first.created, true)
  const again = await memory.remember({ content: '伙伴叫哲', type: 'semantic', importance: 0.9 })
  assert.equal(again.created, false)
  assert.equal(again.id, first.id)
  assert.equal(records.get(first.id).importance, 0.9, 'merge takes the higher importance')

  // unverified: latest write's verdict wins
  await memory.remember({ content: '伙伴叫哲', type: 'semantic', unverified: false })
  assert.equal(records.get(first.id).unverified, false, 'verified write clears unverified')

  // per-session watermark isolation
  await memory.setExtractionWatermark('session-a', 42)
  await memory.setExtractionWatermark('session-b', 7)
  assert.equal(await memory.extractionWatermark('session-a'), 42)
  assert.equal(await memory.extractionWatermark('session-b'), 7)
  await memory.setExtractionWatermark('session-b', 5) // never moves backward
  assert.equal(await memory.extractionWatermark('session-b'), 7)
  assert.equal(await memory.extractionWatermark('session-c'), 0)

  // recall: importance learning bump + unverified halving
  await memory.remember({ content: '低置信记忆', type: 'insight', importance: 0.5, unverified: true })
  const result = await memory.recall({ topK: 10 })
  const hit = result.hits.find((entry) => entry.content === '低置信记忆')
  assert.ok(hit, 'unverified entries stay recallable')
  assert.equal(hit.importance, 0.51, 'importance bumped by learning rate')
  const verified = result.hits.find((entry) => entry.content === '伙伴叫哲')
  assert.ok(verified, 'verified entry recallable')
  assert.ok(hit.recall_score < verified.recall_score, 'unverified halves the recall score')
  assert.equal(result.hits.filter((entry) => entry.tombstone).length, 0, 'no tombstones in recall')

  // forget is a soft delete; restore undoes it
  await memory.forget(first.id)
  assert.equal(records.get(first.id).tombstone, true)
  await memory.restore(first.id)
  assert.equal(records.get(first.id).tombstone, false)

  // P2 semantic fusion: no keyword overlap, only shared CJK bigrams decide
  await memory.remember({ content: '伙伴喜欢喝咖啡', type: 'preference', importance: 0.9 })
  await memory.remember({ content: '今天修了 BOM 的坑', type: 'episodic', importance: 0.9 })
  const semantic = await memory.recall({ query: '偏好咖啡', topK: 10 })
  const coffeeRank = semantic.hits.findIndex((entry) => entry.content === '伙伴喜欢喝咖啡')
  const bomRank = semantic.hits.findIndex((entry) => entry.content === '今天修了 BOM 的坑')
  assert.ok(coffeeRank !== -1 && bomRank !== -1)
  assert.ok(coffeeRank < bomRank, 'semantic similarity ranks the related entry above the unrelated one')

  // P2 graph fusion: entity co-occurrence density breaks the tie between
  // two entries that both match the query entity dsh-memory
  await memory.remember({ content: '在 dsh-memory 修了 BOM 的坑', type: 'episodic' })
  await memory.remember({ content: 'dsh-memory 的面板加了三页签', type: 'episodic' })
  const graphHits = await memory.recall({ query: 'dsh-memory', topK: 10 })
  assert.equal(graphHits.hits[0].content, '在 dsh-memory 修了 BOM 的坑', 'graph density ranks the denser entry first')

  // P2 archive: decayed entries leave the live set but stay recoverable
  const aging = await memory.remember({ content: '陈年旧事', type: 'episodic', importance: 0.1 })
  records.get(aging.id).last_accessed_at = Date.now() - 90 * 86400000 // three half-lives
  const archivedResult = await memory.archiveBelow(0.05)
  assert.ok(archivedResult.archived >= 1, 'archiveBelow flags decayed entries')
  assert.equal(records.get(aging.id).archived, true)
  const live = await memory.list({})
  assert.ok(!live.some((entry) => entry.content === '陈年旧事'), 'archived entries leave the default listing')
  const archivedList = await memory.list({ archived: true })
  assert.ok(archivedList.some((entry) => entry.content === '陈年旧事'), 'archived listing includes them')
  const recallLive = await memory.recall({ topK: 20 })
  assert.ok(!recallLive.hits.some((entry) => entry.content === '陈年旧事'), 'recall skips archived entries')
  await memory.unarchive(aging.id)
  assert.equal(records.get(aging.id).archived, false, 'unarchive restores')
  const statsAfter = await memory.stats()
  assert.ok('archived' in statsAfter, 'stats reports the archived total')

  // P2 graph data: cards carry embedded relations; the core graph keeps
  // only stable (weight ≥ 2) co-occurrence edges
  await memory.remember({ content: 'dsh-memory 的 BOM 问题复盘', type: 'episodic' })
  const graphData = await memory.graphData()
  assert.ok(Array.isArray(graphData.cards) && Array.isArray(graphData.graph.nodes), 'graph data shape')
  assert.ok(graphData.cards.some((node) => node.text === 'dsh-memory'), 'shared entity appears in cards')
  assert.ok(graphData.cards.some((node) => Array.isArray(node.relations)), 'cards embed their relations')
  assert.ok(graphData.graph.edges.some((edge) => edge.weight >= 2), 'core keeps stable edges')
  assert.ok(graphData.graph.edges.every((edge) => edge.weight >= 2), 'one-off edges stay out of the core')
  assert.ok(graphData.graph.nodes.every((node) => node.degree >= 1), 'core nodes are connected')

  assert.equal(routes.length, 8, 'panel API routes registered (stats/list/graph/remember/forget/purge/unarchive/export)')
  assert.ok(!routes.some((route) => route.path.startsWith('/memory/remote/')), 'remote routes off by default')

  // hard delete: purge removes the record entirely, no tombstone
  const doomed = await memory.remember({ content: '将被永久删除', type: 'episodic' })
  assert.ok(records.get(doomed.id) !== undefined)
  const purged = await memory.purge(doomed.id)
  assert.equal(purged.ok, true)
  assert.equal(records.get(doomed.id), undefined, 'purge removes the record entirely')
  const missing = await memory.purge(doomed.id)
  assert.equal(missing.ok, false, 'purging a missing id fails cleanly')

  // ── P3 remote API: token gate on every endpoint ──
  const remote = await mountHub({ server: { enabled: true, token: 'sekret' } })
  const remotePaths = remote.routes.map((route) => route.path)
  for (const path of ['/memory/remote/stats', '/memory/remote/list', '/memory/remote/recall',
    '/memory/remote/remember', '/memory/remote/forget', '/memory/remote/purge', '/memory/remote/export']) {
    assert.ok(remotePaths.includes(path), `remote route ${path} registered`)
  }
  const rememberRoute = remote.routes.find((route) => route.path === '/memory/remote/remember')
  const denied = fakeRes()
  await rememberRoute.handler(postReq('Bearer wrong', JSON.stringify({ content: 'x' })), denied)
  assert.equal(denied.code, 401, 'wrong token is rejected')
  const granted = fakeRes()
  await rememberRoute.handler(postReq('Bearer sekret', JSON.stringify({ content: '远程写入', type: 'semantic' })), granted)
  assert.equal(granted.code, 200, 'valid token passes')
  assert.equal(JSON.parse(granted.body).created, true)

  // ── P3 embedding seam: a provided provider replaces the n-gram path ──
  const provider = {
    rank: async (texts) => texts.map((text) => (text.includes('prov-fav') ? 1 : 0)),
  }
  const embedded = await mountHub({}, (name) => (name === 'memoryEmbedding' ? provider : undefined))
  await embedded.memory.remember({ content: 'prov-fav 特殊记忆' })
  await embedded.memory.remember({ content: '普通记忆' })
  const embeddedHits = await embedded.memory.recall({ query: '任意', topK: 10 })
  assert.equal(embeddedHits.hits[0].content, 'prov-fav 特殊记忆', 'provided embedding scores win')

  console.log('hub-test: all assertions passed')
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })))
}

main().catch((error) => { console.error(error); process.exit(1) })
