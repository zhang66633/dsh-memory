#!/usr/bin/env node
/**
 * dsh-memory — MCP stdio server (P3).
 *
 * Exposes the four memory tools to any MCP client (Claude Code, Cursor, …)
 * over stdio JSON-RPC, backed by the dsh-memory remote HTTP API. Zero
 * dependencies: the JSON-RPC core lives in lib/mcp.js.
 *
 * Usage:
 *   node scripts/mcp-server.mjs --api http://127.0.0.1:<dsh-web-port>/memory/remote [--token <token>]
 * Env: MEMORY_API_URL, MEMORY_API_TOKEN (flags win over env).
 *
 * stdout carries ONLY JSON-RPC messages; diagnostics go to stderr.
 *
 * @module dsh-memory/mcp-server
 */
import { handleRequest } from '../lib/mcp.js'

const FLAGS = {
  api: process.env.MEMORY_API_URL ?? '',
  token: process.env.MEMORY_API_TOKEN ?? '',
}
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--api') FLAGS.api = process.argv[++i] ?? ''
  else if (process.argv[i] === '--token') FLAGS.token = process.argv[++i] ?? ''
}

if (!FLAGS.api) {
  console.error('mcp-server: 需要 --api <url>（或环境变量 MEMORY_API_URL）指向 dsh 的 /memory/remote')
  process.exit(1)
}
const apiBase = FLAGS.api.replace(/\/+$/, '')

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line.length === 0) continue
    let request
    try {
      request = JSON.parse(line)
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
      continue
    }
    handleRequest(request, { apiBase, token: FLAGS.token || undefined })
      .then((response) => {
        if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`)
      })
      .catch((error) => {
        process.stderr.write(`mcp-server: ${error?.message ?? error}\n`)
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0', id: request?.id ?? null,
          error: { code: -32603, message: String(error?.message ?? error) },
        })}\n`)
      })
  }
})
process.stdin.on('end', () => { process.exit(0) })
