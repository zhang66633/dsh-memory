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
 * Panel API (webServer routes): stats / list / remember / forget / export.
 *
 * @module dsh-memory/hub
 */
import { randomUUID } from 'node:crypto'

/** Plugin row id. */
export const name = 'dsh-memory/hub'

/** Required services: the storage domain facility and the web route registry. */
export const inject = ['storageDomain', 'webServer']

/** Memory entry types (LangMem four + preference + insight). */
export const MEMORY_TYPES = ['semantic', 'episodic', 'procedural', 'preference', 'insight']

const TABLE = 'entries'
const now = () => Date.now()

/** Ebbinghaus-style recency decay factor. */
function decay(entry, t = now()) {
  const halfLifeMs = (entry.half_life_days ?? 30) * 86400000
  return 2 ** (-(t - (entry.last_accessed_at ?? entry.created_at)) / halfLifeMs)
}

/** Retrieval score: importance × confidence × recency. */
function score(entry) {
  return (entry.importance ?? 0.5) * (entry.confidence ?? 1) * decay(entry)
}

/**
 * Mount the hub.
 * @param ctx - cordis context (host plane).
 * @param config - plugin config (recall defaults).
 */
export function apply(ctx, config = {}) {
  const recallTopK = config.recallTopK ?? 5
  const recallBudget = config.recallBudget ?? 1500

  let domain = null
  const ready = new Promise((resolve, reject) => {
    ctx.effect(() => {
      ctx.storageDomain.open({
        name: 'memory',
        version: 1,
        tables: { [TABLE]: { valueSchema: { parse: (value) => value } } },
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

  const table = async () => (await ready).table(TABLE)
  const allEntries = async () => [...(await table()).entries()].map(([, value]) => value)

  const service = {
    /** Write one memory; semantic-duplicate detection merges into an existing entry. */
    async remember(entry, source = {}) {
      const content = String(entry.content ?? '').trim()
      if (!content) throw new Error('memory content must be a non-empty string')
      const type = MEMORY_TYPES.includes(entry.type) ? entry.type : 'semantic'
      const scope = String(entry.scope ?? 'user').trim() || 'user'
      const importance = Math.min(1, Math.max(0, Number(entry.importance) || 0.5))
      const records = await allEntries()
      const duplicate = records.find((r) =>
        !r.tombstone && r.content === content && r.scope === scope)
      if (duplicate !== undefined) {
        duplicate.importance = Math.max(duplicate.importance, importance)
        duplicate.last_accessed_at = now()
        duplicate.access_count = (duplicate.access_count ?? 0) + 1
        duplicate.source = source
        await (await table()).put(duplicate.id, duplicate)
        return { id: duplicate.id, created: false }
      }
      const record = {
        id: `mem_${now()}_${randomUUID().slice(0, 8)}`,
        type,
        content,
        scope,
        importance,
        confidence: Math.min(1, Math.max(0, Number(entry.confidence) || 1)),
        half_life_days: 30,
        created_at: now(),
        last_accessed_at: now(),
        access_count: 0,
        tombstone: false,
        source,
      }
      await (await table()).put(record.id, record)
      return { id: record.id, created: true }
    },

    /** Rank memories by score (plus a keyword boost) and render within a char budget. */
    async recall({ query, scopes, topK = recallTopK, budget = recallBudget } = {}) {
      const entries = (await allEntries()).filter((r) => !r.tombstone)
      const wanted = new Set(scopes ?? [])
      const scoped = entries.filter((r) => wanted.size === 0 || wanted.has(r.scope))
      const q = String(query ?? '').trim().toLowerCase()
      const ranked = scoped.map((entry) => ({
        entry,
        s: score(entry) + (q && entry.content.toLowerCase().includes(q) ? 2 * (entry.importance ?? 0.5) : 0),
      }))
      ranked.sort((a, b) => b.s - a.s)
      const hits = []
      const t = await table()
      for (const { entry } of ranked.slice(0, topK)) {
        entry.last_accessed_at = now()
        entry.access_count = (entry.access_count ?? 0) + 1
        await t.put(entry.id, entry)
        hits.push({ ...entry, recall_score: Math.round(score(entry) * 100) / 100 })
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
  }

  ctx.provide('memory', service)

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }
  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
  }
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
