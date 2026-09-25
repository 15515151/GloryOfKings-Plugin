/**
 * 分发协议的单测：解密、设备号、请求错误翻译、安装器的「失败保留旧版」。
 *
 * 全部在临时沙箱里跑**真实源码**（`test/helpers/sandbox.mjs` 把 `#components` 换成假的），
 * 网络一律用注入的假 `fetch`，一个字节都不上真实网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cleanup, ensurePluginRoot, makeSandbox, run } from './helpers/sandbox.mjs'

/**
 * ⚠️ PRELUDE 里的常量只活在**沙箱脚本里**，测试文件自身的断言用不了它们。
 * 这里把同样几个值再写一份（改了要一起改），测试文件的断言一律用这几个。
 */
const TARGET = 'x86_64-unknown-linux-gnu'
const SHA = 'native-v0.2.0'

/** 沙箱脚本的公共前缀：假 logger + 假的 tar/seal 工具 */
const PRELUDE = `
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
const ROOT = fs.readFileSync(new URL('./case-root.txt', import.meta.url), 'utf8').trim()
globalThis.logger = { info () {}, warn () {}, error () {}, debug () {}, mark () {} }

/** 造一个合法的 GOKENC1 容器（和服务端 seal.mjs 的布局逐字一致） */
function seal (plain, key, aad, { alg = 1 } = {}) {
  const magic = Buffer.from('GOKENC1\\0', 'latin1')
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([c.update(plain), c.final()])
  const header = Buffer.alloc(21)
  magic.copy(header, 0)
  header[8] = alg
  nonce.copy(header, 9)
  return Buffer.concat([header, body, c.getAuthTag()])
}

/** 照服务端 native.mjs 的规则写一个单文件 ustar tar.gz */
function tarGz (name, data, { mode = 0o755 } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const header = Buffer.alloc(512)
  const octal = (v, len) => String(v).padStart(len, '0')
  Buffer.from(name, 'utf8').copy(header, 0, 0, 100)
  Buffer.from(octal(mode.toString(8), 7), 'utf8').copy(header, 100)
  Buffer.from(octal('0', 7), 'utf8').copy(header, 108)
  Buffer.from(octal('0', 7), 'utf8').copy(header, 116)
  Buffer.from(octal(buf.length.toString(8), 11), 'utf8').copy(header, 124)
  Buffer.from('00000000000', 'utf8').copy(header, 136)
  header[156] = 0x30
  Buffer.from('ustar', 'utf8').copy(header, 257)
  header[263] = 0x30
  header[264] = 0x30
  for (let i = 148; i < 156; i++) header[i] = 0x20
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  Buffer.from(sum.toString(8).padStart(6, '0'), 'utf8').copy(header, 148)
  header[154] = 0
  header[155] = 0x20
  const pad = (512 - (buf.length % 512)) % 512
  return zlib.gzipSync(Buffer.concat([header, buf, Buffer.alloc(pad), Buffer.alloc(1024)]))
}

/** 一个能跑 --version 的假二进制（安装器会自检它） */
function fakeBinSource (version = '0.2.0') {
  return '#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "gok-watch ' + version + ' (x86_64-unknown-linux-gnu)"; exit 0; fi\\nsleep 60\\n'
}

const TARGET = 'x86_64-unknown-linux-gnu'
const SHA = 'native-v0.2.0'
const KEY = Buffer.alloc(32, 7)
const AAD = 'gokenc:v1:watch:native-v0.2.0:x86_64-unknown-linux-gnu'
`

/* ------------------------------------------------------------ 解密 */

test('decryptBundle：合法容器解出原文', () => {
  const root = makeSandbox()
  try {
    const out = run(root, `
${PRELUDE}
const { decryptBundle } = await import('./utils/dist.js')
const plain = Buffer.from('hello 王者 native bundle', 'utf8')
const container = seal(plain, KEY, AAD)
const got = decryptBundle(container, KEY.toString('base64'), AAD)
if (!got.equals(plain)) throw new Error('解出来的字节和原文不一致')
console.log('OK', got.length)
`)
    assert.ok(out.ok, out.stderr)
    // 'hello 王者 native bundle'：6 + 6(王者) + 14 个 UTF-8 字节
    assert.match(out.stdout, /OK 26/)
  } finally {
    cleanup(root)
  }
})

test('decryptBundle：坏 magic / 坏 alg / 改一个字节 / 截断，都要给出中文错误', () => {
  const root = makeSandbox()
  try {
    const out = run(root, `
${PRELUDE}
const { decryptBundle } = await import('./utils/dist.js')
const plain = Buffer.from('payload', 'utf8')
const good = seal(plain, KEY, AAD)
const keyB64 = KEY.toString('base64')

const cases = []
// ① 不是密文容器（老版明文包下回来就是这个）
cases.push(['magic', Buffer.concat([Buffer.from('NOTGOK!!'), good.subarray(8)])])
// ② 算法编号不认识
cases.push(['alg', seal(plain, KEY, AAD, { alg: 2 })])
// ③ 密文被改了一个字节 → GCM 认证失败
const tampered = Buffer.from(good)
tampered[25] = tampered[25] ^ 0xff
cases.push(['tamper', tampered])
// ④ 下载被截断
cases.push(['short', good.subarray(0, 30)])

const seen = {}
for (const [name, buf] of cases) {
  try {
    decryptBundle(buf, keyB64, AAD)
    throw new Error(name + ' 竟然解成功了')
  } catch (error) {
    seen[name] = error.message
  }
}
console.log(JSON.stringify(seen))
`)
    assert.ok(out.ok, out.stderr)
    const seen = JSON.parse(out.stdout)
    assert.match(seen.magic, /magic 不对/)
    assert.match(seen.alg, /不认识的加密算法编号 2/)
    assert.match(seen.tamper, /解密失败（密文被改过或密钥不对）/)
    assert.match(seen.short, /密文容器太短/)
  } finally {
    cleanup(root)
  }
})

test('decryptBundle：AAD 或密钥不对也要失败（不许拿半截数据往下走）', () => {
  const root = makeSandbox()
  try {
    const out = run(root, `
${PRELUDE}
const { decryptBundle } = await import('./utils/dist.js')
const container = seal(Buffer.from('x'), KEY, AAD)
const results = {}
try { decryptBundle(container, KEY.toString('base64'), 'gokenc:v1:im:native-v0.2.0:x86_64-unknown-linux-gnu') } catch (e) { results.wrongAad = e.message }
try { decryptBundle(container, Buffer.alloc(32, 9).toString('base64'), AAD) } catch (e) { results.wrongKey = e.message }
try { decryptBundle(container, Buffer.alloc(16).toString('base64'), AAD) } catch (e) { results.badKeyLen = e.message }
console.log(JSON.stringify(results))
`)
    assert.ok(out.ok, out.stderr)
    const seen = JSON.parse(out.stdout)
    assert.match(seen.wrongAad, /解密失败/)
    assert.match(seen.wrongKey, /解密失败/)
    assert.match(seen.badKeyLen, /密钥长度不对/)
  } finally {
    cleanup(root)
  }
})

/* ------------------------------------------------------------ 设备号 / 配置 */

test('deviceGuid：生成 32 位小写 hex、0600 落盘、多次调用同一个值', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
${PRELUDE}
const { deviceGuid, DEVICE_FILE } = await import('./utils/dist.js')
const a = deviceGuid()
const b = deviceGuid()
const stat = fs.statSync(DEVICE_FILE)
console.log(JSON.stringify({ a, b, saved: fs.readFileSync(DEVICE_FILE, 'utf8').trim(), mode: (stat.mode & 0o777).toString(8) }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.match(r.a, /^[0-9a-f]{32}$/)
    assert.equal(r.a, r.b)
    assert.equal(r.a, r.saved)
    assert.equal(r.mode, '600')
  } finally {
    cleanup(root)
  }
})

test('deviceGuid：盘上已有合法值时沿用，不重新生成', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    fs.mkdirSync(path.join(root, 'PluginRoot', 'data'), { recursive: true })
    fs.writeFileSync(path.join(root, 'PluginRoot', 'data', 'device.guid'), 'AABBCCDDEEFF00112233445566778899', 'utf8')
    const out = run(root, `
${PRELUDE}
const { deviceGuid } = await import('./utils/dist.js')
console.log(deviceGuid())
`)
    assert.ok(out.ok, out.stderr)
    assert.equal(out.stdout, 'aabbccddeeff00112233445566778899')
  } finally {
    cleanup(root)
  }
})

test('readDistConfig：只认 shareApiUrl / distToken，**不回退**老键', () => {
  const root = makeSandbox()
  try {
    const out = run(root, `
${PRELUDE}
const first = (await import('./utils/dist.js')).readDistConfig()
console.log(JSON.stringify(first))

// 「老机器」形态：值都躺在废弃的 distUrl / shareToken 里
const { setFakeConfig } = await import('./fake-config.mjs')
setFakeConfig({ shareApiUrl: '', distToken: '', distUrl: 'http://old.example.com:6868/', shareToken: 'gok_old_token_value_1234567890' })
const second = (await import('./utils/dist.js')).readDistConfig()
console.log(JSON.stringify(second))
`)
    assert.ok(out.ok, out.stderr)
    const [first, second] = out.stdout.split('\n').map(JSON.parse)
    assert.equal(first.url, 'https://dist.test.invalid:8787')
    assert.equal(first.token, 'gok_1_fake_token_for_tests_only_000000')
    // ⚠️ 有意钉住的契约变更：读取不再 `||` 回退老键。
    //    老机器由 utils/migrateConfig.js 在启动时把值搬过来（见 test/migrateConfig.test.mjs）。
    assert.equal(second.url, '', '还回退 distUrl = 回退没去干净')
    assert.equal(second.token, '', '还回退 shareToken = 回退没去干净')
  } finally {
    cleanup(root)
  }
})

/* ------------------------------------------------------------ 请求错误翻译 */

test('fetchLatest：契约 §6 的错误码各给一句人话，且不抛', () => {
  const root = makeSandbox()
  try {
    const out = run(root, `
${PRELUDE}
const { fetchLatest } = await import('./utils/dist.js')
const cases = [
  [400, { error: 'invalid_target' }],
  [401, { error: 'unauthorized' }],
  [403, { error: 'forbidden' }],
  [404, { error: 'no_such_package' }],
  [429, { error: 'rate_limited' }],
  [500, { error: 'internal', message: '服务内部错误' }]
]
const seen = {}
for (const [status, body] of cases) {
  const fake = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const r = await fetchLatest('watch', TARGET, { url: 'http://x.invalid', token: 't', fetchImpl: fake })
  seen[status] = { ok: r.ok, message: r.message }
}
console.log(JSON.stringify(seen))
`)
    assert.ok(out.ok, out.stderr)
    const seen = JSON.parse(out.stdout)
    assert.equal(seen['400'].ok, false)
    assert.match(seen['400'].message, /平台标识/)
    assert.match(seen['401'].message, /令牌无效/)
    assert.match(seen['403'].message, /已被吊销/)
    assert.match(seen['404'].message, /服务器上没有这个包/)
    assert.match(seen['429'].message, /限流/)
    // ⚠️ 500 是「暂时拿不到新的」，绝不能变成「停服」
    assert.match(seen['500'].message, /服务端打包失败/)
    for (const s of Object.values(seen)) assert.equal(s.ok, false)
  } finally {
    cleanup(root)
  }
})

test('fetchLatest：kind 不是 native、asset 对不上、不支持的目标都拦下', () => {
  const root = makeSandbox()
  try {
    const out = run(root, `
${PRELUDE}
const { fetchLatest, downloadBundle } = await import('./utils/dist.js')
const conf = { url: 'http://x.invalid', token: 't' }

const jsPkg = async () => new Response(JSON.stringify({ ok: true, sha: 'abc', kind: 'js' }), { status: 200 })
const wrongAsset = async () => new Response(JSON.stringify({
  ok: true, sha: 'native-v0.2.0', kind: 'native', asset: 'gok-watch-x86_64-pc-windows-msvc.exe',
  enc: { keyId: 'k1' }
}), { status: 200 })
const fine = async () => new Response(JSON.stringify({
  ok: true, sha: 'native-v0.2.0', kind: 'native', asset: 'gok-watch-x86_64-unknown-linux-gnu',
  sizePlain: 123, sha256: 'aa', enc: { keyId: 'k1' }
}), { status: 200 })

const r1 = await fetchLatest('watch', TARGET, { ...conf, fetchImpl: jsPkg })
const r2 = await fetchLatest('watch', TARGET, { ...conf, fetchImpl: wrongAsset })
const r3 = await fetchLatest('watch', TARGET, { ...conf, fetchImpl: fine })
const r4 = await fetchLatest('watch', 'aarch64-apple-darwin', { ...conf, fetchImpl: fine })

// 304：服务端没变化时不该重下（带 If-None-Match 才可能拿到）
let sentEtag = null
const notModified = async (url, opts) => {
  sentEtag = opts.headers['If-None-Match'] || null
  return new Response(null, { status: 304 })
}
const r5 = await downloadBundle('watch', 'native-v0.2.0', TARGET, { ...conf, etag: '"abc-1"', fetchImpl: notModified })

console.log(JSON.stringify({ r1, r2, r3, r4, r5, sentEtag }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.match(r.r1.message, /不是原生包/)
    assert.match(r.r2.message, /产物名对不上/)
    assert.equal(r.r3.ok, true)
    assert.equal(r.r3.sha, 'native-v0.2.0')
    assert.equal(r.r3.keyId, 'k1')
    assert.match(r.r4.message, /不支持的平台标识/)
    // 304 翻成 notModified，不抛、也拿不到 buffer
    assert.equal(r.r5.ok, true)
    assert.equal(r.r5.notModified, true)
    assert.equal(r.sentEtag, '"abc-1"')
  } finally {
    cleanup(root)
  }
})

/* ------------------------------------------------------------ 安装器 */

test('installNative：先问版本，远端 sha 与台账一致 + 二进制完好 → 不下载，updated:false', async () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const dir = path.join(root, 'PluginRoot', 'server')
    fs.mkdirSync(dir, { recursive: true })
    const bin = path.join(dir, 'gok-watch')
    fs.writeFileSync(bin, 'fake binary bytes', { mode: 0o755 })

    const { createHash } = await import('node:crypto')
    const buf = fs.readFileSync(bin)
    fs.writeFileSync(path.join(dir, '.gok-native.json'), JSON.stringify({
      name: 'watch', kind: 'native', sha: SHA, target: TARGET, binary: 'gok-watch',
      size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), version: 'x'
    }), { mode: 0o600 })

    const out = run(root, `
${PRELUDE}
const { installNative } = await import('./utils/dist.js')
// ⭐ 必须**先**问 /latest：只有远端 sha 和台账一致才准跳过下载。
//    下载那一步故意抛错 —— 走到就说明判断顺序又反了
const seen = []
const fake = async (url) => {
  seen.push(url.replace('http://x.invalid', ''))
  if (url.includes('/latest')) {
    return new Response(JSON.stringify({ ok: true, sha: SHA, kind: 'native', asset: 'gok-watch-' + TARGET, enc: { keyId: 'k1' } }), { status: 200 })
  }
  throw new Error('不该发请求：' + url)
}
const r = await installNative({ name: 'watch', destDir: path.join(ROOT, 'PluginRoot', 'server'), url: 'http://x.invalid', token: 't', fetchImpl: fake })
console.log(JSON.stringify({ seen, r }))
`, )
    assert.ok(out.ok, out.stderr)
    const res = JSON.parse(out.stdout)
    // ⭐ 一定问过版本，而且只问了版本：一个字节都不下载
    assert.deepEqual(res.seen, ['/api/v1/packages/watch/latest?target=' + TARGET])
    assert.equal(res.r.ok, true)
    assert.equal(res.r.updated, false)
    assert.equal(res.r.sha, SHA)
  } finally {
    cleanup(root)
  }
})

test('installNative：台账是旧版、上游有新版本 → 必须下载更新（不能拿台账当「已是最新」）', async () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const { createHash } = await import('node:crypto')
    const dir = path.join(root, 'PluginRoot', 'server')
    fs.mkdirSync(dir, { recursive: true })
    // 本地装的是 v0.2.0，而且**文件完好** —— 这正是旧代码误报「已是最新」的场景
    const oldBin = 'OLD v0.2.0 BINARY'
    fs.writeFileSync(path.join(dir, 'gok-watch'), oldBin, { mode: 0o755 })
    fs.writeFileSync(path.join(dir, '.gok-native.json'), JSON.stringify({
      name: 'watch', kind: 'native', sha: SHA, target: TARGET, binary: 'gok-watch',
      size: Buffer.byteLength(oldBin),
      sha256: createHash('sha256').update(Buffer.from(oldBin)).digest('hex'),
      version: 'gok-watch 0.2.0 (x86_64-unknown-linux-gnu)'
    }), { mode: 0o600 })

    const out = run(root, `
${PRELUDE}
const { installNative, readNativeState } = await import('./utils/dist.js')
const NEW_SHA = 'native-v0.4.0'
const destDir = path.join(ROOT, 'PluginRoot', 'server')
const binSrc = fakeBinSource('0.4.0')
const plain = tarGz('gok-watch', binSrc)
const container = seal(plain, KEY, AAD)
const plainSha = crypto.createHash('sha256').update(plain).digest('hex')
const seen = []
const fake = async (url) => {
  seen.push(url.replace('http://x.invalid', ''))
  if (url.includes('/latest')) {
    return new Response(JSON.stringify({ ok: true, sha: NEW_SHA, kind: 'native', asset: 'gok-watch-' + TARGET, enc: { keyId: 'k1' } }), { status: 200 })
  }
  if (url.includes('/download')) {
    // 下密文必须带**远端**的 sha，不能拿台账里的旧 sha 去下
    if (!url.includes('sha=' + NEW_SHA)) throw new Error('下载用的 sha 不对：' + url)
    return new Response(new Uint8Array(container), { status: 200, headers: { 'x-gok-key-id': 'k1' } })
  }
  if (url.includes('/key')) {
    return new Response(JSON.stringify({ ok: true, key: KEY.toString('base64'), aad: AAD, keyId: 'k1', sha256Plain: plainSha }), { status: 200 })
  }
  throw new Error('unexpected ' + url)
}
const r = await installNative({ name: 'watch', destDir, url: 'http://x.invalid', token: 't', fetchImpl: fake })
const installed = fs.readFileSync(path.join(destDir, 'gok-watch'))
console.log(JSON.stringify({
  seen, r, state: readNativeState(destDir),
  diskSha: crypto.createHash('sha256').update(installed).digest('hex'),
  installedText: installed.toString('utf8')
}))
`, )
    assert.ok(out.ok, out.stderr)
    const res = JSON.parse(out.stdout)
    // ① 先问版本
    assert.equal(res.seen[0], '/api/v1/packages/watch/latest?target=' + TARGET)
    // ② 真的去下载并换掉了
    assert.ok(res.seen.some(u => u.includes('/download')), '没去下载：' + JSON.stringify(res.seen))
    assert.equal(res.r.ok, true)
    assert.equal(res.r.updated, true)
    assert.equal(res.r.sha, 'native-v0.4.0')
    assert.match(res.r.version, /0\.4\.0/)
    // ③ 磁盘上换成了新二进制，台账跟着换成新版（否则下次又拿旧版本号去比）
    assert.match(res.installedText, /0\.4\.0/)
    assert.equal(res.state.sha, 'native-v0.4.0')
    assert.equal(res.state.sha256, res.diskSha)
  } finally {
    cleanup(root)
  }
})

test('installNative：版本没变但二进制被改坏了 → 会重下（不能信台账一句谎话）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const dir = path.join(root, 'PluginRoot', 'server')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'gok-watch'), 'corrupted', { mode: 0o755 })
    fs.writeFileSync(path.join(dir, '.gok-native.json'), JSON.stringify({
      name: 'watch', kind: 'native', sha: SHA, target: TARGET, binary: 'gok-watch',
      size: 99999, sha256: 'deadbeef', version: 'x'
    }), { mode: 0o600 })

    const out = run(root, `
${PRELUDE}
const { installNative } = await import('./utils/dist.js')
const seen = []
const fake = async (url) => {
  seen.push(url.replace('http://x.invalid', ''))
  if (url.includes('/latest')) {
    return new Response(JSON.stringify({ ok: true, sha: SHA, kind: 'native', asset: 'gok-watch-' + TARGET, enc: { keyId: 'k1' } }), { status: 200 })
  }
  // 下载这一步故意 500：要验的是「它到没到下载」，不是真下下来
  return new Response(JSON.stringify({ ok: false, error: 'internal' }), { status: 500 })
}
const r = await installNative({ name: 'watch', destDir: path.join(ROOT, 'PluginRoot', 'server'), url: 'http://x.invalid', token: 't', fetchImpl: fake })
console.log(JSON.stringify({ seen, r }))
`, )
    assert.ok(out.ok, out.stderr)
    const res = JSON.parse(out.stdout)
    // ⭐ 台账里的 sha 和远端一致，但磁盘上那个文件对不上台账 —— 必须**重下**，
    //    不能因为「版本号没变」就跳过
    assert.ok(res.seen.length, '一个请求都没发：' + JSON.stringify(res))
    assert.equal(res.seen.filter(u => u.includes('/latest')).length, 1)
    assert.ok(res.seen.some(u => u.includes('/download')), '没去下载：' + JSON.stringify(res.seen))
    assert.equal(res.r.ok, false)
    assert.match(res.r.message, /服务端打包失败/)
  } finally {
    cleanup(root)
  }
})

test('installNative：解包内容不对 / 自检失败 → 旧二进制原样保留、staging 清干净', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const dir = path.join(root, 'PluginRoot', 'server')
    fs.mkdirSync(dir, { recursive: true })
    const OLD = 'OLD BINARY CONTENT'
    fs.writeFileSync(path.join(dir, 'gok-watch'), OLD, { mode: 0o755 })

    const out = run(root, `
${PRELUDE}
const { installNative } = await import('./utils/dist.js')
const destDir = path.join(ROOT, 'PluginRoot', 'server')

async function tryInstall (tgz, label) {
  const plain = tgz
  const container = seal(plain, KEY, AAD)
  const plainSha = crypto.createHash('sha256').update(plain).digest('hex')
  const fake = async (url) => {
    if (url.includes('/latest')) {
      return new Response(JSON.stringify({ ok: true, sha: SHA, kind: 'native', asset: 'gok-watch-' + TARGET, enc: { keyId: 'k1' } }), { status: 200 })
    }
    if (url.includes('/download')) {
      return new Response(new Uint8Array(container), { status: 200, headers: { 'x-gok-key-id': 'k1' } })
    }
    if (url.includes('/key')) {
      return new Response(JSON.stringify({ ok: true, key: KEY.toString('base64'), aad: AAD, keyId: 'k1', sha256Plain: plainSha, sizePlain: plain.length }), { status: 200 })
    }
    throw new Error('unexpected url ' + url)
  }
  const r = await installNative({ name: 'watch', destDir, url: 'http://x.invalid', token: 't', force: true, fetchImpl: fake })
  return { label, r }
}

// ① 包里有别的文件（不是单个 gok-watch）
const a = await tryInstall(tarGz('not-our-binary', 'x'), 'wrong-content')
// ② 解出来确实叫 gok-watch，但根本跑不起来（不是可执行脚本）
const b = await tryInstall(tarGz('gok-watch', Buffer.from('not an executable at all')), 'selfcheck')

const oldStill = fs.readFileSync(path.join(destDir, 'gok-watch'), 'utf8')
const staging = fs.readdirSync(destDir).filter(f => f.startsWith('.staging-'))
const stateExists = fs.existsSync(path.join(destDir, '.gok-native.json'))
console.log(JSON.stringify({ a: a.r, b: b.r, oldStill, staging, stateExists }))
`, )
    assert.ok(out.ok, out.stderr)
    const res = JSON.parse(out.stdout)
    assert.equal(res.a.ok, false)
    assert.match(res.a.message, /包内容不对/)
    assert.equal(res.b.ok, false)
    assert.match(res.b.message, /跑不起来/)
    // ⭐ 旧二进制一个字节没动、staging 清干净、没写台账
    assert.equal(res.oldStill, 'OLD BINARY CONTENT')
    assert.deepEqual(res.staging, [])
    assert.equal(res.stateExists, false)
  } finally {
    cleanup(root)
  }
})

test('installNative：sha256 对不上会重试一轮，两轮都失败才报错', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
${PRELUDE}
const { installNative } = await import('./utils/dist.js')
const destDir = path.join(ROOT, 'PluginRoot', 'server')
const plain = tarGz('gok-watch', fakeBinSource())
const container = seal(plain, KEY, AAD)
let attempts = 0
const fake = async (url) => {
  if (url.includes('/latest')) {
    return new Response(JSON.stringify({ ok: true, sha: SHA, kind: 'native', asset: 'gok-watch-' + TARGET, enc: { keyId: 'k1' } }), { status: 200 })
  }
  if (url.includes('/download')) {
    attempts += 1
    return new Response(new Uint8Array(container), { status: 200, headers: { 'x-gok-key-id': 'k1' } })
  }
  if (url.includes('/key')) {
    // 故意给一个错的摘要，模拟「下错版本 / 缓存串了」
    return new Response(JSON.stringify({ ok: true, key: KEY.toString('base64'), aad: AAD, keyId: 'k1', sha256Plain: 'f'.repeat(64) }), { status: 200 })
  }
  throw new Error('unexpected ' + url)
}
const r = await installNative({ name: 'watch', destDir, url: 'http://x.invalid', token: 't', fetchImpl: fake })
console.log(JSON.stringify({ attempts, r }))
`, )
    assert.ok(out.ok, out.stderr)
    const res = JSON.parse(out.stdout)
    assert.equal(res.attempts, 2)
    assert.equal(res.r.ok, false)
    assert.match(res.r.message, /明文摘要对不上/)
  } finally {
    cleanup(root)
  }
})

test('installNative：成功路径 → chmod 0755 + 写台账（sha/size/sha256 都记的是二进制本身）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
${PRELUDE}
const { installNative, readNativeState } = await import('./utils/dist.js')
const destDir = path.join(ROOT, 'PluginRoot', 'server')
const binSrc = fakeBinSource()
const plain = tarGz('gok-watch', binSrc)
const container = seal(plain, KEY, AAD)
const plainSha = crypto.createHash('sha256').update(plain).digest('hex')
const fake = async (url) => {
  if (url.includes('/latest')) {
    return new Response(JSON.stringify({ ok: true, sha: SHA, kind: 'native', asset: 'gok-watch-' + TARGET, enc: { keyId: 'k1' } }), { status: 200 })
  }
  if (url.includes('/download')) return new Response(new Uint8Array(container), { status: 200, headers: { 'x-gok-key-id': 'k1' } })
  if (url.includes('/key')) {
    return new Response(JSON.stringify({ ok: true, key: KEY.toString('base64'), aad: AAD, keyId: 'k1', sha256Plain: plainSha }), { status: 200 })
  }
  throw new Error('unexpected ' + url)
}
const r = await installNative({ name: 'watch', destDir, url: 'http://x.invalid', token: 't', fetchImpl: fake })
const file = path.join(destDir, 'gok-watch')
if (!r.ok || !fs.existsSync(file)) {
  // 装失败时先把真因吐出来，免得只看到一句 statSync ENOENT
  console.log(JSON.stringify({ r, exists: fs.existsSync(file), dir: fs.readdirSync(destDir) }))
  process.exit(0)
}
const stat = fs.statSync(file)
const content = fs.readFileSync(file, 'utf8')
const state = readNativeState(destDir)
const staging = fs.readdirSync(destDir).filter(f => f.startsWith('.staging-'))
console.log(JSON.stringify({
  r, mode: (stat.mode & 0o777).toString(8), contentMatches: content === binSrc,
  state, staging,
  sizeMatches: state.size === stat.size,
  shaMatches: state.sha256 === crypto.createHash('sha256').update(Buffer.from(content)).digest('hex')
}))
`, )
    assert.ok(out.ok, out.stderr)
    const res = JSON.parse(out.stdout)
    assert.equal(res.r.ok, true)
    assert.equal(res.r.updated, true)
    assert.equal(res.r.sha, SHA)
    assert.equal(res.r.target, TARGET)
    assert.equal(res.mode, '755')
    assert.equal(res.contentMatches, true)
    assert.equal(res.state.sha, SHA)
    assert.equal(res.state.binary, 'gok-watch')
    assert.equal(res.state.asset, 'gok-watch-' + TARGET)
    assert.equal(res.sizeMatches, true)
    assert.equal(res.shaMatches, true)
    assert.deepEqual(res.staging, [])
  } finally {
    cleanup(root)
  }
})
