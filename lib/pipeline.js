/**
 * dsh-memory — extraction pipeline (P1).
 *
 * Turn transcript → one-shot auxiliary LLM call → structured memory
 * candidates. Pure functions plus one `completeText` helper; the agent row
 * owns the lifecycle (watermark, thresholds, storage writes). No harness
 * imports: messages and options are built as plain runtime objects matching
 * the harness wire vocabulary.
 *
 * @module dsh-memory/pipeline
 */
import { MEMORY_TYPES } from './hub.js'

/** Model instruction for the extraction call. */
export const EXTRACTION_SYSTEM_PROMPT = [
  'You extract durable long-term memories from one AI-assistant conversation turn.',
  'Reply with ONLY a JSON array. Each item:',
  '{"type":"semantic|episodic|procedural|preference|insight","content":"one concise sentence in the conversation language","importance":0..1,"confidence":0..1,"scope":"user"|"workspace"}',
  '- semantic: a durable fact about the user or the project.',
  '- episodic: what happened in this turn.',
  '- procedural: a reusable how-to lesson (pitfall, recipe, workaround).',
  '- preference: a user preference (style, tooling, communication).',
  '- insight: a reflection that generalizes beyond this turn.',
  '- content must be self-contained: no pronouns without referents, no "this/that".',
  '- importance: how valuable this memory will be for future sessions (0..1).',
  '- confidence: how certain you are the content is true and durable (0..1).',
  '- scope: "user" for facts about the user themselves (name, preferences, habits); "workspace" for project-specific facts.',
  'Emit [] when nothing is worth remembering. No markdown, no commentary.',
].join('\n')

/** Tool-result content budget per line of the transcript. */
const TOOL_ARGS_BUDGET = 200
const TOOL_RESULT_BUDGET = 300

/** Extract the plain-text surface of one content block, or undefined. */
function blockText(block) {
  if (block?.type === 'text') return String(block.text ?? '')
  if (block?.type === 'tool-result') {
    const parts = (block.content ?? [])
      .map((inner) => inner?.type === 'text' ? String(inner.text ?? '') : '')
      .filter((part) => part.length > 0)
    if (parts.length === 0) return undefined
    const prefix = block.isError === true ? '错误: ' : ''
    return prefix + parts.join('\n')
  }
  return undefined
}

/**
 * Render one event span as a bounded, newest-first transcript.
 * @param events - session events (seq ascending) since the last extraction.
 * @param maxChars - hard character budget for the rendered text.
 * @returns transcript text; older lines are dropped first, never the newest.
 */
export function renderTranscript(events, maxChars) {
  const lines = []
  for (const event of events) {
    if (event.type === 'user/message') {
      for (const block of event.data?.content ?? []) {
        const text = blockText(block)
        if (text !== undefined && text.length > 0) lines.push(`用户: ${text}`)
      }
    } else if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        const text = blockText(block)
        if (text !== undefined && text.length > 0) lines.push(`助手: ${text}`)
      }
    } else if (event.type === 'tool/call') {
      const args = String(event.data?.arguments ?? '').slice(0, TOOL_ARGS_BUDGET)
      lines.push(`工具调用: ${event.data?.name ?? ''}(${args}${args.length >= TOOL_ARGS_BUDGET ? '…' : ''})`)
    } else if (event.type === 'tool/result') {
      const text = blockText(event.data?.message?.content?.[0])
      if (text !== undefined) {
        const trimmed = text.slice(0, TOOL_RESULT_BUDGET)
        lines.push(`工具结果: ${trimmed}${trimmed.length >= TOOL_RESULT_BUDGET ? '…' : ''}`)
      }
    }
  }
  // Keep the newest lines within budget; the extraction prompt describes one
  // turn, so its tail (the final assistant reply) matters most.
  let text = ''
  let dropped = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (text.length + line.length + 1 > maxChars) {
      dropped = true
      break
    }
    text = text.length === 0 ? line : `${line}\n${text}`
  }
  return dropped ? `…（更早的内容已截断）\n${text}` : text
}

/**
 * Parse the model reply into validated memory candidates.
 * Tolerates code fences and surrounding prose; requires one JSON array.
 * @param text - raw model output.
 * @returns candidate array, empty on any parse failure.
 */
export function parseCandidates(text) {
  let json = String(text ?? '')
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) json = fence[1]
  const start = json.indexOf('[')
  const end = json.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed
  try {
    parsed = JSON.parse(json.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const candidates = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const content = String(item.content ?? '').trim()
    if (content.length === 0 || content.length > 2000) continue
    const type = MEMORY_TYPES.includes(item.type) ? item.type : 'semantic'
    const number = (value) => {
      const n = Number(value)
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5
    }
    candidates.push({
      type,
      content,
      importance: number(item.importance ?? 0.5),
      confidence: number(item.confidence ?? 1),
      scope: item.scope === 'workspace' ? 'workspace' : 'user',
    })
  }
  return candidates
}

/**
 * One-shot text completion over the harness `llm` service.
 * @param llm - the harness LLM runtime (`ctx.get('llm')`).
 * @param options - provider/model route and request controls.
 * @returns the assembled text of the reply.
 */
export async function completeText(llm, options) {
  const {
    provider, model, system, userText,
    maxTokens = 1024, temperature = 0.2, timeoutMs = 60000,
  } = options
  const messages = [{
    id: `mem_extract_${Date.now().toString(36)}`,
    role: 'user',
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: 'dsh-memory' },
  }]
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  let text = ''
  let finish
  for await (const chunk of llm.stream({
    provider, model, messages, system, maxTokens, temperature, signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish?.kind === 'error' || finish?.kind === 'aborted') {
    const error = new Error(finish.failure?.message ?? `extraction LLM call ${finish.kind}`)
    error.code = finish.failure?.code
    throw error
  }
  if (finish?.kind === 'tool-calls') throw new Error('extraction model unexpectedly requested tools')
  return text
}
