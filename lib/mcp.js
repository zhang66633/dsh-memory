/**
 * dsh-memory — zero-dependency MCP stdio server core (P3).
 *
 * Pure JSON-RPC dispatch over the remote HTTP API: external agents (Claude
 * Code, any MCP client) mount this server and get the four memory tools
 * backed by the running dsh-memory plugin — locally or across machines.
 * The stdio shell lives in scripts/mcp-server.mjs; this module stays
 * transport-free so tests can drive the dispatcher with a fake fetch.
 *
 * @module dsh-memory/mcp
 */
import { MEMORY_TYPES } from './external.js'

export const PROTOCOL_VERSION = '2024-11-05'
export const SERVER_INFO = { name: 'dsh-memory-mcp', version: '0.4.0' }

/** Tool definitions in the MCP list shape. */
export const TOOLS = [
  {
    name: 'memory_remember',
    description: 'Write one long-term memory shared across dsh sessions. Types: semantic (fact), episodic (event), procedural (how-to lesson), preference (user preference), insight (reflection). Scope: "user" (global) or "workspace:<path>". Duplicate content merges instead of duplicating.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory itself, one concise sentence.' },
        type: { type: 'string', enum: MEMORY_TYPES, description: 'Memory type; default semantic.' },
        importance: { type: 'number', description: '0..1; default 0.5.' },
        scope: { type: 'string', description: '"user" or "workspace:<path>"; default user.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Recall long-term memories shared across sessions. Scores combine importance, confidence, recency decay, semantic similarity, and entity-graph weight; a query adds keyword and semantic boosts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword/theme to boost.' },
        scope: { type: 'string', description: 'Optional single scope filter ("user" or "workspace:<path>").' },
        top_k: { type: 'number', description: 'Max hits; default 5.' },
      },
    },
  },
  {
    name: 'memory_forget',
    description: 'Soft-delete a memory by id (recoverable).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id from a recall result.' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_reflect',
    description: 'Reflection helper: lists recent memories for review. Distill durable insights and write them back with memory_remember (type insight).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max entries; default 20.' } },
    },
  },
]

/** Call one remote API endpoint; non-2xx turns into a thrown error. */
async function call(apiBase, token, fetchImpl, path, init = {}) {
  const headers = { 'content-type': 'application/json', ...init.headers }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetchImpl(`${apiBase}${path}`, { ...init, headers })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
  return body
}

/** Execute one memory tool against the remote API. */
async function callTool(apiBase, token, fetchImpl, name, args) {
  switch (name) {
    case 'memory_remember': {
      if (!args?.content || !String(args.content).trim()) throw new Error('content is required')
      return call(apiBase, token, fetchImpl, '/remember', {
        method: 'POST',
        body: JSON.stringify({
          content: String(args.content),
          type: MEMORY_TYPES.includes(args.type) ? args.type : 'semantic',
          scope: args.scope ?? 'user',
          importance: args.importance ?? 0.5,
          confidence: args.confidence ?? 1,
        }),
      })
    }
    case 'memory_recall': {
      const params = new URLSearchParams()
      if (args?.query) params.set('query', String(args.query))
      if (args?.scope) params.set('scope', String(args.scope))
      if (args?.top_k !== undefined) params.set('top_k', String(args.top_k))
      const suffix = params.size > 0 ? `?${params}` : ''
      const result = await call(apiBase, token, fetchImpl, `/recall${suffix}`)
      return { hits: result.hits, text: result.text }
    }
    case 'memory_forget': {
      if (!args?.id) throw new Error('id is required')
      return call(apiBase, token, fetchImpl, '/forget', { method: 'POST', body: JSON.stringify({ id: String(args.id) }) })
    }
    case 'memory_reflect': {
      const limit = Math.min(100, Math.max(1, Number(args?.limit) || 20))
      const entries = await call(apiBase, token, fetchImpl, '/list')
      return { count: Math.min(limit, entries.length), entries: entries.slice(0, limit) }
    }
    default:
      throw new Error(`unknown tool "${name}"`)
  }
}

const error = (id, code, message) => ({
  jsonrpc: '2.0', id, error: { code, message },
})

/**
 * Dispatch one JSON-RPC request. Pure: transport and fetch are injectable.
 * @param request - the parsed JSON-RPC message.
 * @param context - `{apiBase, token, fetchImpl}` (fetch defaults to global).
 * @returns the JSON-RPC response; `undefined` for notifications.
 */
export async function handleRequest(request, context) {
  const fetchImpl = context.fetchImpl ?? globalThis.fetch
  const { apiBase, token } = context
  const respond = (id, result) => ({ jsonrpc: '2.0', id, result })
  if (request === null || typeof request !== 'object' || request.jsonrpc !== '2.0') {
    return error(null, -32600, 'Invalid Request')
  }
  const { id, method } = request
  if (method === undefined) return error(id, -32600, 'Method required')
  if (id === undefined) return undefined // notification: no response
  switch (method) {
    case 'initialize': {
      return respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    }
    case 'tools/list':
      return respond(id, { tools: TOOLS })
    case 'ping':
      return respond(id, {})
    case 'tools/call': {
      const name = request.params?.name
      const tool = TOOLS.find((entry) => entry.name === name)
      if (tool === undefined) return error(id, -32602, `unknown tool "${name}"`)
      try {
        const result = await callTool(apiBase, token, fetchImpl, name, request.params?.arguments ?? {})
        return respond(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        })
      } catch (cause) {
        return respond(id, {
          content: [{ type: 'text', text: String(cause?.message ?? cause) }],
          isError: true,
        })
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`)
  }
}
