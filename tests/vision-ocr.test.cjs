require('./load-ts.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
test.beforeEach(t => { t.mock.method(console, 'info', () => {}) })
const { VisionOcrService } = require('../miniprogram/services/vision-ocr.ts')
const flush = () => new Promise(resolve => setImmediate(resolve))
const input = { imagePath: 'temp.jpg', preview: { width: 375, height: 500 },
  frame: { x: 30, y: 220, width: 315, height: 65 }, onPreview() {} }
function install(options = {}) {
  const sessions = [], images = [], canvases = []
  global.wx = {
    canIUse: () => options.supported !== false,
    createOffscreenCanvas: () => {
      const canvas = { width: 1, height: 1,
        createImage() {
          const image = { width: 3000, height: 4000,
            set src(path) { if (path) queueMicrotask(() => image.onload()) },
          }
          images.push(image)
          return image
        },
        getContext: () => ({ scale() {}, translate() {}, transform() {}, drawImage() {}, getImageData: () => ({
          data: new Uint8ClampedArray(4), width: canvas.width, height: canvas.height,
        }) }),
      }
      canvases.push(canvas)
      return canvas
    },
    createVKSession(config) {
      assert.deepEqual(config.track, { OCR: { mode: 2 } })
      const listeners = {}, s = {
        stopped: false, destroyed: false, submissions: [],
        on: (event, fn) => { listeners[event] = fn },
        off: (event, fn) => { if (listeners[event] === fn) delete listeners[event] },
        start: cb => { if (!options.hang) queueMicrotask(() => cb(options.startError)) },
        stop() { this.stopped = true }, destroy() { this.destroyed = true },
        runOCR(pixels) { this.submissions.push(pixels) },
        emit: anchors => { if (listeners.updateAnchors) listeners.updateAnchors(anchors) },
        late: () => listeners.updateAnchors,
        listeners,
      }
      sessions.push(s)
      return s
    },
  }
  return { sessions, images, canvases }
}
const anchor = (text, id = 1) => ({ id, text, type: 6 })

test('collects OCR updates and releases native resources on success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = install(), service = new VisionOcrService()
  const promise = service.recognize(input)
  await flush()
  assert.equal(mock.sessions[0].submissions.length, 1)
  mock.sessions[0].emit([anchor('粤B12345')])
  t.mock.timers.tick(1200)
  assert.deepEqual((await promise).candidates, ['粤B12345'])
  assert.ok(mock.sessions[0].stopped && mock.sessions[0].destroyed)
  assert.deepEqual(mock.sessions[0].listeners, {})
  assert.equal(mock.canvases[0].width, 1)
})
test('retries with a new session only when no valid plate was returned', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = install(), service = new VisionOcrService(), crops = []
  const promise = service.recognize({ ...input, onPreview: value => crops.push(value.crop) })
  await flush()
  mock.sessions[0].emit([anchor('车辆')]); t.mock.timers.tick(8000)
  await flush()
  assert.equal(mock.sessions.length, 2)
  assert.ok(mock.sessions[0].destroyed)
  assert.ok(crops[1].height > crops[0].height)
  mock.sessions[1].emit([anchor('沪AD12345')]); t.mock.timers.tick(1200)
  const result = await promise
  assert.deepEqual(result.candidates, ['沪AD12345'])
  assert.deepEqual(result.rawTexts, ['车辆', '沪AD12345'])
  assert.equal(result.retried, true)
})
test('startup times out after eight seconds and destroys the session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = install({ hang: true }), service = new VisionOcrService()
  const rejected = assert.rejects(service.recognize(input), { code: 'timeout' })
  await flush(); t.mock.timers.tick(8000); await rejected
  assert.ok(mock.sessions[0].destroyed)
})
test('cancel ignores a late captured callback and allows a clean next request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = install(), service = new VisionOcrService()
  const cancelled = assert.rejects(service.recognize(input), { code: 'cancelled' })
  await flush()
  const late = mock.sessions[0].late()
  service.cancel(); await cancelled
  const next = service.recognize(input)
  await flush()
  late([anchor('京A12345')])
  mock.sessions[1].emit([anchor('鲁N12345')]); t.mock.timers.tick(1200)
  assert.deepEqual((await next).candidates, ['鲁N12345'])
})
test('unsupported client and native startup failure retain explicit error codes', async () => {
  install({ supported: false })
  await assert.rejects(new VisionOcrService().recognize(input), { code: 'unsupported' })
  const mock = install({ startError: { errMsg: 'native failure' } })
  await assert.rejects(new VisionOcrService().recognize(input), { code: 'failed' })
  assert.ok(mock.sessions[0].destroyed)
})

test('empty and partial early callbacks do not terminate collection after 350ms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const mock = install(), service = new VisionOcrService(), events = []
  const promise = service.recognize({ ...input, onDebug: event => events.push(event) })
  await flush()
  mock.sessions[0].emit([]); t.mock.timers.tick(500)
  assert.equal(mock.sessions[0].destroyed, false)
  mock.sessions[0].emit([anchor('沪B')]); t.mock.timers.tick(500)
  assert.equal(mock.sessions[0].destroyed, false)
  mock.sessions[0].emit([anchor('沪B800A5')]); t.mock.timers.tick(800)
  assert.deepEqual((await promise).candidates, ['沪B800A5'])
  assert.ok(events.some(event => event.kind === 'anchors' && event.details.includes('沪B800A5')))
  assert.ok(events.some(event => event.kind === 'analysis' && event.details.includes('号码格式有效')))
})
test('last attempt uses the entire decoded image and exposes exact input pixels', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = install(), service = new VisionOcrService(), frames = [], crops = []
  const promise = service.recognize({ ...input, onPixels: frame => frames.push(frame), onPreview: value => crops.push(value) })
  await flush()
  t.mock.timers.tick(8000); await flush()
  t.mock.timers.tick(8000); await flush()
  assert.equal(mock.sessions.length, 3)
  assert.deepEqual(crops[2].crop, { x: 0, y: 0, width: 3000, height: 4000 })
  assert.equal(frames[2].width, 1200)
  assert.equal(frames[2].height, 1600)
  assert.notEqual(frames[2].data.buffer, mock.sessions[2].submissions[0].frameBuffer)
  mock.sessions[2].emit([anchor('沪B800A5')]); t.mock.timers.tick(1200)
  assert.deepEqual((await promise).candidates, ['沪B800A5'])
})
test('raw OCR is logged to console even when no debug callback is provided', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = install(), promise = new VisionOcrService().recognize(input)
  await flush()
  mock.sessions[0].emit([anchor('沪B800A5')]); t.mock.timers.tick(1200)
  await promise
  assert.ok(console.info.mock.calls.some(call => JSON.stringify(call.arguments).includes('沪B800A5')))
})
test('manual quarter-turn reuses the photo but bypasses stale preview coordinates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = install(), crops = []
  const promise = new VisionOcrService().recognize({ ...input, rotation: 90, onPreview: value => crops.push(value) })
  await flush()
  assert.deepEqual(crops[0].crop, { x: 0, y: 0, width: 4000, height: 3000 })
  mock.sessions[0].emit([anchor('沪B800A5')]); t.mock.timers.tick(1200)
  assert.deepEqual((await promise).candidates, ['沪B800A5'])
  assert.equal(mock.sessions.length, 1)
})
