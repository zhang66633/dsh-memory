/**
 * dsh-memory — agent-plane row.
 *
 * Model-facing surface: four raw JSON-schema tools (remember/recall/forget/
 * reflect) over the shared host-plane MemoryService, a dynamic-context recall
 * provider (缝②: the "Current runtime context" snapshot), and a turn/end
 * listener that refreshes the cached recall text for the session's scope
 * (the context provider is synchronous, so recall runs async at turn/end).
 *
 * P0 mounts this row globally; a later phase moves it behind agent presets.
 *
 * @module dsh-memory/agent
 */
import { MEMORY_TYPES } from './hub.js'

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

/**
 * Mount the agent row.
 * @param ctx - cordis context.
 * @param config - plugin config (recall defaults, injection switch).
 */
export function apply(ctx, config = {}) {
  const memory = ctx.memory
  const recallTopK = config.recallTopK ?? 5
  const recallBudget = config.recallBudget ?? 1200

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

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const cwd = session.header?.cwd ?? ''
    void memory.recall({ scopes: scopesFor(cwd), topK: recallTopK, budget: recallBudget })
      .then(({ text }) => { cached = { text } })
      .catch((error) => { ctx.logger?.warn?.('dsh-memory recall failed: %o', error) })
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
