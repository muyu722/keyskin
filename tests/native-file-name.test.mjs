import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeFileName, recentDisplayName } from '../src/native-file-name.ts'

test('iOS file URLs display Chinese, spaces and literal percent signs', () => {
  for (const name of ['史莱姆.bds', '键盘 26 键.bdi', '50%亮度.sxi', '%E5%8F%B2.bds']) {
    const segment = encodeURIComponent(name)
    const path = `file:///private/Documents/${segment}`
    assert.equal(nativeFileName(path), name)
    assert.equal(recentDisplayName(path, segment), name)
  }
})

test('recent display names and unencoded path strings keep literal percent sequences', () => {
  assert.equal(nativeFileName('/tmp/%E5%8F%B2.bds'), '%E5%8F%B2.bds')
  assert.equal(recentDisplayName('file:///private/Documents/%25E5%258F%25B2.bds', '%E5%8F%B2.bds'), '%E5%8F%B2.bds')
  assert.equal(recentDisplayName('content://provider/%E5%8F%B2', '%E5%8F%B2.bds'), '%E5%8F%B2.bds')
  assert.equal(recentDisplayName('file:///private/Documents/%E5%8F%B2.bds', '我的名字.bds'), '我的名字.bds')
})
