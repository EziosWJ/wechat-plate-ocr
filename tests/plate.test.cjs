require('./load-ts.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizePlate, isValidPlate, extractPlateCandidates, analyzePlateCandidates } = require('../miniprogram/utils/plate.ts')
const part = (text, x, y = 0, width = text.length * 10) => ({
  text, box: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + 20 }, { x, y: y + 20 }],
})

test('normalizes fullwidth letters, case, spaces and plate separators', () => {
  assert.equal(normalizePlate(' 粤ｂ·１２３４５ '), '粤B12345')
})
test('accepts ordinary plates across all province abbreviations and yellow truck examples', () => {
  for (const province of '京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼') {
    assert.equal(isValidPlate(`${province}A12345`), true)
  }
  assert.equal(isValidPlate('鲁N8A321'), true)
})
test('accepts small and large new-energy plates', () => {
  for (const plate of ['粤BD12345', '沪AFZ1234', '粤B12345D', '京A12345F']) assert.ok(isValidPlate(plate), plate)
})
test('rejects invalid lengths, illegal province/agency, I/O and unsupported suffixes', () => {
  for (const plate of ['粤B1234', '粤B123456', '粤BD123456', '粤B12345DD', '粤112345', '粤I12345',
    '粤B12O45', '粤B12I45', '港A12345', '粤B1234学', '粤BD1234A']) assert.equal(isValidPlate(plate), false, plate)
  assert.deepEqual(extractPlateCandidates([{ text: '粤B123456' }]), [])
})
test('extracts multiple distinct plates and deduplicates repeated anchors', () => {
  assert.deepEqual(extractPlateCandidates([{ text: '粤B12345' }, { text: '沪AD12345' }, { text: '粤B12345' }]), ['粤B12345', '沪AD12345'])
})
test('joins only adjacent same-line fragments, regardless of engine ordering', () => {
  assert.deepEqual(extractPlateCandidates([part('12345', 24), part('粤B', 0)]), ['粤B12345'])
  assert.deepEqual(extractPlateCandidates([part('粤', 0), part('B', 12), part('12345', 24)]), ['粤B12345'])
})
test('never offers a seven-character prefix of a split eight-character plate', () => {
  assert.deepEqual(extractPlateCandidates([part('粤BD1234', 0), part('5', 72)]), ['粤BD12345'])
  // A complete anchor is preserved; a separate neighbouring character cannot erase it.
  assert.deepEqual(extractPlateCandidates([part('粤B12345', 0), part('6', 72)]), ['粤B12345'])
})
test('does not join separate rows, distant regions, missing boxes or separate vehicles', () => {
  assert.deepEqual(extractPlateCandidates([part('粤B', 0), part('12345', 24, 40)]), [])
  assert.deepEqual(extractPlateCandidates([part('粤B', 0), part('12345', 200)]), [])
  assert.deepEqual(extractPlateCandidates([{ text: '粤B' }, { text: '12345' }]), [])
  assert.deepEqual(extractPlateCandidates([{ text: '粤B\n12345' }]), [])
  assert.deepEqual(extractPlateCandidates([part('粤B12345', 0), part('沪A54321', 110)]), ['粤B12345', '沪A54321'])
})

test('user sample is preserved next to model names and normalizes OCR separator noise', () => {
  assert.deepEqual(extractPlateCandidates([part('沪B800A5', 0), part('50TFSI', 74)]), ['沪B800A5'])
  assert.deepEqual(extractPlateCandidates([{ text: '沪B:800A5' }]), ['沪B800A5'])
})
test('ambiguous letters stay unchanged and expose a manual-review suggestion and reason', () => {
  const result = analyzePlateCandidates([{ text: '沪B8OOA5' }])
  assert.deepEqual(result.candidates, [])
  assert.equal(result.suggestions[0].text, '沪B8OOA5')
  assert.match(result.suggestions[0].reason, /人工核对/)
  assert.equal(result.decisions[0].accepted, false)
})
test('missing coordinates provide a manual hint without promoting it to an OCR candidate', () => {
  const result = analyzePlateCandidates([{ text: '沪B' }, { text: '800A5' }])
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.suggestions, [{ text: '沪B800A5', reason: '缺少坐标，片段组合仅供人工核对' }])
})
test('malformed native boxes cannot crash candidate analysis', () => {
  assert.deepEqual(extractPlateCandidates([{ text: '沪B800A5', box: {} }]), ['沪B800A5'])
  assert.deepEqual(extractPlateCandidates([{ text: '沪B800A5', box: [null, null, null, null] }]), ['沪B800A5'])
})
