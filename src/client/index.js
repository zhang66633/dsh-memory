/**
 * dsh-memory — browser half: the memory panel.
 *
 * Registered in two slots — the Plugins-settings tab (discoverability) and
 * the conversation view ring (primary surface). The panel has three tabs:
 * timeline (add form + entry list), relations (entity cards by default, with
 * an interactive force-graph alternative), and archive (decayed entries with
 * restore). All data goes through the hub's `/memory/api/*` routes.
 *
 * @module dsh-memory/client
 */
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
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
const SOURCE_LABEL = { panel: '面板', tool: '工具', extraction: '抽取', reflection: '反思', consolidation: '整合' }
const KIND_LABEL = {
  path: '路径', identifier: '标识符', version: '版本',
  url: '域名', quoted: '引语', scope: '范围', term: '词',
}
const KIND_CLASS = {
  path: 'mem-kind-brand', identifier: 'mem-kind-success', version: 'mem-kind-warn',
  url: 'mem-kind-label', quoted: 'mem-kind-error', scope: 'mem-kind-brand', term: 'mem-kind-label',
}
const clamp01 = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback
}

const metaOf = (entry) => [
  entry.scope,
  `★${entry.importance}`,
  ...(entry.unverified === true ? ['待验证'] : []),
  ...(entry.access_count > 0 ? [`引用${entry.access_count}`] : []),
  ...(entry.source?.agent ? [SOURCE_LABEL[entry.source.agent] ?? entry.source.agent] : []),
  new Date(entry.created_at).toLocaleString(),
].join(' · ')

function EntryItem({ entry, action }) {
  return h('div', {
    className: `mem-item${entry.unverified === true ? ' mem-item-unverified' : ''}`,
  },
    h('div', { className: 'mem-item-main' },
      h('span', { className: `mem-type mem-type-${entry.type}` }, TYPE_LABEL[entry.type] ?? entry.type),
      h('span', { className: 'mem-content', title: entry.id }, entry.content),
      h('span', { className: 'mem-meta', title: metaOf(entry) }, metaOf(entry)),
    ),
    action && h('button', {
      className: 'mem-del', title: action.title,
      onClick: () => { void action.run() },
    }, action.glyph),
  )
}

const WIDTH = 640
const HEIGHT = 380

/** Light force simulation: repulsion + springs + centering, settled synchronously. */
function layout(nodes, edges, width, height) {
  const positions = new Map(nodes.map((node, i) => {
    const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2
    return [node.text, { x: width / 2 + Math.cos(angle) * 120, y: height / 2 + Math.sin(angle) * 120 }]
  }))
  for (let step = 0; step < 240; step++) {
    const forces = new Map()
    for (const node of nodes) forces.set(node.text, { x: 0, y: 0 })
    for (const a of nodes) {
      const pa = positions.get(a.text)
      forces.get(a.text).x += (width / 2 - pa.x) * 0.01
      forces.get(a.text).y += (height / 2 - pa.y) * 0.01
      for (const b of nodes) {
        if (a.text === b.text) continue
        const pb = positions.get(b.text)
        const dx = pa.x - pb.x
        const dy = pa.y - pb.y
        const dist = Math.sqrt(Math.max(64, dx * dx + dy * dy))
        const push = 1400 / Math.max(64, dist * dist)
        forces.get(a.text).x += (dx / dist) * push
        forces.get(a.text).y += (dy / dist) * push
      }
    }
    for (const edge of edges) {
      const pa = positions.get(edge.source)
      const pb = positions.get(edge.target)
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const pull = (dist - 110) * 0.06
      const fx = (dx / dist) * pull
      const fy = (dy / dist) * pull
      forces.get(edge.source).x += fx
      forces.get(edge.source).y += fy
      forces.get(edge.target).x -= fx
      forces.get(edge.target).y -= fy
    }
    for (const node of nodes) {
      const p = positions.get(node.text)
      const f = forces.get(node.text)
      p.x = Math.min(width - 12, Math.max(12, p.x + f.x * 0.6))
      p.y = Math.min(height - 12, Math.max(12, p.y + f.y * 0.6))
    }
  }
  return positions
}

function GraphCanvas({ graph, entries }) {
  const [positions, setPositions] = useState(null)
  const [selected, setSelected] = useState(null)
  const [dragging, setDragging] = useState(null)
  const svgRef = useRef(null)

  useEffect(() => {
    setPositions(graph.nodes.length > 0 ? layout(graph.nodes, graph.edges, WIDTH, HEIGHT) : null)
    setSelected(null)
    setDragging(null)
  }, [graph])

  const neighbors = useMemo(() => {
    if (selected === null) return new Set()
    const set = new Set([selected])
    for (const edge of graph.edges) {
      if (edge.source === selected) set.add(edge.target)
      if (edge.target === selected) set.add(edge.source)
    }
    return set
  }, [graph, selected])

  const scale = () => {
    const el = svgRef.current
    return el && el.clientWidth > 0 ? el.clientWidth / WIDTH : 1
  }

  const onPointerDown = (event, node) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setSelected(node.text)
    setDragging({ text: node.text, x: event.clientX, y: event.clientY })
  }
  const onPointerMove = (event) => {
    if (dragging === null) return
    const dx = (event.clientX - dragging.x) / scale()
    const dy = (event.clientY - dragging.y) / scale()
    setPositions((previous) => {
      const next = new Map(previous)
      const point = next.get(dragging.text)
      next.set(dragging.text, {
        x: Math.min(WIDTH - 12, Math.max(12, point.x + dx)),
        y: Math.min(HEIGHT - 12, Math.max(12, point.y + dy)),
      })
      return next
    })
    setDragging({ ...dragging, x: event.clientX, y: event.clientY })
  }
  const onPointerUp = () => setDragging(null)

  if (positions === null) return null
  const related = selected === null ? [] : entries.filter((entry) => entry.content.includes(selected)).slice(0, 8)
  const selectedNode = graph.nodes.find((node) => node.text === selected)

  return h('div', { className: 'mem-graph-wrap' },
    h('div', { className: 'mem-legend' },
      Object.entries(KIND_LABEL).map(([kind, label]) => h('span', {
        key: kind, className: `mem-legend-item ${KIND_CLASS[kind] ?? ''}`,
      }, label)),
    ),
    h('svg', {
      ref: svgRef, className: 'mem-graph',
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'xMidYMid meet',
      onPointerMove, onPointerUp, onPointerLeave: onPointerUp,
    },
      graph.edges.map((edge) => {
        const a = positions.get(edge.source)
        const b = positions.get(edge.target)
        if (!a || !b) return null
        const dimmed = selected !== null && !(neighbors.has(edge.source) && neighbors.has(edge.target))
        return h('line', {
          key: `${edge.source}->${edge.target}`,
          x1: a.x, y1: a.y, x2: b.x, y2: b.y,
          className: `mem-edge${dimmed ? ' mem-dim' : ''}`,
          style: { opacity: Math.min(1, edge.weight / 3) },
        }, h('title', null, `${edge.source} ↔ ${edge.target} · 共现于 ${edge.weight} 条记忆`))
      }),
      graph.nodes.map((node) => {
        const p = positions.get(node.text)
        const radius = Math.min(20, 8 + node.count * 1.5)
        const active = node.text === selected
        const dimmed = selected !== null && !neighbors.has(node.text)
        return h('g', {
          key: node.text,
          className: `mem-node${active ? ' mem-node-active' : ''}${dimmed ? ' mem-dim' : ''} ${KIND_CLASS[node.kind] ?? 'mem-kind-label'}`,
          onPointerDown: (event) => onPointerDown(event, node),
        },
          h('title', null, `${node.text}（${KIND_LABEL[node.kind] ?? node.kind}）· 出现在 ${node.count} 条记忆 · 拖动可调整位置`),
          h('circle', { cx: p.x, cy: p.y, r: radius }),
          h('text', {
            x: p.x, y: p.y + radius + 12, textAnchor: 'middle',
            className: 'mem-node-label',
          }, node.text.length > 16 ? `${node.text.slice(0, 15)}…` : node.text),
        )
      }),
    ),
    selected !== null && h('div', { className: 'mem-graph-detail' },
      h('div', { className: 'mem-graph-title' },
        `实体「${selected}」· 出现在 ${selectedNode?.count ?? 0} 条记忆中`),
      related.length === 0
        ? h('div', { className: 'mem-empty' }, '当前列表中没有含此实体的记忆。')
        : related.map((entry) => h(EntryItem, { key: entry.id, entry })),
    ),
  )
}

function RelationsView({ entries }) {
  const [graph, setGraph] = useState(null)
  const [view, setView] = useState('cards')
  const [error, setError] = useState('')

  const load = async () => {
    try {
      setGraph(await (await fetch(`${API}/graph`)).json())
      setError('')
    } catch (cause) {
      setError(`关系接口不可用：${cause?.message ?? cause}`)
    }
  }
  useEffect(() => { void load() }, [])

  if (graph === null && !error) return h('div', { className: 'mem-empty' }, '关系加载中…')
  if (error) return h('div', { className: 'mem-error' }, error)
  if (graph.nodes.length === 0) {
    return h('div', { className: 'mem-empty' }, '还没有足够的实体。多写几条含实体（路径/工具名/项目名）的记忆。')
  }

  const nodes = [...graph.nodes].sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
  const neighborsOf = (text) => graph.edges
    .filter((edge) => edge.source === text || edge.target === text)
    .map((edge) => ({ other: edge.source === text ? edge.target : edge.source, weight: edge.weight }))
    .sort((a, b) => b.weight - a.weight)

  return h('div', { className: 'mem-relations' },
    h('div', { className: 'mem-tabs' },
      h('button', {
        className: `mem-tab${view === 'cards' ? ' mem-tab-active' : ''}`,
        onClick: () => setView('cards'),
      }, '实体卡片'),
      h('button', {
        className: `mem-tab${view === 'graph' ? ' mem-tab-active' : ''}`,
        onClick: () => setView('graph'),
      }, '关系图谱'),
    ),
    view === 'cards' && h('div', { className: 'mem-card-list' },
      nodes.slice(0, 40).map((node) => {
        const neighbors = neighborsOf(node.text)
        const related = entries.filter((entry) => entry.content.includes(node.text)).slice(0, 5)
        return h('div', { key: node.text, className: 'mem-entity-card' },
          h('div', { className: 'mem-entity-head' },
            h('span', { className: `mem-kind ${KIND_CLASS[node.kind] ?? 'mem-kind-label'}` }, KIND_LABEL[node.kind] ?? node.kind),
            h('span', { className: 'mem-entity-name', title: node.text }, node.text),
            h('span', { className: 'mem-entity-count' }, `${node.count} 条记忆`),
          ),
          neighbors.length > 0 && h('div', { className: 'mem-entity-rels' },
            h('span', { className: 'mem-entity-rels-label' }, '关联：'),
            neighbors.slice(0, 8).map(({ other, weight }) => h('span', {
              key: other, className: 'mem-entity-rel', title: `共现于 ${weight} 条记忆`,
            }, `${other} ×${weight}`)),
          ),
          h('div', { className: 'mem-entity-memories' },
            related.length === 0
              ? h('div', { className: 'mem-empty' }, '当前列表中没有含此实体的记忆。')
              : related.map((entry) => h(EntryItem, { key: entry.id, entry })),
          ),
        )
      }),
    ),
    view === 'graph' && h(GraphCanvas, { graph, entries }),
  )
}

function MemoryPanel() {
  const [stats, setStats] = useState(null)
  const [entries, setEntries] = useState([])
  const [archived, setArchived] = useState([])
  const [tab, setTab] = useState('timeline')
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

  const refreshArchive = async () => {
    try {
      setArchived(await (await fetch(`${API}/list?archived=1`)).json())
      setError('')
    } catch (cause) {
      setError(String(cause?.message ?? cause))
    }
  }
  useEffect(() => { if (tab === 'archive') void refreshArchive() }, [tab])

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

  const unarchive = async (id) => {
    await fetch(`${API}/unarchive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    await Promise.all([refresh(), refreshArchive()])
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

  const tabs = [
    { id: 'timeline', label: '时间线' },
    { id: 'relations', label: '关系' },
    { id: 'archive', label: `归档${stats?.archived ? ` (${stats.archived})` : ''}` },
  ]

  return h('div', { className: 'mem-panel' },
    h('div', { className: 'mem-row mem-head' },
      h('div', { className: 'mem-title' }, '记忆面板'),
      h('div', { className: 'mem-actions' },
        h('button', { className: 'mem-btn', onClick: () => { void refresh(); void refreshArchive() } }, '刷新'),
        h('button', { className: 'mem-btn', onClick: () => { void exportAll() } }, '导出 JSON'),
      ),
    ),
    stats !== null && h('div', { className: 'mem-stats' },
      `共 ${stats.total} 条 · `,
      Object.entries(stats.byType ?? {}).map(([key, count]) =>
        `${TYPE_LABEL[key] ?? key} ${count}`).join(' · '),
    ),
    h('div', { className: 'mem-tabs' },
      tabs.map((item) => h('button', {
        key: item.id,
        className: `mem-tab${tab === item.id ? ' mem-tab-active' : ''}`,
        onClick: () => setTab(item.id),
      }, item.label)),
    ),
    tab === 'timeline' && h('div', { className: 'mem-form' },
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
    tab === 'timeline' && h('div', { className: 'mem-list' },
      entries.length === 0
        ? h('div', { className: 'mem-empty' }, '还没有记忆。写一条，或让模型用 memory_remember 工具。')
        : entries.map((entry) => h(EntryItem, {
          key: entry.id, entry,
          action: { title: '删除（软删除）', glyph: '✕', run: () => forget(entry.id) },
        })),
    ),
    tab === 'relations' && h(RelationsView, { entries }),
    tab === 'archive' && h('div', { className: 'mem-list' },
      archived.length === 0
        ? h('div', { className: 'mem-empty' }, '没有归档记忆。遗忘衰减到阈值以下的条目会自动归档（默认每 10 个回合检查一次）。')
        : archived.map((entry) => h(EntryItem, {
          key: entry.id, entry,
          action: { title: '恢复到时间线', glyph: '↩', run: () => unarchive(entry.id) },
        })),
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
