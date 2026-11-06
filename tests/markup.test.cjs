const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.join(__dirname, '../miniprogram')

test('all WXML interpolation expressions parse as JavaScript without XML entity escaping', () => {
  const markup = fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8')
  const expressions = [...markup.matchAll(/\{\{([\s\S]*?)\}\}/g)]
  assert.ok(expressions.length > 20)
  for (const [, expression] of expressions) {
    assert.doesNotThrow(() => new Function(`return (${expression})`), expression)
  }
})
test('manifest routes exist and camera authorization is not declared in app.json permission', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
  assert.equal(manifest.permission?.['scope.camera'], undefined)
  for (const page of manifest.pages) {
    for (const extension of ['.ts', '.json', '.wxml', '.wxss']) {
      assert.ok(fs.existsSync(path.join(root, page + extension)), page + extension)
    }
  }
})
