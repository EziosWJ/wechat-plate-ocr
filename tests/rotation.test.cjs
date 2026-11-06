require('./load-ts.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { rotatedSize, rotationMatrix } = require('../miniprogram/utils/image-rotation.ts')
test('all quarter-turns map every source corner inside the output image without clipping', () => {
  const size = { width: 538, height: 278 }
  for (const rotation of [0, 90, 180, 270]) {
    const output = rotatedSize(size, rotation)
    const [a, b, c, d, e, f] = rotationMatrix(size, rotation)
    const corners = [[0, 0], [538, 0], [0, 278], [538, 278]].map(([x, y]) => [a*x+c*y+e, b*x+d*y+f])
    assert.equal(Math.min(...corners.map(p => p[0])), 0)
    assert.equal(Math.min(...corners.map(p => p[1])), 0)
    assert.equal(Math.max(...corners.map(p => p[0])), output.width)
    assert.equal(Math.max(...corners.map(p => p[1])), output.height)
  }
})
