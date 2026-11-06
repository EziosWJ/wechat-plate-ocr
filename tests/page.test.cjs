require('./load-ts.cjs')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const flush = () => new Promise(resolve => setImmediate(resolve))

function setup(options = {}) {
  let definition, photoCallback
  const deleted = []
  let photoCalls = 0
  global.Page = value => { definition = value }
  global.wx = {
    canIUse: () => true, createVKSession() {}, createOffscreenCanvas() {},
    authorize: value => queueMicrotask(() => options.denied ? value.fail({}) : value.success({})),
    nextTick: queueMicrotask,
    getFileSystemManager: () => ({ unlink: value => deleted.push(value.filePath) }),
    createSelectorQuery: () => {
      const query = { select: () => query, boundingClientRect: () => query, exec: cb => cb([
        { left: 0, top: 100, width: 375, height: 500 },
        { left: 30, top: 320, width: 315, height: 65 },
      ]) }
      return query
    },
    createCameraContext: () => ({ takePhoto: value => { photoCalls++; photoCallback = value } }),
  }
  const path = require.resolve('../miniprogram/pages/index/index.ts')
  delete require.cache[path]
  require(path)
  const page = { ...definition, data: structuredClone(definition.data) }
  page.setData = (patch, callback) => { Object.assign(page.data, patch); if (callback) queueMicrotask(callback) }
  page.onLoad()
  return { page, deleted, get photoCalls() { return photoCalls },
    deliverPhoto: () => photoCallback.success({ tempImagePath: 'wxfile://photo.jpg' }) }
}
async function cameraReady(page) {
  page.startCamera(); await flush(); page.cameraInitialized()
}
const input = value => ({ detail: { value } })

test('denied camera permission preserves the existing plate and manual entry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { page } = setup({ denied: true })
  page.inputPlate(input('粤B12345'))
  page.startCamera(); await flush()
  assert.equal(page.data.stage, 'form')
  assert.equal(page.data.plateNumber, '粤B12345')
  assert.match(page.data.notice, /权限/)
  page.confirmManual(); assert.equal(page.data.confirmed, true)
  page.onUnload()
})
test('photo processing prevents double capture and confirms edited candidate into form', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = setup(), page = mock.page
  page.service = { cancel() {}, recognize: async value => {
    assert.equal(page.data.stage, 'processing')
    assert.deepEqual(value.frame, { x: 30, y: 220, width: 315, height: 65 })
    return { candidates: ['粤B12345', '沪AD12345'], elapsedMs: 1200, retried: false }
  } }
  await cameraReady(page)
  page.takePhoto(); page.takePhoto()
  assert.equal(mock.photoCalls, 1)
  mock.deliverPhoto(); await flush()
  assert.equal(page.data.stage, 'review')
  assert.equal(page.data.plateNumber, '')
  page.selectCandidate({ currentTarget: { dataset: { plate: '沪AD12345' } } })
  page.inputDraft(input('沪ＡＤ５４３２１'))
  page.confirmResult()
  assert.equal(page.data.stage, 'form')
  assert.equal(page.data.plateNumber, '沪AD54321')
  assert.equal(page.data.confirmed, true)
  assert.deepEqual(mock.deleted, ['wxfile://photo.jpg'])
  page.onUnload()
})
test('cancelled review leaves old form value unchanged; invalid edit cannot confirm', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { page } = setup()
  page.inputPlate(input('京A12345'))
  page.setData({ stage: 'review', draft: '粤B12345', draftValid: true })
  page.inputDraft(input('粤B12O45')); page.confirmResult()
  assert.equal(page.data.stage, 'review')
  page.cancelCapture()
  assert.equal(page.data.plateNumber, '京A12345')
  page.onUnload()
})
test('hiding the page invalidates late OCR results, cleans photo and allows recapture', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = setup(), page = mock.page
  let resolve
  page.service = { cancel() {}, recognize: () => new Promise(done => { resolve = done }) }
  page.inputPlate(input('京A12345'))
  await cameraReady(page); page.takePhoto(); mock.deliverPhoto(); await flush()
  page.onHide(); page.onShow()
  resolve({ candidates: ['粤B12345'], elapsedMs: 1000, retried: false }); await flush()
  assert.equal(page.data.stage, 'form')
  assert.equal(page.data.plateNumber, '京A12345')
  assert.deepEqual(mock.deleted, ['wxfile://photo.jpg'])
  await cameraReady(page)
  assert.equal(page.data.stage, 'camera')
  page.onUnload()
})
test('late photo after cancellation is deleted and never recognized', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = setup(), page = mock.page
  await cameraReady(page); page.takePhoto(); page.cancelCapture(); mock.deliverPhoto()
  assert.deepEqual(mock.deleted, ['wxfile://photo.jpg'])
  assert.equal(page.data.stage, 'form')
  page.onUnload()
})
test('camera initialization and shutter callbacks have bounded waits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { page } = setup()
  page.startCamera(); await flush(); t.mock.timers.tick(10000)
  assert.equal(page.data.stage, 'error')
  assert.match(page.data.error, /相机启动超时/)
  page.retryCapture(); await flush(); page.cameraInitialized(); page.takePhoto()
  t.mock.timers.tick(10000)
  assert.equal(page.data.stage, 'error')
  assert.match(page.data.error, /拍照超时/)
  page.onUnload()
})
