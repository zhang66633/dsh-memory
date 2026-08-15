/**
 * dsh-memory — browser half: the memory panel in the Plugins settings section.
 *
 * Registers a `settings.plugins.tab` page: stats row, labeled add form
 * (type / scope / importance), timeline list with per-entry delete, and JSON
 * export. All data goes through the hub's `/memory/api/*` routes on the local
 * web server.
 *
 * @module dsh-memory/client
 */
import { createElement as h, useEffect, useState } from 'react'
import cssText from './panel.css'

/** Plugin name; also the client bundle id. */
export const name = 'dsh-memory'

/** Required services: the settings slot registry. */
export const inject = ['slots']

const API = '/memory/api'
const TYPES = ['semantic', 'episodic', 'procedural', 'preference', 'insight']
const TYPE_LABEL = {
  semantic: '事实', episodic: '事件', procedural: '方法',
  preference: '偏好', insight: '洞察',
}
const SOURCE_LABEL = { panel: '面板', tool: '工具', extraction: '抽取' }
const clamp01 = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback
}

function MemoryPanel() {
  const [stats, setStats] = useState(null)
  const [entries, setEntries] = useState([])
  const [content, setContent] = useState('')
  const [type, setType] = useState('episodic')
  const [scope, setScope] = useState('user')
  const [importance, setImportance] = useState('0.6')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = async () => {
    try {
      const [statsRes, listRes] = await Promise.all([
        fetch(`${API}/stats`), fetch(`${API}/list`),
      ])
      setStats(await statsRes.json())
      setEntries(await listRes.json())
      setError('')
    } catch (cause) {
      setError(`面板接口不可用：${cause?.message ?? cause}（重启 dsh web 后重试）`)
    }
  }
  useEffect(() => { void refresh() }, [])

  const add = async () => {
    if (!content.trim() || busy) return
    setBusy(true)
    try {
      const res = await fetch(`${API}/remember`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content, type, scope, importance: clamp01(importance, 0.6),
        }),
      })
      const result = await res.json()
      setError(result.created === false ? '已合并到同内容记忆' : '')
      setContent('')
      await refresh()
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    } finally {
      setBusy(false)
    }
  }

  const forget = async (id) => {
    await fetch(`${API}/forget`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    await refresh()
  }

  const exportAll = async () => {
    const res = await fetch(`${API}/export`)
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `dsh-memory-export-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const metaOf = (entry) => [
    entry.scope,
    `★${entry.importance}`,
    ...(entry.unverified === true ? ['待验证'] : []),
    ...(entry.access_count > 0 ? [`引用${entry.access_count}`] : []),
    ...(entry.source?.agent ? [SOURCE_LABEL[entry.source.agent] ?? entry.source.agent] : []),
    new Date(entry.created_at).toLocaleString(),
  ].join(' · ')

  return h('div', { className: 'mem-panel' },
    h('div', { className: 'mem-row mem-head' },
      h('div', { className: 'mem-title' }, '记忆面板'),
      h('div', { className: 'mem-actions' },
        h('button', { className: 'mem-btn', onClick: () => { void refresh() } }, '刷新'),
        h('button', { className: 'mem-btn', onClick: () => { void exportAll() } }, '导出 JSON'),
      ),
    ),
    stats !== null && h('div', { className: 'mem-stats' },
      `共 ${stats.total} 条 · `,
      Object.entries(stats.byType ?? {}).map(([key, count]) =>
        `${TYPE_LABEL[key] ?? key} ${count}`).join(' · '),
    ),
    h('div', { className: 'mem-form' },
      h('textarea', {
        className: 'mem-input', rows: 3, placeholder: '写一条记忆…',
        value: content, onChange: (event) => setContent(event.target.value),
      }),
      h('div', { className: 'mem-row mem-form-controls' },
        h('label', { className: 'mem-field' },
          h('span', { className: 'mem-label' }, '类型'),
          h('select', {
            className: 'mem-select', value: type,
            onChange: (event) => setType(event.target.value),
          }, TYPES.map((t) => h('option', { key: t, value: t }, TYPE_LABEL[t]))),
        ),
        h('label', { className: 'mem-field' },
          h('span', { className: 'mem-label' }, '范围'),
          h('input', {
            className: 'mem-select', value: scope,
            placeholder: 'user 或 workspace:路径',
            onChange: (event) => setScope(event.target.value),
          }),
        ),
        h('label', { className: 'mem-field mem-field-narrow' },
          h('span', { className: 'mem-label' }, '重要性'),
          h('input', {
            className: 'mem-select', type: 'number', min: 0, max: 1, step: 0.1,
            value: importance, onChange: (event) => setImportance(event.target.value),
          }),
        ),
        h('button', { className: 'mem-btn mem-btn-primary', disabled: busy, onClick: () => { void add() } }, busy ? '写入中…' : '记住'),
      ),
    ),
    error && h('div', { className: 'mem-error' }, error),
    h('div', { className: 'mem-list' },
      entries.length === 0
        ? h('div', { className: 'mem-empty' }, '还没有记忆。写一条，或让模型用 memory_remember 工具。')
        : entries.map((entry) => h('div', {
          key: entry.id,
          className: `mem-item${entry.unverified === true ? ' mem-item-unverified' : ''}`,
        },
          h('div', { className: 'mem-item-main' },
            h('span', { className: `mem-type mem-type-${entry.type}` }, TYPE_LABEL[entry.type] ?? entry.type),
            h('span', { className: 'mem-content', title: entry.id }, entry.content),
            h('span', { className: 'mem-meta', title: metaOf(entry) }, metaOf(entry)),
          ),
          h('button', {
            className: 'mem-del', title: '删除（软删除）',
            onClick: () => { void forget(entry.id) },
          }, '✕'),
        )),
    ),
  )
}

/**
 * Client plugin body: register the memory panel twice —
 * 1. the Plugins-settings tab (发现路径：设置 → 插件 → 记忆);
 * 2. the conversation view ring (顶部页签，与「对话/轨迹/插件商店」并列),
 *    the primary surface — the ring renders it in the wide main area.
 */
export function apply(ctx) {
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'memory',
    order: 60,
    label: '记忆',
  }, MemoryPanel))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'memory',
    order: 15,
    label: () => '记忆',
  }, MemoryPanel))

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-memory'
    style.textContent = cssText
    document.head.appendChild(style)
    return () => style.remove()
  }, 'dsh-memory: stylesheet')
}
