/** dsh-memory MCP core test: JSON-RPC dispatch over a fake fetch. */
import assert from 'node:assert/strict'
import { PROTOCOL_VERSION, TOOLS, handleRequest } from '../lib/mcp.js'

const calls = []
const fakeFetch = async (url, init = {}) => {
  calls.push({ url, init })
  return {
    ok: true,
    status: 200,
    json: async () => (url.endsWith('/remember')
      ? { id: 'mem_x', created: true }
      : url.includes('/recall')
        ? { hits: [{ content: '伙伴叫哲' }], text: '[semantic] 伙伴叫哲' }
        : url.endsWith('/list')
          ? [{ content: 'a' }, { content: 'b' }]
          : { ok: true }),
  }
}
const context = { apiBase: 'http://x/memory/remote', token: 'sekret', fetchImpl: fakeFetch }

const init = await handleRequest({
  jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION },
}, context)
assert.equal(init.result.protocolVersion, PROTOCOL_VERSION)
assert.equal(init.result.capabilities.tools !== undefined, true)
assert.equal(init.result.serverInfo.name, 'dsh-memory-mcp')

const list = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context)
assert.deepEqual(list.result.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name))

const remembered = await handleRequest({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'memory_remember', arguments: { content: '伙伴叫哲', type: 'semantic', importance: 0.8 } },
}, context)
assert.equal(JSON.parse(remembered.result.content[0].text).created, true)
assert.equal(calls.at(-1).init.headers.authorization, 'Bearer sekret', 'token rides every call')

const recalled = await handleRequest({
  jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'memory_recall', arguments: { query: '哲', top_k: 3 } },
}, context)
assert.equal(recalled.result.isError, undefined)
assert.ok(calls.at(-1).url.includes('/recall?query='), 'recall carries query params')

const badArgs = await handleRequest({
  jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'memory_remember', arguments: {} },
}, context)
assert.equal(badArgs.result.isError, true, 'missing content is a tool error')

const unknown = await handleRequest({
  jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' },
}, context)
assert.equal(unknown.error.code, -32602)

const notification = await handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, context)
assert.equal(notification, undefined, 'notifications get no response')

const badMethod = await handleRequest({ jsonrpc: '2.0', id: 7, method: 'wat' }, context)
assert.equal(badMethod.error.code, -32601)

console.log('mcp-test: all assertions passed')
