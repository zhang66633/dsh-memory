/**
 * dsh-memory — agent-plane row.
 *
 * Model-facing surface: four raw JSON-schema tools (remember/recall/forget/
 * reflect) over the shared host-plane MemoryService, a dynamic-context recall
 * provider (缝②: the "Current runtime context" snapshot), a turn/end listener
 * that refreshes the cached recall text for the session's scope, and the P1
 * auto-extraction hook: on every Nth completed turn the session log since the
 * persisted watermark is condensed by an auxiliary LLM call into memory
 * candidates (confidence-gated; low confidence lands as `unverified`).
 *
 * P0 mounts this row globally; a later phase moves it behind agent presets.
 *
 * @module dsh-memory/agent
 */
import { MEMORY_TYPES } from './hub.js'
import { buildGraph } from './graph.js'
import { completeText, extractionSystemPrompt, parseCandidates, renderTranscript } from './pipeline.js'

/** Model instruction for the reflect background task. */
const REFLECT_SYSTEM = [
  'You review recent long-term memories of an AI assistant and distill durable insights.',
  'Reply with ONLY a JSON array. Each item:',
  '{"type":"insight","content":"one self-contained insight sentence","importance":0..1,"confidence":0..1,"scope":"user"}',
  '- insights generalize beyond single events: recurring patterns, the user\'s working style, stable project facts.',
  '- merge near-duplicates; prefer few high-value insights over many weak ones.',
  '- content must be self-contained (no "this/that"); confidence: how sure you are the insight is true.',
  'Emit [] when nothing is worth distilling. No markdown, no commentary.',
  'Emit at most 5 items.',
].join('\n')

/** Model instruction for the consolidate background task. */
const CONSOLIDATE_SYSTEM = [
  'You consolidate several episodic memories about the same topic into durable semantic memories.',
  'Reply with ONLY a JSON array of at most 2 items:',
  '{"type":"semantic","content":"one self-contained sentence of the stable, still-true facts","importance":0..1,"confidence":0..1,"scope":"user"}',
  '- drop one-off details and anything already superseded; keep what future sessions need.',
  '- content must be self-contained (no "this/that").',
  'Emit [] if nothing stable remains. No markdown, no commentary.',
].join('\n')

/** Plugin row id. */
export const name = 'dsh-memory/agent'

/** Required services: the shared memory singleton, the prompt registry, tools. */
export const inject = ['memory', 'systemPrompt', 'tools']

/** Tool output contract: permissive schema + JSON text render. */
const OUTPUT = {
  schema: { type: 'object' },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** The model route captured by the most recent `request/header` event, if any. */
function routeFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type !== 'request/header') continue
    const config = event.data?.header?.config
    if (config?.provider && config?.model) return { provider: config.provider, model: config.model }
  }
  return null
}

/**
 * Mount the agent row.
 * @param ctx - cordis context.
 * @param config - plugin config (recall defaults, extraction policy, optional route override).
 */
export function apply(ctx, config = {}) {
  const memory = ctx.memory
  const recallTopK = config.recallTopK ?? 5
  const recallBudget = config.recallBudget ?? 1200

  const extraction = {
    enabled: config.extraction?.enabled !== false,
    everyNTurns: config.extraction?.everyNTurns ?? 1,
    maxInputChars: config.extraction?.maxInputChars ?? 6000,
    minTranscriptChars: config.extraction?.minTranscriptChars ?? 40,
    minConfidence: config.extraction?.minConfidence ?? 0.3,
    verifyConfidence: config.extraction?.verifyConfidence ?? 0.6,
    maxCandidates: config.extraction?.maxCandidates ?? 8,
    timeoutMs: config.extraction?.timeoutMs ?? 60000,
    maxTokens: config.extraction?.maxTokens ?? 1024,
  }
  const routeOverride = config.provider && config.model
    ? { provider: config.provider, model: config.model }
    : null

  const background = {
    archiveEveryNTurns: config.archiveEveryNTurns ?? 10,
    reflectEveryNTurns: config.reflectEveryNTurns ?? 10,       // 0 disables
    consolidateEveryNTurns: config.consolidateEveryNTurns ?? 20, // 0 disables
    reflectMaxMemories: config.reflectMaxMemories ?? 30,
    reflectMaxTokens: config.reflectMaxTokens ?? 1024,
    consolidateMaxTokens: config.consolidateMaxTokens ?? 1024,
    timeoutMs: config.extraction?.timeoutMs ?? 60000,
  }

  const scopesFor = (cwd) => ['user', ...(cwd ? [`workspace:${cwd}`] : [])]

  // ── 缝② dynamic context: cached recall text, refreshed at turn/end ──
  let cached = { text: '' }
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'memory:recall',
    order: 200,
    text: () => cached.text.length > 0
      ? `Long-term memory (auto-injected; call memory_recall for more):\n${cached.text}`
      : '',
  }), 'dsh-memory: recall context')

  // ── background tasks: one in-flight queue, all LLM work serialized ──
  const llm = ctx.get('llm')
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger?.warn?.(message)
  }
  const resolveRoute = (session) => {
    if (!llm) {
      warnOnce('no-llm', 'dsh-memory: extraction enabled but the harness llm service is unavailable; set extraction.enabled: false or mount an llm route')
      return null
    }
    const route = routeOverride ?? routeFromEvents(session.events)
    if (!route) {
      warnOnce('no-route', 'dsh-memory: no provider/model route for background tasks; configure provider and model on the memory-agent row')
      return null
    }
    return route
  }
  let queue = Promise.resolve()
  const enqueue = (label, task) => {
    queue = queue.then(task)
      .catch((error) => { ctx.logger?.warn?.(`dsh-memory ${label} failed: %o`, error) })
  }
  const completedTurns = new Map()
  let completedTurnsGlobal = 0

  const countTurn = (sessionId) => {
    const next = (completedTurns.get(sessionId) ?? 0) + 1
    completedTurns.delete(sessionId)
    completedTurns.set(sessionId, next)
    if (completedTurns.size > 256) completedTurns.delete(completedTurns.keys().next().value)
    return next
  }

  const extractTurn = async (session, event) => {
    const route = resolveRoute(session)
    if (route === null) return
    const sessionId = String(session.id)
    const watermark = await memory.extractionWatermark(sessionId)
    const span = session.events.filter((e) => e.seq > watermark && e.seq <= event.seq)
    const transcript = renderTranscript(span, extraction.maxInputChars)
    if (transcript.trim().length === 0) {
      await memory.setExtractionWatermark(sessionId, event.seq)
      return
    }
    if (transcript.replace(/\s/g, '').length < extraction.minTranscriptChars) {
      // A trivial turn (one-word reply and back) is not worth an LLM call;
      // skipping it still advances the watermark so it is never re-mined.
      await memory.setExtractionWatermark(sessionId, event.seq)
      return
    }
    const text = await completeText(llm, {
      ...route,
      system: extractionSystemPrompt(extraction.maxCandidates),
      userText: transcript,
      maxTokens: extraction.maxTokens,
      temperature: 0.2,
      timeoutMs: extraction.timeoutMs,
    })
    const candidates = parseCandidates(text).slice(0, extraction.maxCandidates)
    const cwd = session.header?.cwd ?? ''
    for (const candidate of candidates) {
      if (candidate.confidence < extraction.minConfidence) continue
      const scope = candidate.scope === 'workspace' && cwd ? `workspace:${cwd}` : 'user'
      const unverified = candidate.confidence < extraction.verifyConfidence
      await memory.remember(
        { ...candidate, scope, unverified },
        { agent: 'extraction', session: sessionId, turn: event.data?.turn, at: Date.now() },
      )
    }
    await memory.setExtractionWatermark(sessionId, event.seq)
  }

  /** P2 reflect: distill insights from the recent memories (no side effects on them). */
  const reflectTurn = async (session) => {
    const route = resolveRoute(session)
    if (route === null) return
    const memories = await memory.recentForReflect(background.reflectMaxMemories)
    if (memories.length < 3) return
    const framed = JSON.stringify(memories.map((m) => ({
      type: m.type, scope: m.scope, content: m.content,
    })))
    const text = await completeText(llm, {
      ...route,
      system: REFLECT_SYSTEM,
      userText: framed,
      maxTokens: background.reflectMaxTokens,
      temperature: 0.3,
      timeoutMs: background.timeoutMs,
    })
    for (const candidate of parseCandidates(text)) {
      if (candidate.confidence < extraction.minConfidence) continue
      await memory.remember(
        { ...candidate, type: 'insight', scope: 'user', unverified: candidate.confidence < extraction.verifyConfidence },
        { agent: 'reflection', at: Date.now() },
      )
    }
  }

  /** P2 consolidate: fold one entity cluster of episodic memories into a semantic one. */
  const consolidateTurn = async (session) => {
    const route = resolveRoute(session)
    if (route === null) return
    const episodics = (await memory.list({ type: 'episodic' })).filter((r) => !r.tombstone && !r.archived)
    if (episodics.length < 2) return
    const graph = buildGraph(episodics)
    let best = null
    for (const [entity, node] of graph.nodes) {
      if (best === null || node.count > best.node.count) best = { entity, node }
    }
    if (best === null || best.node.count < 2) return
    const group = episodics
      .filter((entry) => (graph.entryEntities.get(entry.id) ?? []).includes(best.entity))
      .slice(0, 6)
    if (group.length < 2) return
    const framed = JSON.stringify(group.map((m) => ({ scope: m.scope, content: m.content })))
    const text = await completeText(llm, {
      ...route,
      system: CONSOLIDATE_SYSTEM,
      userText: framed,
      maxTokens: background.consolidateMaxTokens,
      temperature: 0.3,
      timeoutMs: background.timeoutMs,
    })
    const candidates = parseCandidates(text).slice(0, 2)
    const scopeCounts = new Map()
    for (const item of group) scopeCounts.set(item.scope, (scopeCounts.get(item.scope) ?? 0) + 1)
    const scope = [...scopeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    let consolidated = 0
    for (const candidate of candidates) {
      if (candidate.confidence < extraction.minConfidence) continue
      const result = await memory.remember(
        { ...candidate, type: 'semantic', scope, unverified: candidate.confidence < extraction.verifyConfidence },
        { agent: 'consolidation', entity: best.entity, from: group.map((m) => m.id), at: Date.now() },
      )
      if (result.created) consolidated += 1
    }
    if (consolidated > 0) {
      for (const original of group) await memory.forget(original.id)
      ctx.logger?.info?.(`dsh-memory consolidation: folded ${group.length} episodic memories on "${best.entity}" into ${consolidated}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const cwd = session.header?.cwd ?? ''
    void memory.recall({ scopes: scopesFor(cwd), topK: recallTopK, budget: recallBudget })
      .then(({ text }) => { cached = { text } })
      .catch((error) => { ctx.logger?.warn?.('dsh-memory recall failed: %o', error) })
    if (event.data?.reason?.kind !== 'completed') return
    const sessionId = String(session.id)
    if (extraction.enabled && countTurn(sessionId) >= extraction.everyNTurns) {
      completedTurns.set(sessionId, 0)
      enqueue('extraction', () => extractTurn(session, event))
    }
    // Corpus-wide maintenance cadence: one global counter, cheap local steps first.
    completedTurnsGlobal += 1
    if (background.archiveEveryNTurns > 0 && completedTurnsGlobal % background.archiveEveryNTurns === 0) {
      void memory.archiveBelow()
        .catch((error) => { ctx.logger?.warn?.('dsh-memory archive failed: %o', error) })
    }
    if (background.reflectEveryNTurns > 0 && completedTurnsGlobal % background.reflectEveryNTurns === 0) {
      enqueue('reflection', () => reflectTurn(session))
    }
    if (background.consolidateEveryNTurns > 0 && completedTurnsGlobal % background.consolidateEveryNTurns === 0) {
      enqueue('consolidation', () => consolidateTurn(session))
    }
  })

  // ── model tools (raw JSON-schema registration: no harness imports) ──
  const registerTool = (definition) => {
    ctx.effect(() => {
      let dispose
      try {
        dispose = ctx.tools.register(definition)
      } catch (error) {
        console.error(`[dsh-memory] tool ${definition.name} registration skipped: ${error}`)
      }
      return () => { dispose?.() }
    }, `dsh-memory: tool ${definition.name}`)
  }

  registerTool({
    name: 'memory_remember',
    description:
      'Write one long-term memory shared across sessions. Types: semantic (fact), episodic (event), procedural (how-to lesson), preference (user preference), insight (reflection). Scope: "user" (global) or "workspace:<path>". Duplicate content merges instead of duplicating.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory itself, one concise sentence.' },
        type: { type: 'string', enum: MEMORY_TYPES, description: 'Memory type; default semantic.' },
        importance: { type: 'number', description: '0..1; default 0.5.' },
        scope: { type: 'string', description: '"user" or "workspace:<path>"; default user.' },
      },
      required: ['content'],
    },
    output: OUTPUT,
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return memory.remember(args, { agent: 'tool', at: Date.now() })
    },
    presentCall: (args) => ({ card: 'generic', title: 'memory_remember', kind: 'write', rawInput: args }),
  })

  registerTool({
    name: 'memory_recall',
    description:
      'Recall long-term memories shared across sessions. Scores combine importance, confidence, and recency decay; a query adds a keyword boost. Returns the top hits plus rendered text.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword/theme to boost.' },
        scope: { type: 'string', description: 'Optional single scope filter ("user" or "workspace:<path>").' },
        top_k: { type: 'number', description: 'Max hits; default 5.' },
      },
    },
    output: OUTPUT,
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const { hits, text } = await memory.recall({
        query: args.query,
        scopes: args.scope ? [args.scope] : undefined,
        topK: args.top_k ?? recallTopK,
        budget: recallBudget,
      })
      return { hits, text }
    },
    presentCall: (args) => ({ card: 'generic', title: 'memory_recall', kind: 'read', rawInput: args }),
  })

  registerTool({
    name: 'memory_forget',
    description: 'Soft-delete a memory by id (recoverable; the memory panel can restore).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id from a recall/list result.' } },
      required: ['id'],
    },
    output: OUTPUT,
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return memory.forget(String(args.id ?? ''))
    },
    presentCall: (args) => ({ card: 'generic', title: 'memory_forget', kind: 'write', rawInput: args }),
  })

  registerTool({
    name: 'memory_reflect',
    description:
      'Reflection helper: lists recent memories (all scopes) for review. The model should distill durable insights and write them back with memory_remember(type insight).',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max entries; default 20.' } },
    },
    output: OUTPUT,
    timeoutMs: 15000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const entries = (await memory.list({})).slice(0, args.limit ?? 20)
      return { count: entries.length, entries }
    },
    presentCall: (args) => ({ card: 'generic', title: 'memory_reflect', kind: 'read', rawInput: args }),
  })
}
