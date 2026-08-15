/**
 * dsh-memory — host-plane hub.
 *
 * One process-singleton MemoryService (`ctx.provide('memory', …)`) that every
 * session, subagent, and workflow worker shares. Persistence rides the DSH
 * storage service: the `memory` domain is opened over whichever backend the
 * deployment routes it to (`dsh-storage-domain` config; default json at
 * `~/.dsh/storages`), so the storage location is a config choice, not code.
 * The spec is duck-typed (identity valueSchema) so this third-party package
 * needs no zod / harness imports at all.
 *
 * Record creation/merge and scoring semantics come from lib/external.js —
 * the same module the external-agent CLI uses, so external writes behave
 * exactly like plugin writes.
 *
 * Panel API (webServer routes): stats / list / remember / forget / export.
 *
 * @module dsh-memory/hub
 */
import { ENTRIES_TABLE, MEMORY_TYPES, createRecord, entryKey, mergeEntry, scoreEntry } from './external.js'

export { MEMORY_TYPES }

/** Plugin row id (bare package name: carries the dsh.client manifest for the browser roster). */
export const name = 'dsh-memory'

/** Required services: the storage domain facility and the web route registry. */
export const inject = ['storageDomain', 'webServer']

const now = () => Date.now()

/**
 * Mount the hub.
 * @param ctx - cordis context (host plane).
 * @param config - plugin config (recall defaults).
 */
export function apply(ctx, config = {}) {
  const recallTopK = config.recallTopK ?? 5
  const recallBudget = config.recallBudget ?? 1500
  const importanceLearningRate = config.importanceLearningRate ?? 0.01

  let domain = null
  const ready = new Promise((resolve, reject) => {
    ctx.effect(() => {
      ctx.storageDomain.open({
        name: 'memory',
        version: 1,
        tables: { [ENTRIES_TABLE]: { valueSchema: { parse: (value) => value } } },
        global: {
          schema: { parse: (value) => value },
          initial: { last_extracted: {} },
        },
      }).then((opened) => { domain = opened; resolve(opened) }, reject)
      return async () => {
        if (domain !== null) {
          const closing = domain
          domain = null
          await closing.close()
        }
      }
    }, 'dsh-memory: domain open')
  })

  const table = async () => (await ready).table(ENTRIES_TABLE)
  const allEntries = async () => [...(await table()).entries()].map(([, value]) => value)

  const service = {
    /** Write one memory; semantic-duplicate detection merges into an existing entry. */
    async remember(entry, source = {}) {
      const candidate = {
        content: String(entry.content ?? '').trim(),
        type: entry.type,
        scope: String(entry.scope ?? 'user').trim() || 'user',
        importance: entry.importance,
        confidence: entry.confidence,
        unverified: entry.unverified,
      }
      if (!candidate.content) throw new Error('memory content must be a non-empty string')
      const records = await allEntries()
      const duplicate = records.find((r) => !r.tombstone && entryKey(r) === entryKey(candidate))
      if (duplicate !== undefined) {
        mergeEntry(duplicate, candidate, source)
        await (await table()).put(duplicate.id, duplicate)
        return { id: duplicate.id, created: false }
      }
      const record = createRecord(candidate, source)
      await (await table()).put(record.id, record)
      return { id: record.id, created: true }
    },

    /** Rank memories by score (plus a keyword boost) and render within a char budget. */
    async recall({ query, scopes, topK = recallTopK, budget = recallBudget } = {}) {
      const entries = (await allEntries()).filter((r) => !r.tombstone)
      const wanted = new Set(scopes ?? [])
      const scoped = entries.filter((r) => wanted.size === 0 || wanted.has(r.scope))
      const ranked = scoped.map((entry) => ({ entry, s: scoreEntry(entry, query) }))
      ranked.sort((a, b) => b.s - a.s)
      const hits = []
      const t = await table()
      for (const { entry } of ranked.slice(0, topK)) {
        entry.last_accessed_at = now()
        entry.access_count = (entry.access_count ?? 0) + 1
        entry.importance = Math.min(1, (entry.importance ?? 0.5) + importanceLearningRate)
        await t.put(entry.id, entry)
        hits.push({ ...entry, recall_score: Math.round(scoreEntry(entry) * 100) / 100 })
      }
      let text = ''
      for (const hit of hits) {
        const line = `[${hit.type}] ${hit.content}`
        if (text.length + line.length > budget) break
        text += (text ? '\n' : '') + line
      }
      return { hits, text }
    },

    /** Soft-delete a memory (tombstone; recoverable). */
    async forget(id) {
      const t = await table()
      const record = t.get(id)
      if (record === undefined) return { ok: false, error: `memory '${id}' not found` }
      record.tombstone = true
      await t.put(id, record)
      return { ok: true }
    },

    /** Undo a soft delete. */
    async restore(id) {
      const t = await table()
      const record = t.get(id)
      if (record === undefined) return { ok: false, error: `memory '${id}' not found` }
      record.tombstone = false
      await t.put(id, record)
      return { ok: true }
    },

    /** Panel listing: live entries, newest first, optionally filtered. */
    async list({ scope, type } = {}) {
      let entries = (await allEntries()).filter((r) => !r.tombstone)
      if (scope) entries = entries.filter((r) => r.scope === scope)
      if (type) entries = entries.filter((r) => r.type === type)
      entries.sort((a, b) => b.created_at - a.created_at)
      return entries
    },

    /** Panel stats. */
    async stats() {
      const entries = (await allEntries()).filter((r) => !r.tombstone)
      const byType = {}
      const byScope = {}
      for (const entry of entries) {
        byType[entry.type] = (byType[entry.type] ?? 0) + 1
        byScope[entry.scope] = (byScope[entry.scope] ?? 0) + 1
      }
      return { total: entries.length, byType, byScope }
    },

    /** Full export (migration / backup). */
    async exportAll() {
      return { generated_at: new Date().toISOString(), entries: await allEntries() }
    },

    /**
     * Extraction watermark: last session-event seq already mined (persisted,
     * keyed per session — seqs are per-session counters, never comparable
     * across sessions).
     * @param sessionId - the session whose watermark to read.
     */
    async extractionWatermark(sessionId) {
      const opened = await ready
      const last = opened.global.get().last_extracted ?? {}
      return last[String(sessionId)] ?? 0
    },

    /**
     * Advance one session's extraction watermark (idempotent: only moves
     * forward). The map is pruned to the 64 most recently written sessions.
     * @param sessionId - the session whose watermark to advance.
     * @param seq - the last session-event seq mined.
     */
    async setExtractionWatermark(sessionId, seq) {
      const opened = await ready
      const current = opened.global.get()
      const last = { ...(current.last_extracted ?? {}) }
      const key = String(sessionId)
      last[key] = Math.max(last[key] ?? 0, Number(seq) || 0)
      const keys = Object.keys(last)
      if (keys.length > 64) {
        for (const stale of keys.slice(0, keys.length - 64)) delete last[stale]
      }
      await opened.global.set({ ...current, last_extracted: last })
      return { ok: true, watermark: last[key] }
    },
  }

  ctx.provide('memory', service)

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try { resolve(body === '' ? {} : JSON.parse(body)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
  const query = (req) => new URL(req.url ?? '/', 'http://x').searchParams

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/memory/api/stats',
    handler: async (_req, res) => json(res, 200, await service.stats()),
  }), 'dsh-memory: stats route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/memory/api/list',
    handler: async (req, res) => json(res, 200, await service.list({
      scope: query(req).get('scope') ?? undefined,
      type: query(req).get('type') ?? undefined,
    })),
  }), 'dsh-memory: list route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/memory/api/remember',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      try {
        const body = await readBody(req)
        json(res, 200, await service.remember(body, { agent: 'panel', at: now() }))
      } catch (error) {
        json(res, 400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-memory: remember route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/memory/api/forget',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
      const body = await readBody(req)
      json(res, 200, await service.forget(String(body.id ?? '')))
    },
  }), 'dsh-memory: forget route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/memory/api/export',
    handler: async (_req, res) => json(res, 200, await service.exportAll()),
  }), 'dsh-memory: export route')
}
