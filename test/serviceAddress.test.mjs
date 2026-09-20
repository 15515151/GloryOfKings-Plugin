/**
 * 「合并之后只有一个服务、且读取只认一套键」的回归测试。
 *
 * 合并后：共享库地址 = 观战/消息的服务地址 = 同一个 URL，令牌也是同一个。
 * 历史上有两套键（`shareApiUrl` / `distUrl`、`distToken` / `shareToken`），
 * 而**不同的消费方曾经各读一半** —— 老机器只填了 `distUrl` 时：
 *   · 观战/消息部署得了
 *   · 共享库却报「还没接入」
 *
 * 现在的约定：**只认新键**，老键的值由 `utils/migrateConfig.js` 在启动时搬过来。
 * 这个文件钉两件事：
 *   1. 两个消费方读到的是同一个服务（key 一致性）
 *   2. 老键**不再**参与读取（回退已移除）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, ensurePluginRoot, makeSandbox, run } from './helpers/sandbox.mjs'

const URL = 'https://gok.example.com:442'
const TOKEN = 'gok_1_shared_token_value_000000000000'

/** 两个消费方各读一次，顺便把「读到的是什么」打出来 */
const SCRIPT = (cfgLiteral) => `
const { setFakeConfig } = await import('./fake-config.mjs')
const { readDistConfig } = await import('./utils/dist.js')
const { readShareConfig } = await import('./utils/shareStore.js')

setFakeConfig(${cfgLiteral})
const a = readDistConfig()          // 观战 / 营地消息
const b = readShareConfig()         // 共享库
console.log(JSON.stringify({ a, b }))
`

/** 新版配置形态：只有 shareApiUrl + distToken */
const NEW_STYLE = `{ shareApiUrl: '${URL}', distUrl: '', distToken: '${TOKEN}', shareToken: '' }`
/** 老版配置形态：只有 distUrl + shareToken（本机现在就是这个状态） */
const OLD_STYLE = `{ shareApiUrl: '', distUrl: '${URL}', distToken: '', shareToken: '${TOKEN}' }`

function readBoth (root, cfgLiteral) {
  const out = run(root, SCRIPT(cfgLiteral))
  assert.ok(out.ok, out.stderr)
  return JSON.parse(out.stdout)
}

test('新配置形态（shareApiUrl + distToken）：两个消费方读到同一个服务', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const r = readBoth(root, NEW_STYLE)
    assert.equal(r.a.url, URL)
    assert.equal(r.a.token, TOKEN)
    assert.equal(r.b.apiUrl, URL)
    assert.equal(r.b.token, TOKEN)
  } finally {
    cleanup(root)
  }
})

test('老配置形态（distUrl + shareToken）：读***不再***回退 —— 值靠启动迁移搬过来', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const r = readBoth(root, OLD_STYLE)
    // ⚠️ 这条是**有意**钉住的：老键不再参与读取。
    //    老机器上值躺在 distUrl / shareToken 时，靠 utils/migrateConfig.js
    //    在启动时搬到新键（见 test/migrateConfig.test.mjs），而不是读时 `||` 回退。
    //    真没迁移成功的话，宁可「读不到、提示还没接入」，也不要两套键各读一半 ——
    //    以前正是那样漏了共享库那一路。
    assert.equal(r.a.url, '', '观战/消息竟然还回退 distUrl（回退应该已经去掉了）')
    assert.equal(r.a.token, '', '观战/消息竟然还回退 shareToken')
    assert.equal(r.b.apiUrl, '', '共享库竟然还回退 distUrl')
    assert.equal(r.b.token, '', '共享库竟然还回退 shareToken')
  } finally {
    cleanup(root)
  }
})

test('两个键都有值时：以新键为准（新键优先，不被废弃键顶掉）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const r = readBoth(root, `{
      shareApiUrl: '${URL}', distUrl: 'http://old.example.com:6868',
      distToken: '${TOKEN}', shareToken: 'gok_old_token_value_1111111111'
    }`)
    assert.equal(r.a.url, URL)
    assert.equal(r.a.token, TOKEN)
    assert.equal(r.b.apiUrl, URL)
    assert.equal(r.b.token, TOKEN)
  } finally {
    cleanup(root)
  }
})

test('地址尾部斜杠会去掉（二进制拼 URL 用），且空地址不炸', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const a = readBoth(root, `{ shareApiUrl: '${URL}/', distToken: '${TOKEN}' }`)
    assert.equal(a.a.url, URL)
    assert.equal(a.b.apiUrl, URL)

    const b = readBoth(root, `{ shareApiUrl: '', distUrl: '', distToken: '', shareToken: '' }`)
    assert.equal(b.a.url, '')
    assert.equal(b.a.token, '')
    assert.equal(b.b.apiUrl, '')
    assert.equal(b.b.token, '')
  } finally {
    cleanup(root)
  }
})
