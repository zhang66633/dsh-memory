#!/usr/bin/env node
/**
 * dsh-memory — external-agent CLI (P1).
 *
 * Reads and writes `~/.dsh/storages/memory.json` in the documented format
 * (docs/external-format.md) using the same semantics module as the plugin
 * (lib/external.js): write-time dedup merge, soft delete, retrieval scoring.
 * Writes are atomic (tmp + rename) and refuse to clobber a file another
 * process changed after the read.
 *
 * Usage:
 *   node scripts/memory-cli.mjs list   [--scope s] [--type t] [--all]
 *   node scripts/memory-cli.mjs recall [query] [--top n] [--scope s]
 *   node scripts/memory-cli.mjs remember --content "…" [--type t] [--scope s] [--importance 0.6] [--confidence 1]
 *   node scripts/memory-cli.mjs forget <id> | restore <id>
 *   node scripts/memory-cli.mjs purge <id>     # 永久删除（不可恢复）
 *   node scripts/memory-cli.mjs stats
 *   node scripts/memory-cli.mjs export
 * Env: MEMORY_FILE overrides the file path; DSH_HOME moves the default root.
 *
 * @module dsh-memory/memory-cli
 */
import os from 'node:os'
import { join } from 'node:path'
import {
  ENTRIES_TABLE,
  MEMORY_TYPES,
  atomicWrite,
  createRecord,
  entryKey,
  loadMemoryFile,
  mergeEntry,
  scoreEntry,
  serializeDocument,
} from '../lib/external.js'

const TYPE_LABEL = {
  semantic: '事实', episodic: '事件', procedural: '方法',
  preference: '偏好', insight: '洞察',
}

const DEFAULT_FILE = join(process.env.DSH_HOME ?? join(os.homedir(), '.dsh'), 'storages', 'memory.json')
const FILE = process.env.MEMORY_FILE ?? DEFAULT_FILE

/** Minimal argv parse: --key value pairs plus a leading subcommand/args. */
function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next
        i++
      } else {
        options[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, options }
}

function fail(message) {
  console.error(`memory-cli: ${message}`)
  process.exit(1)
}

const entriesOf = (document) => document.tables?.[ENTRIES_TABLE] ?? {}

function listEntries(document, { scope, type, all }) {
  let entries = Object.values(entriesOf(document))
  if (!all) entries = entries.filter((r) => !r.tombstone)
  if (scope) entries = entries.filter((r) => r.scope === scope)
  if (type) entries = entries.filter((r) => r.type === type)
  entries.sort((a, b) => b.created_at - a.created_at)
  return entries
}

async function main() {
  const { positional: [command, ...rest], options } = parseArgs(process.argv.slice(2))
  if (command === undefined) {
    console.log('dsh-memory external CLI — 用法见本文件头部注释 / docs/external-format.md')
    return
  }

  if (command === 'list') {
    const { document } = await loadMemoryFile(FILE)
    for (const entry of listEntries(document, {
      scope: options.scope, type: options.type, all: options.all === true,
    })) {
      const flag = entry.tombstone ? ' [已删除]' : entry.unverified === true ? ' [待验证]' : ''
      console.log(`[${TYPE_LABEL[entry.type] ?? entry.type}] ${entry.content}${flag}`)
      console.log(`  ${entry.scope} · ★${entry.importance} · 引用${entry.access_count} · ${entry.id}`)
    }
    return
  }

  if (command === 'recall') {
    const { document } = await loadMemoryFile(FILE)
    const query = rest[0] ?? ''
    let entries = Object.values(entriesOf(document)).filter((r) => !r.tombstone)
    if (options.scope) entries = entries.filter((r) => r.scope === options.scope)
    const top = Number(options.top) || 5
    entries
      .map((entry) => ({ entry, s: scoreEntry(entry, query) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, top)
      .forEach(({ entry, s }) => {
        console.log(`[${TYPE_LABEL[entry.type] ?? entry.type}] ${entry.content}  (score=${s.toFixed(2)}, ${entry.scope})`)
      })
    return
  }

  if (command === 'stats') {
    const { document } = await loadMemoryFile(FILE)
    const live = Object.values(entriesOf(document)).filter((r) => !r.tombstone)
    const byType = {}
    const byScope = {}
    for (const entry of live) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1
      byScope[entry.scope] = (byScope[entry.scope] ?? 0) + 1
    }
    console.log(`共 ${live.length} 条（含 ${Object.keys(entriesOf(document)).length - live.length} 条软删除）`)
    console.log('按类型:', Object.entries(byType).map(([t, n]) => `${TYPE_LABEL[t] ?? t} ${n}`).join(' · ') || '无')
    console.log('按范围:', Object.entries(byScope).map(([s, n]) => `${s} ${n}`).join(' · ') || '无')
    return
  }

  if (command === 'export') {
    const { document } = await loadMemoryFile(FILE)
    console.log(serializeDocument(document).trimEnd())
    return
  }

  if (command === 'remember') {
    if (!options.content) fail('remember 需要 --content "记忆内容"')
    const type = options.type ?? 'semantic'
    if (!MEMORY_TYPES.includes(type)) fail(`--type 必须是 ${MEMORY_TYPES.join('/')}`)
    console.error('提示：若 dsh 正在运行，本次写入可能被插件的下一次写入覆盖（文档 §5）。')
    const { path, mtimeMs, document } = await loadMemoryFile(FILE)
    const entries = entriesOf(document)
    const candidate = {
      content: options.content,
      type,
      scope: options.scope ?? 'user',
      importance: Number(options.importance) || 0.6,
      confidence: Number(options.confidence) || 1,
    }
    const existing = Object.values(entries)
      .find((r) => !r.tombstone && entryKey(r) === entryKey(candidate))
    let id
    if (existing !== undefined) {
      mergeEntry(existing, candidate, { agent: 'cli', at: Date.now() })
      id = existing.id
      console.log(`已合并到同内容记忆: ${id}`)
    } else {
      const record = createRecord(candidate, { agent: 'cli', at: Date.now() })
      entries[record.id] = record
      id = record.id
      console.log(`已写入: ${id}`)
    }
    document.tables = { ...document.tables, [ENTRIES_TABLE]: entries }
    await atomicWrite(path, serializeDocument(document), mtimeMs)
    return
  }

  if (command === 'forget' || command === 'restore') {
    const id = rest[0]
    if (!id) fail(`${command} 需要记忆 id`)
    const { path, mtimeMs, document } = await loadMemoryFile(FILE)
    const entries = entriesOf(document)
    const record = entries[id]
    if (record === undefined) fail(`找不到记忆 '${id}'`)
    record.tombstone = command === 'forget'
    document.tables = { ...document.tables, [ENTRIES_TABLE]: entries }
    await atomicWrite(path, serializeDocument(document), mtimeMs)
    console.log(command === 'forget' ? `已软删除: ${id}` : `已恢复: ${id}`)
    return
  }

  if (command === 'purge') {
    const id = rest[0]
    if (!id) fail('purge 需要记忆 id')
    const { path, mtimeMs, document } = await loadMemoryFile(FILE)
    const entries = entriesOf(document)
    if (entries[id] === undefined) fail(`找不到记忆 '${id}'`)
    delete entries[id]
    document.tables = { ...document.tables, [ENTRIES_TABLE]: entries }
    await atomicWrite(path, serializeDocument(document), mtimeMs)
    console.log(`已永久删除: ${id}`)
    return
  }

  fail(`未知命令 '${command}'（支持 list/recall/stats/export/remember/forget/restore/purge）`)
}

main().catch((error) => fail(error?.message ?? error))
