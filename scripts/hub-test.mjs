/** dsh-memory hub service behavior test over a mocked storageDomain. */
import assert from 'node:assert/strict'
import { apply } from '../lib/hub.js'

function makeDomain() {
  const records = new Map()
  let globalValue = { last_extracted: {} }
  const domain = {
    global: {
      get: () => globalValue,
      set: async (value) => { globalValue = value },
    },
    table: (name) => ({
      entries: () => records.entries(),
      put: async (key, value) => { records.set(key, value) },
      get: (key) => records.get(key),
    }),
    close: async () => {},
  }
  return { domain, records }
}

async function main() {
  const { domain, records } = makeDomain()
  const routes = []
  const provided = {}
  const ctx = {
    storageDomain: { open: async (spec) => {
      assert.equal(spec.name, 'memory')
      assert.ok(spec.global, 'spec declares the watermark global')
      return domain
    } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn, label) => { void fn(); return () => {} },
    provide: (name, value) => { provided[name] = value },
  }
  apply(ctx, { importanceLearningRate: 0.01 })
  const memory = provided.memory

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

  assert.equal(routes.length, 5, 'panel API routes registered')
  console.log('hub-test: all assertions passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
