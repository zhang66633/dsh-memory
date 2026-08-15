/**
 * dsh-memory — external format implementation (P1).
 *
 * The documented `~/.dsh/storages/memory.json` semantics as pure functions:
 * record creation and merge, retrieval scoring, document validation, and
 * atomic write with optimistic concurrency. The hub service and the
 * external-agent CLI (scripts/memory-cli.mjs) share this module, so an
 * external write behaves exactly like a plugin write — the single source of
 * truth for docs/external-format.md.
 *
 * @module dsh-memory/external
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Memory entry types (LangMem four + preference + insight). */
export const MEMORY_TYPES = ['semantic', 'episodic', 'procedural', 'preference', 'insight']

/** Domain identity stamped into the unit header. */
export const MEMORY_DOMAIN = 'memory'
export const UNIT_VERSION = 1
export const ENTRIES_TABLE = 'entries'

/** Ebbinghaus half-life: days until an untouched entry halves its recency factor. */
const HALF_LIFE_DAYS = 30

const clamp01 = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback
}

/**
 * Retrieval score: importance × confidence × recency decay, halved for
 * unverified entries, plus a keyword boost when the query text appears in
 * the content. Mirrors the plugin's recall ranking exactly.
 * @param entry - one memory record.
 * @param query - optional keyword/theme to boost.
 * @param t - evaluation time (Unix ms); defaults to now.
 */
export function scoreEntry(entry, query = '', t = Date.now()) {
  const halfLifeMs = (entry.half_life_days ?? HALF_LIFE_DAYS) * 86400000
  const since = t - (entry.last_accessed_at ?? entry.created_at ?? t)
  const decay = 2 ** (-since / halfLifeMs)
  const q = String(query ?? '').trim().toLowerCase()
  const boost = q && String(entry.content ?? '').toLowerCase().includes(q)
    ? 2 * (entry.importance ?? 0.5)
    : 0
  const unverified = entry.unverified === true ? 0.5 : 1
  return (entry.importance ?? 0.5) * (entry.confidence ?? 1) * decay * unverified + boost
}

/**
 * Build one new record from a candidate (normalizing every field).
 * @param candidate - content/type/scope/importance/confidence/unverified.
 * @param source - provenance `{agent, session?, turn?, at}`.
 */
export function createRecord(candidate, source = {}) {
  const content = String(candidate.content ?? '').trim()
  if (!content) throw new Error('memory content must be a non-empty string')
  const now = Date.now()
  return {
    id: `mem_${now}_${randomUUID().slice(0, 8)}`,
    type: MEMORY_TYPES.includes(candidate.type) ? candidate.type : 'semantic',
    content,
    scope: String(candidate.scope ?? 'user').trim() || 'user',
    importance: clamp01(candidate.importance, 0.5),
    confidence: clamp01(candidate.confidence, 1),
    unverified: candidate.unverified === true,
    half_life_days: HALF_LIFE_DAYS,
    created_at: now,
    last_accessed_at: now,
    access_count: 0,
    tombstone: false,
    archived: false,
    source,
  }
}

/**
 * Merge a re-written memory into its existing record (write-time dedup).
 * Takes the higher importance, adopts the new write's verification verdict,
 * refreshes access, and replaces the source.
 * @param existing - the record already stored under the same content+scope.
 * @param candidate - the new write (may hold only the changed fields).
 * @param source - provenance replacing the stored source.
 */
export function mergeEntry(existing, candidate, source = {}) {
  existing.importance = Math.max(existing.importance ?? 0.5, clamp01(candidate.importance, 0.5))
  existing.unverified = candidate.unverified === true
  existing.last_accessed_at = Date.now()
  existing.access_count = (existing.access_count ?? 0) + 1
  existing.source = source
  return existing
}

/** The normalized scope and content key that identify a duplicate write. */
export function entryKey(entry) {
  return `${String(entry.scope ?? 'user').trim() || 'user'}\u0000${String(entry.content ?? '').trim()}`
}

/**
 * Validate a parsed document against the documented format; throws with a
 * specific message on any violation.
 * @param document - parsed JSON value.
 * @returns the same document.
 */
export function validateDocument(document) {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error('memory file must contain a JSON object')
  }
  const unit = document.unit
  if (typeof unit !== 'object' || unit === null
    || unit.name !== MEMORY_DOMAIN
    || unit.version !== UNIT_VERSION) {
    throw new Error(`memory file must declare unit ${MEMORY_DOMAIN} version ${UNIT_VERSION}`)
  }
  const tables = document.tables
  if (tables !== undefined
    && (typeof tables !== 'object' || tables === null || Array.isArray(tables))) {
    throw new Error('memory file tables must be an object')
  }
  const entries = tables?.[ENTRIES_TABLE]
  if (entries !== undefined
    && (typeof entries !== 'object' || entries === null || Array.isArray(entries))) {
    throw new Error(`memory file table '${ENTRIES_TABLE}' must be an object`)
  }
  return document
}

/**
 * Load and validate one memory file; also captures its mtime for optimistic
 * concurrency on the next write.
 * @param path - absolute file path.
 * @returns `{path, mtimeMs, document}`; a missing file loads as an empty unit.
 */
export async function loadMemoryFile(path) {
  let text
  let mtimeMs = 0
  try {
    const info = await stat(path)
    mtimeMs = info.mtimeMs
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    text = JSON.stringify({
      unit: { name: MEMORY_DOMAIN, version: UNIT_VERSION },
      global: { last_extracted: {} },
      tables: { [ENTRIES_TABLE]: {} },
    })
  }
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`memory file is not valid JSON: ${error?.message ?? error}`)
  }
  validateDocument(document)
  return { path, mtimeMs, document }
}

/** Serialize one document in the canonical on-disk shape (trailing newline). */
export function serializeDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * Atomically replace the file, refusing when another process changed it
 * after the caller's read (the plugin rewrites the whole file on every
 * write; a concurrent edit would otherwise be silently lost).
 * @param path - absolute file path.
 * @param text - complete new content.
 * @param expectedMtimeMs - mtime captured by the load this write is based on.
 */
export async function atomicWrite(path, text, expectedMtimeMs) {
  if (expectedMtimeMs > 0) {
    const current = await stat(path)
    if (current.mtimeMs !== expectedMtimeMs) {
      throw new Error(`memory file changed on disk since it was read (mtime ${current.mtimeMs}); re-read and retry`)
    }
  }
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}
