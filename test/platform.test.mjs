/**
 * 平台映射的纯函数单测：零依赖，`node --test` 直接跑。
 *
 * 这些字符串必须和**服务端** `src/native.mjs` 的 `SUPPORTED_TARGETS` / `assetName` /
 * `binaryName` 逐字一致：对不上的后果不是报错，而是「下回来一个跑不起来的二进制」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPORTED_TARGETS, assetName, binaryName, bundleAad, detectTarget, exeSuffix, isSupportedTarget
} from '../utils/platform.js'

test('本机（Linux x64）映射到 x86_64-unknown-linux-gnu', () => {
  const t = detectTarget()
  if (process.platform === 'linux' && process.arch === 'x64') {
    assert.equal(t, 'x86_64-unknown-linux-gnu')
  } else if (process.platform === 'linux' && process.arch === 'arm64') {
    assert.equal(t, 'aarch64-unknown-linux-gnu')
  } else if (process.platform === 'win32' && process.arch === 'x64') {
    assert.equal(t, 'x86_64-pc-windows-msvc')
  } else {
    assert.throws(() => detectTarget())
  }
})

test('支持列表和服务端保持同一份', () => {
  assert.deepEqual(SUPPORTED_TARGETS, [
    'x86_64-pc-windows-msvc',
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu'
  ])
  for (const t of SUPPORTED_TARGETS) assert.ok(isSupportedTarget(t))
  for (const bad of ['', null, undefined, 'aarch64-apple-darwin', 'x86_64-unknown-linux-musl']) {
    assert.equal(isSupportedTarget(bad), false)
  }
})

test('不支持的平台要给出清晰错误，不能静默', () => {
  // 直接改 process 的取值来模拟（Node 允许覆盖这两个属性）
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const origArch = Object.getOwnPropertyDescriptor(process, 'arch')

  const setPlat = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true })
  const setArch = (a) => Object.defineProperty(process, 'arch', { value: a, configurable: true })

  try {
    setPlat('darwin'); setArch('arm64')
    assert.throws(() => detectTarget(), /不支持这台机器：macOS\/arm64/)

    setPlat('darwin'); setArch('x64')
    assert.throws(() => detectTarget(), /macOS\/x64/)

    setPlat('linux'); setArch('ia32')
    assert.throws(() => detectTarget(), /Linux\/ia32/)

    setPlat('linux'); setArch('arm')
    assert.throws(() => detectTarget(), /Linux\/arm/)
    // 错误信息里要带上「支持哪些」，不然主人只能来问我们
    assert.throws(() => detectTarget(), /只有 Linux\(x86_64、arm64\) 和 Windows\(x86_64\)/)
  } finally {
    Object.defineProperty(process, 'platform', origPlatform)
    Object.defineProperty(process, 'arch', origArch)
  }
})

test('exeSuffix 只有 windows 目标有后缀', () => {
  assert.equal(exeSuffix('x86_64-pc-windows-msvc'), '.exe')
  assert.equal(exeSuffix('x86_64-unknown-linux-gnu'), '')
  assert.equal(exeSuffix('aarch64-unknown-linux-gnu'), '')
  assert.equal(exeSuffix(''), '')
  assert.equal(exeSuffix(undefined), '')
})

test('binaryName = 包内文件名（和服务端 native.mjs 对齐）', () => {
  assert.equal(binaryName('watch', 'x86_64-unknown-linux-gnu'), 'gok-watch')
  assert.equal(binaryName('im', 'x86_64-unknown-linux-gnu'), 'gok-im')
  assert.equal(binaryName('im', 'x86_64-pc-windows-msvc'), 'gok-im.exe')
  assert.equal(binaryName('watch', 'aarch64-unknown-linux-gnu'), 'gok-watch')
})

test('assetName = GitHub Release 资产名，也是 /latest 的 asset 字段', () => {
  assert.equal(
    assetName('watch', 'x86_64-unknown-linux-gnu'),
    'gok-watch-x86_64-unknown-linux-gnu'
  )
  assert.equal(
    assetName('im', 'x86_64-pc-windows-msvc'),
    'gok-im-x86_64-pc-windows-msvc.exe'
  )
  assert.equal(
    assetName('watch', 'aarch64-unknown-linux-gnu'),
    'gok-watch-aarch64-unknown-linux-gnu'
  )
})

test('bundleAad 的格式 = 契约 §5 的 aad（供断言用，运行时仍用服务端回的原值）', () => {
  assert.equal(
    bundleAad('watch', 'native-v0.2.0', 'x86_64-unknown-linux-gnu'),
    'gokenc:v1:watch:native-v0.2.0:x86_64-unknown-linux-gnu'
  )
})
