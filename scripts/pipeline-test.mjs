import { renderTranscript, parseCandidates } from '../lib/pipeline.js'

const events = [
  { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '你好，帮我看看这个项目' }] } },
  { type: 'tool/call', seq: 2, data: { name: 'memory_remember', arguments: '{"content":"test"}' } },
  { type: 'tool/result', seq: 3, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: '{"ok":true}' }] }] } } },
  { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '已完成' }] } } },
]
console.log('--- transcript ---')
console.log(renderTranscript(events, 500))
console.log('--- candidates ---')
console.log(JSON.stringify(parseCandidates('```json\n[{"type":"semantic","content":"伙伴叫哲","importance":0.9,"confidence":0.5,"scope":"user"}]\n```'), null, 2))
console.log('--- empty ---')
console.log(JSON.stringify(parseCandidates('no array here')))
console.log('--- truncation keeps newest ---')
const big = Array.from({ length: 100 }, (_, i) => ({
  type: 'user/message', seq: i, data: { content: [{ type: 'text', text: `line ${i}` }] },
}))
const cut = renderTranscript(big, 100)
console.log(cut.split('\n').slice(0, 3).join('\n'))
console.log('...')
console.log(cut.split('\n').at(-1))
