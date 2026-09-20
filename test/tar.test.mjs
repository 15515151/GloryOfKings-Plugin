/**
 * tar.gz 解包的纯函数单测：零依赖。
 *
 * ⚠️ 这里的 tar 头是**照服务端 `src/native.mjs` 的 `tarHeader` 手写**的 ustar，
 * 因为原生包就是那样封的（单文件、mode 0755）。同时也要覆盖 pax 那三种头 ——
 * JS 包（`git archive`）会带 `typeflag='g'` 的 `pax_global_header`，不跳过就整包解成垃圾。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { extractTarGz, normalizeBase, fmtUptime } from '../utils/deploy.js'

/* ------------------------------------------------------------ tar 构造 */

function octal (value, len) {
  return String(value).padStart(len, '0')
}

/** 照服务端 native.mjs 的规则写一个 ustar 头 */
function tarHeader (name, size, mode = 0o755, typeflag = '0') {
  const header = Buffer.alloc(512)
  Buffer.from(String(name), 'utf8').copy(header, 0, 0, 100)
  Buffer.from(octal(mode.toString(8), 7), 'utf8').copy(header, 100)
  Buffer.from(octal('0', 7), 'utf8').copy(header, 108)
  Buffer.from(octal('0', 7), 'utf8').copy(header, 116)
  Buffer.from(octal(size.toString(8), 11), 'utf8').copy(header, 124)
  Buffer.from('00000000000', 'utf8').copy(header, 136)
  header[156] = typeflag.charCodeAt(0)
  Buffer.from('ustar', 'utf8').copy(header, 257)
  header[263] = 0x30
  header[264] = 0x30
  for (let i = 148; i < 156; i++) header[i] = 0x20
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  Buffer.from(sum.toString(8).padStart(6, '0'), 'utf8').copy(header, 148)
  header[154] = 0
  header[155] = 0x20
  return header
}

/** 一个条目：头 + 数据 + 512 对齐补齐 */
function tarEntry (name, data, { mode = 0o755, typeflag = '0' } = {}) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const pad = (512 - (buf.length % 512)) % 512
  return Buffer.concat([tarHeader(name, buf.length, mode, typeflag), buf, Buffer.alloc(pad)])
}

function gz (parts) {
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
}

function tmpdir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gok-tar-'))
}

/* ------------------------------------------------------------ 用例 */

test('原生包的形态：单文件 tar.gz 解出 gok-watch，字节一个不差', () => {
  const dir = tmpdir()
  const payload = Buffer.from('#!/bin/sh\necho fake-watch\n', 'utf8')
  const buffer = gz([tarEntry('gok-watch', payload)])

  const out = extractTarGz(buffer, dir)
  assert.deepEqual(out.files, ['gok-watch'])
  assert.equal(out.bytes, payload.length)
  assert.ok(fs.readFileSync(path.join(dir, 'gok-watch')).equals(payload))
})

test('pax 的 g / x / L 三种头都要跳过（git archive 打出来的包靠这个）', () => {
  const dir = tmpdir()
  const realPath = 'deep/中文 目录/文件.js'
  // typeflag 'x'：真实路径在数据段里的 `<len> path=<值>` 那一行
  const paxData = Buffer.from(`${realPath.length + 6} path=${realPath}\n`, 'utf8')

  const buffer = gz([
    // git archive 每个包的第一个条目就是它，size=52，内容是空的 pax 记录
    tarEntry('pax_global_header', 'x'.repeat(52), { typeflag: 'g' }),
    tarEntry('ignored-name', paxData, { typeflag: 'x' }),
    tarEntry('placeholder', 'console.log(1)\n'),
    // GNU 长文件名：真实路径在数据段里，以 \0 结尾
    tarEntry('./ignored', Buffer.from('another/long/name.js\0'), { typeflag: 'L' }),
    tarEntry('placeholder2', 'x\n')
  ])

  const out = extractTarGz(buffer, dir)
  assert.deepEqual(out.files, [realPath, 'another/long/name.js'])
  assert.equal(fs.readFileSync(path.join(dir, realPath), 'utf8'), 'console.log(1)\n')
  assert.equal(fs.readFileSync(path.join(dir, 'another/long/name.js'), 'utf8'), 'x\n')
})

test('exclude 首段命中的路径不写盘（数据文件靠它兜底）', () => {
  const dir = tmpdir()
  const buffer = gz([
    tarEntry('server.js', 'ok\n'),
    tarEntry('data/AuthPool.json', '{"secret":1}\n'),
    tarEntry('.env', 'GOK_SALT=x\n'),
    tarEntry('node_modules/x/index.js', 'x\n'),
    tarEntry('config/config/config.yaml', 'y\n')
  ])

  const out = extractTarGz(buffer, dir)
  assert.deepEqual(out.files, ['server.js'])
  assert.deepEqual(out.skipped.sort(), ['.env', 'config/config/config.yaml', 'data/AuthPool.json', 'node_modules/x/index.js'])
  assert.equal(fs.existsSync(path.join(dir, 'data')), false)
  assert.equal(fs.existsSync(path.join(dir, '.env')), false)
})

test('\`..\` 想往上跑、符号链接都不解（防包被塞了指向外面的东西）', () => {
  const dir = tmpdir()
  const buffer = gz([
    tarEntry('../evil.js', 'x\n'),
    tarEntry('a/../b.js', 'x\n'),
    tarEntry('link', '/etc/passwd', { typeflag: '2' })
  ])

  const out = extractTarGz(buffer, dir)
  assert.deepEqual(out.files, [])
  assert.equal(fs.existsSync(path.join(path.dirname(dir), 'evil.js')), false)
  assert.equal(fs.existsSync(path.join(dir, 'link')), false)
})

test('截断/空的包解出来是空的（调用方据此保住旧文件）', () => {
  const dir = tmpdir()
  assert.deepEqual(extractTarGz(gz([]), dir).files, [])
  // 只有 100 字节、连一个头都不够
  assert.deepEqual(extractTarGz(zlib.gzipSync(Buffer.alloc(100)), dir).files, [])
})

test('normalizeBase：去尾部斜杠、缺协议补 http://、空值返回空串', () => {
  assert.equal(normalizeBase('https://gok.example.com:442/'), 'https://gok.example.com:442')
  assert.equal(normalizeBase('gok.example.com:8787'), 'http://gok.example.com:8787')
  assert.equal(normalizeBase('  http://127.0.0.1:8787//  '), 'http://127.0.0.1:8787')
  assert.equal(normalizeBase(''), '')
  assert.equal(normalizeBase(undefined), '')
})

test('fmtUptime：毫秒 → N 小时 M 分', () => {
  assert.equal(fmtUptime(0), '—')
  assert.equal(fmtUptime(-1), '—')
  assert.equal(fmtUptime(NaN), '—')
  assert.equal(fmtUptime(90_000), '1 分')
  assert.equal(fmtUptime(3_600_000), '1 小时 0 分')
  assert.equal(fmtUptime(3_600_000 + 12 * 60_000), '1 小时 12 分')
})
