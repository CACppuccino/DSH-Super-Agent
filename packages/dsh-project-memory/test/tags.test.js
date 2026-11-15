import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TAGS, TAG_VOCABULARY, isKnownTag, normalizeTags } from '../lib/tags.js'

test('tag vocabulary is exactly the required closed set', () => {
  assert.deepEqual([...TAG_VOCABULARY], ['经验', '教训', '研究', '工程', '简单执行', '讨论'])
})

test('normalizeTags accepts the required vocabulary and deduplicates', () => {
  assert.deepEqual(normalizeTags(['工程', '经验', '工程']), ['工程', '经验'])
  assert.deepEqual(normalizeTags([' 经验 ', '简单执行']), ['经验', '简单执行'])
})

test('normalizeTags maps English aliases', () => {
  assert.deepEqual(normalizeTags(['experience', 'lesson', 'research']), ['经验', '教训', '研究'])
  assert.deepEqual(normalizeTags(['engineering', 'simple-execution', 'discussion']), ['工程', '简单执行', '讨论'])
})

test('normalizeTags rejects unknown tags instead of silently dropping them', () => {
  assert.throws(() => normalizeTags(['工程', 'typo']), (error) => {
    assert.equal(error.code, 'tag/unknown')
    assert.match(error.message, /typo/)
    assert.match(error.message, /经验/)
    return true
  })
})

test('normalizeTags enforces shape and count limits', () => {
  assert.throws(() => normalizeTags(undefined), /tags is required/)
  assert.throws(() => normalizeTags('经验'), /must be an array/)
  assert.throws(() => normalizeTags([]), /at least one tag/)
  assert.throws(() => normalizeTags([1]), /must contain strings/)
  assert.equal(MAX_TAGS, 6)
  assert.equal(normalizeTags(['经验', '教训', '研究', '工程', '简单执行', '讨论']).length, MAX_TAGS)
})

test('isKnownTag mirrors normalization', () => {
  assert.equal(isKnownTag('工程'), true)
  assert.equal(isKnownTag('engineering'), true)
  assert.equal(isKnownTag('nope'), false)
})
