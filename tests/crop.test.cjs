require('./load-ts.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mapPreviewCrop } = require('../miniprogram/utils/crop.ts')
test('maps an uncropped preview to original-resolution pixels', () => {
  assert.deepEqual(mapPreviewCrop({ width: 1000, height: 2000 }, { width: 500, height: 1000 },
    { x: 50, y: 400, width: 400, height: 100 }, 0), { x: 100, y: 800, width: 800, height: 200 })
})
test('accounts for horizontal and vertical center-cover clipping', () => {
  assert.deepEqual(mapPreviewCrop({ width: 4000, height: 3000 }, { width: 300, height: 600 },
    { x: 30, y: 250, width: 240, height: 60 }, 0), { x: 1400, y: 1250, width: 1200, height: 300 })
  assert.deepEqual(mapPreviewCrop({ width: 3000, height: 4000 }, { width: 600, height: 300 },
    { x: 50, y: 100, width: 500, height: 100 }, 0), { x: 250, y: 1750, width: 2500, height: 500 })
})
test('expanded retry contains first crop and clamps to image bounds', () => {
  const photo = { width: 3000, height: 4000 }, preview = { width: 375, height: 500 }
  const frame = { x: 20, y: 200, width: 335, height: 60 }
  const a = mapPreviewCrop(photo, preview, frame, .12), b = mapPreviewCrop(photo, preview, frame, .55)
  assert.ok(b.x <= a.x && b.y <= a.y && b.width >= a.width && b.height >= a.height)
  assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= photo.width && b.y + b.height <= photo.height)
})
test('rejects invalid geometry', () => {
  assert.throws(() => mapPreviewCrop({ width: 0, height: 1 }, { width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }, 0))
})
test('keeps a narrower region while allowing more vertical movement outside the guide', () => {
  assert.deepEqual(mapPreviewCrop({ width: 1000, height: 2000 }, { width: 500, height: 1000 },
    { x: 100, y: 400, width: 300, height: 100 }, { horizontal: .10, vertical: .30 }),
    { x: 140, y: 740, width: 720, height: 320 })
})
