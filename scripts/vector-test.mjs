/** dsh-memory vector test: tokenization, TF-IDF, cosine ranking. */
import assert from 'node:assert/strict'
import { buildIndex, cosine, queryVector, tokenize } from '../lib/vector.js'

assert.ok(tokenize('伙伴').includes('bi:伙伴'), 'CJK char bigrams')
assert.ok(tokenize('伙伴').includes('cjk:伙伴'), 'short CJK runs keep a full token')
assert.ok(tokenize('D:\\_Projects\\skill_mcp\\dsh-memory').includes('d:\\_projects\\skill_mcp\\dsh-memory'), 'whole path token')
assert.ok(tokenize('https://example.com/x').includes('example.com'), 'URL host token')
assert.ok(tokenize('the memory of things').includes('memory'), 'ascii tokens drop stopwords')
assert.ok(!tokenize('the memory of things').includes('the'), 'stopwords dropped')

const texts = [
  '伙伴叫哲，喜欢喝咖啡',
  '今天在 dsh-memory 修了 BOM 的坑',
  '窗口下写文件要用 UTF-8 编码',
]
const index = buildIndex(texts)
assert.equal(index.vectors.length, 3)

const q = queryVector('哲喜欢咖啡', index)
assert.ok(q !== null)
const qEmpty = queryVector('   ', index)
assert.equal(qEmpty, null, 'blank query has no vector')

const simA = cosine(q, index.vectors[0])
const simB = cosine(q, index.vectors[1])
assert.ok(simA > 0, 'similar text has positive cosine')
assert.ok(simA > simB, 'semantically closer text ranks above unrelated text')
assert.equal(cosine(q, index.vectors[2]), 0, 'unrelated text has zero cosine')

console.log('vector-test: all assertions passed')
