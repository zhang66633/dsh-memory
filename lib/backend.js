/**
 * dsh-memory — self-owned file backend (P3.5).
 *
 * Implements the DSH storage hub's KvFacet contract (duck-typed, zero
 * harness imports) over the documented unit file format, so the plugin owns
 * its storage medium outright: `config.storage.root` points the memory unit
 * file anywhere — including an Obsidian vault folder — without moving the
 * harness's other domains. The on-disk format is the same
 * `{unit, global, tables}` document the external-agent CLI writes, so the
 * plugin, the CLI, and third-party tools share one file as the single source
 * of truth.
 *
 * Memory is authoritative; every mutation republishes the whole file
 * atomically (tmp + rename).
 *
 * @module dsh-memory/backend
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ENTRIES_TABLE, atomicWrite, loadUnitFile, serializeDocument } from './external.js'

/** Backend name registered on the DSH storage hub. */
export const BACKEND_NAME = 'memory'

/** The unit identity this backend serves. */
export const UNIT_DESCRIPTOR = Object.freeze({
  name: 'memory',
  version: 1,
  tables: [ENTRIES_TABLE],
  hasGlobal: true,
})

/** One file-backed unit: the parsed document is authoritative in memory. */
class MemoryFileUnit {
  constructor(root, descriptor) {
    this.root = root
    this.descriptor = descriptor
    this.path = join(root, `${descriptor.name}.json`)
    this.document = null
    this.closed = false
  }

  async init() {
    await mkdir(this.root, { recursive: true })
    this.document = (await loadUnitFile(this.path, this.descriptor)).document
  }

  assertOpen() {
    if (this.closed) throw new Error(`unit '${this.descriptor.name}' is closed`)
  }

  async loadAll() {
    this.assertOpen()
    const tables = {}
    for (const table of this.descriptor.tables) tables[table] = { ...(this.document.tables?.[table] ?? {}) }
    return { tables, global: this.document.global ?? null }
  }

  /** Live in-memory snapshot: sync reads for the hub's hot paths. */
  snapshot() {
    this.assertOpen()
    return { tables: this.document.tables ?? {}, global: this.document.global ?? null }
  }

  async putRecord(table, key, value) {
    this.assertOpen()
    this.document.tables ??= {}
    this.document.tables[table] ??= {}
    this.document.tables[table][key] = value
    await this.publish()
  }

  async deleteRecord(table, key) {
    this.assertOpen()
    const records = this.document.tables?.[table]
    if (records !== undefined && key in records) {
      delete records[key]
      await this.publish()
    }
  }

  async setGlobal(value) {
    this.assertOpen()
    this.document.global = value
    await this.publish()
  }

  async close() {
    if (this.closed) return
    this.closed = true
  }

  /** Atomic whole-file republish; a failed write keeps the in-memory state. */
  async publish() {
    await atomicWrite(this.path, serializeDocument(this.document), 0)
  }
}

/**
 * The self-owned backend: one medium (the configured root directory) and one
 * `memory` unit over it. Registered under {@link BACKEND_NAME} on the storage
 * hub by the hub row.
 */
export class MemoryFileBackend {
  constructor(root) {
    this.root = root
    this.units = new Map()
    this.closed = false
  }

  kv = {
    open: (descriptor) => this.open(descriptor),
  }

  async open(descriptor) {
    if (this.closed) throw new Error('memory backend is closed')
    if (this.units.has(descriptor.name)) {
      throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
    }
    const unit = new MemoryFileUnit(this.root, descriptor)
    await unit.init()
    this.units.set(descriptor.name, unit)
    return unit
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled([...this.units.values()].map((unit) => unit.close()))
  }
}
