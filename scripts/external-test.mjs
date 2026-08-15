/** dsh-memory external-format test: semantics module + file round-trip + atomicity. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MEMORY_DOMAIN,
  UNIT_VERSION,
  atomicWrite,
  createRecord,
  entryKey,
  loadMemoryFile,
  mergeEntry,
  scoreEntry,
  serializeDocument,
  validateDocument,
} from '../lib/external.js'

const t0 = 1_700_000_000_000

async function main() {
  // record creation normalizes every field
  const record = createRecord({
    content: '  伙伴叫哲  ', type: 'bogus', scope: '', importance: 2, confidence: -1, unverified: true,
  }, { agent: 'test' })
  assert.equal(record.content, '伙伴叫哲')
  assert.equal(record.type, 'semantic', 'unknown type falls back to semantic')
  assert.equal(record.scope, 'user')
  assert.equal(record.importance, 1, 'importance clamps to 1')
  assert.equal(record.confidence, 0, 'confidence clamps to 0')
  assert.equal(record.unverified, true)
  assert.match(record.id, /^mem_\d+_[0-9a-f]{8}$/)

  // merge semantics
  const base = createRecord({ content: 'A', importance: 0.5 }, { agent: 'a' })
  base.created_at = t0
  base.last_accessed_at = t0
  mergeEntry(base, { content: 'A', importance: 0.9, unverified: true }, { agent: 'b' })
  assert.equal(base.importance, 0.9, 'merge takes the higher importance')
  assert.equal(base.unverified, true, 'merge adopts the new write verdict')
  assert.equal(base.access_count, 1)
  assert.ok(base.last_accessed_at > t0, 'merge refreshes access')

  // scoring: decay, unverified halving, keyword boost
  const fresh = { importance: 0.5, confidence: 1, half_life_days: 30, created_at: t0, last_accessed_at: t0 }
  const stale = { ...fresh, last_accessed_at: t0 - 30 * 86400000 } // one half-life
  assert.equal(scoreEntry(stale, '', t0), 0.25, 'one half-life halves the score')
  assert.ok(scoreEntry(fresh, '', t0) > scoreEntry(stale, '', t0), 'decay orders fresh above stale')
  const unverified = { ...fresh, unverified: true }
  assert.equal(scoreEntry(unverified, '', t0), scoreEntry(fresh, '', t0) / 2, 'unverified halves')
  const boosted = scoreEntry({ ...fresh, content: '伙伴叫哲' }, '哲', t0)
  assert.equal(boosted, 0.5 + 1, 'keyword boost adds 2×importance')

  // duplicate key
  assert.equal(entryKey({ scope: 'user', content: ' x ' }), entryKey({ scope: 'user', content: 'x' }))
  assert.notEqual(entryKey({ scope: 'workspace:C:\\x', content: 'x' }), entryKey({ scope: 'user', content: 'x' }))

  // validation
  assert.throws(() => validateDocument({ unit: { name: 'other', version: 1 } }), /unit memory/)
  assert.throws(() => validateDocument({ unit: { name: MEMORY_DOMAIN, version: 2 } }), /version 1/)
  assert.throws(() => validateDocument({ unit: { name: MEMORY_DOMAIN, version: 1 }, tables: [] }), /tables/)

  // file round-trip: missing file → empty unit; write → load; mtime tracking
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  const file = join(dir, 'memory.json')
  try {
    const empty = await loadMemoryFile(file)
    assert.equal(empty.mtimeMs, 0, 'missing file has no mtime')
    assert.deepEqual(Object.keys(empty.document.tables.entries), [])
    const doc = empty.document
    doc.tables.entries['mem_x'] = createRecord({ content: '外部写入', importance: 0.7 }, { agent: 'cli' })
    await atomicWrite(file, serializeDocument(doc), 0)
    const reloaded = await loadMemoryFile(file)
    assert.equal(reloaded.document.tables.entries['mem_x'].content, '外部写入')
    assert.ok(reloaded.mtimeMs > 0)

    // stale-write refusal: modify the file behind the reader's back and
    // force the mtime forward so the millisecond-resolution check is strict
    await writeFile(file, serializeDocument(reloaded.document), 'utf8')
    const later = new Date(reloaded.mtimeMs + 1000)
    await utimes(file, later, later)
    await assert.rejects(
      atomicWrite(file, serializeDocument(doc), reloaded.mtimeMs),
      /changed on disk/,
      'atomicWrite refuses to clobber a concurrent edit',
    )
    const text = await readFile(file, 'utf8')
    assert.ok(text.endsWith('\n'), 'serialized file ends with one newline')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log('external-test: all assertions passed')
}

main().catch((error) => { console.error(error); process.exit(1) })
