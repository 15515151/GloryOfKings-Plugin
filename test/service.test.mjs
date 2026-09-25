/**
 * 子进程管理的单测：env 拼装、真正 spawn / 优雅收工、pidfile、日志。
 *
 * spawn 的用例跑的是**真正的子进程**（一个假的 `gok-watch` 脚本），
 * 所以能验到真东西：进程真的起来、SIGTERM 收得掉、日志写得进去。
 * 用 18899 / 18900 这种非默认端口，不会撞到真服务。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cleanup, ensurePluginRoot, makeSandbox, run } from './helpers/sandbox.mjs'

/**
 * 一个假的二进制。
 *
 * ⚠️ 用 node 而不是 shell 脚本：这套假二进制要「起得来、收得掉、跑 --version 有输出」，
 * 写成 shell 得和 SIGTERM/trap/wait 的语义缠在一起，实测很容易变成「进程秒退」，
 * 于是测试失败在莫名其妙的地方。Node 的语义是确定的。
 */
function fakeBinSource (kind = 'watch') {
  return [
    '#!/usr/bin/env node',
    `if (process.argv[2] === '--version') { console.log('gok-${kind} 0.2.0 (x86_64-unknown-linux-gnu)'); process.exit(0) }`,
    'process.on("SIGTERM", () => process.exit(0))',
    'setInterval(() => {}, 1000)',
    ''
  ].join('\n')
}

function writeFakeBin (root, kind = 'watch') {
  const dirName = kind === 'watch' ? 'server' : 'server-im'
  const fileName = kind === 'watch' ? 'gok-watch' : 'gok-im'
  const dir = path.join(root, 'PluginRoot', dirName)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, fileName)
  fs.writeFileSync(file, fakeBinSource(kind), { mode: 0o755 })
  return file
}

/* ------------------------------------------------------------ env */

test('buildEnv：必传的 GOK_* 一个不少，且令牌只出现在 env 里', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { buildEnv, currentEnv } = await import('./utils/service.js')
const { PluginData } = await import('#components')

const env = buildEnv({
  kind: 'watch', target: 'x86_64-unknown-linux-gnu',
  baseUrl: 'https://gok.example.com:442/', token: 'gok_secret_token_value',
  port: 18899, bindHost: '127.0.0.1'
})
const envIm = currentEnv('im')
const out = {
  baseUrl: env.GOK_BASE_URL,
  token: env.GOK_TOKEN,
  device: env.GOK_DEVICE_GUID,
  authPool: env.GOK_AUTH_POOL,
  port: env.GOK_WATCH_PORT,
  host: env.GOK_WATCH_HOST,
  imPort: envIm.GOK_IM_PORT,
  imHost: envIm.GOK_IM_HOST,
  expectedAuthPool: PluginData + '/AuthPool.json',
  tokenLeaks: Object.entries(env).filter(([k, v]) => k !== 'GOK_TOKEN' && String(v).includes('gok_secret_token_value')).map(([k]) => k)
}
console.log(JSON.stringify(out))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    // 尾部斜杠要去掉（二进制那边自己拼 URL）
    assert.equal(r.baseUrl, 'https://gok.example.com:442')
    assert.equal(r.token, 'gok_secret_token_value')
    assert.match(r.device, /^[0-9a-f]{32}$/)
    assert.equal(r.authPool, r.expectedAuthPool)
    assert.equal(r.port, '18899')
    // 配置里是回环地址 → 替它补 127.0.0.1（二进制默认绑 :: 双栈，IPv6 被禁的机器起不来）
    assert.equal(r.host, '127.0.0.1')
    assert.equal(r.imPort, '18900')
    assert.equal(r.imHost, '127.0.0.1')
    // 令牌绝不能渗到别的变量里（尤其 GOK_AUTH_POOL 这种看着像路径的）
    assert.deepEqual(r.tokenLeaks, [])
  } finally {
    cleanup(root)
  }
})

test('buildEnv：配置里写了非回环地址时不覆盖（说明有反代直连需求）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { currentEnv } = await import('./utils/service.js')
setFakeConfig({ watchApiUrl: 'http://192.168.1.5:18899' })
const env = currentEnv('watch')
console.log(JSON.stringify({ host: env.GOK_WATCH_HOST, port: env.GOK_WATCH_PORT }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    // 不设 GOK_WATCH_HOST 就是让二进制用它自己的默认（::，双栈），和现有 JS 版行为一致
    assert.equal(r.host, undefined)
    assert.equal(r.port, '18899')
  } finally {
    cleanup(root)
  }
})

test('currentEnv：观战 CDN 配置传给二进制，清空后关闭', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { currentEnv } = await import('./utils/service.js')
process.env.GOK_WATCH_CDN_HTTPS = 'https://stale.example.org'
setFakeConfig({ watchCdnHttps: ' https://cdn.example.org/ ' })
const configured = currentEnv('watch').GOK_WATCH_CDN_HTTPS
setFakeConfig({ watchCdnHttps: '' })
const cleared = currentEnv('watch').GOK_WATCH_CDN_HTTPS
console.log(JSON.stringify({ configured, cleared }))
`)
    assert.ok(out.ok, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout), {
      configured: 'https://cdn.example.org/',
      cleared: ''
    })
  } finally {
    cleanup(root)
  }
})

test('servicePort：从配置的服务地址抠端口，抠不到用默认', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { servicePort, probeUrl } = await import('./utils/service.js')
const { setFakeConfig } = await import('./fake-config.mjs')
const a = { watch: servicePort('watch'), im: servicePort('im'), url: probeUrl('watch') }
setFakeConfig({ watchApiUrl: '', campImApiUrl: 'http://127.0.0.1:9999' })
const b = { watch: servicePort('watch'), im: servicePort('im') }
console.log(JSON.stringify({ a, b }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.a.watch, 18899)
    assert.equal(r.a.im, 18900)
    assert.equal(r.a.url, 'http://127.0.0.1:18899/api/status')
    assert.equal(r.b.watch, 8899)
    assert.equal(r.b.im, 9999)
  } finally {
    cleanup(root)
  }
})

/* ------------------------------------------------------------ 绑定规则 */

test('绑定规则：对外地址留空 → 只绑 127.0.0.1（公网碰不到）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { currentEnv, bindRule, bindSummary, servicePort } = await import('./utils/service.js')

setFakeConfig({ watchPublicUrl: '' })
const rule = bindRule('watch')
const env = currentEnv('watch')
console.log(JSON.stringify({
  rule, host: env.GOK_WATCH_HOST, port: env.GOK_WATCH_PORT,
  servicePort: servicePort('watch'), summary: bindSummary('watch')
}))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.rule.bindAll, false)
    assert.equal(r.host, '127.0.0.1')
    assert.equal(r.port, '18899')
    assert.match(r.summary, /只监听 127\.0\.0\.1/)
  } finally {
    cleanup(root)
  }
})

test('绑定规则：对外地址填公网域名 → 绑全网卡，但监听端口仍看 watchApiUrl', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { currentEnv, bindRule, bindSummary, servicePort } = await import('./utils/service.js')

setFakeConfig({ watchPublicUrl: 'https://gok.example.com:8443' })
const rule = bindRule('watch')
const env = currentEnv('watch')
console.log(JSON.stringify({
  rule, host: env.GOK_WATCH_HOST, port: env.GOK_WATCH_PORT,
  servicePort: servicePort('watch'), summary: bindSummary('watch')
}))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.rule.bindAll, true)
    assert.equal(r.rule.host, 'gok.example.com')
    // 不设 GOK_WATCH_HOST = 二进制用自己的 :: 双栈默认（全网卡）
    assert.equal(r.host, undefined)
    // ⭐ 对外是 8443（反代/隧道口），本机监听必须还是 watchApiUrl 的 18899 ——
    //    否则插件会去探一个没人听的口，报「进程起了但状态接口没通」
    assert.equal(r.port, '18899', '监听端口被对外地址带偏了')
    assert.equal(r.servicePort, 18899)
    assert.match(r.summary, /全网卡/)
  } finally {
    cleanup(root)
  }
})

test('绑定规则：对外地址填内网 IP → 也绑全网卡（直连场景）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { currentEnv, bindRule } = await import('./utils/service.js')
setFakeConfig({ watchPublicUrl: 'http://192.168.1.5:8899' })
const rule = bindRule('watch')
console.log(JSON.stringify({ bindAll: rule.bindAll, host: currentEnv('watch').GOK_WATCH_HOST }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.bindAll, true)
    assert.equal(r.host, undefined)
  } finally {
    cleanup(root)
  }
})

test('绑定规则：对外地址写回环 → 只绑本机（不管端口是多少）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { currentEnv, bindRule } = await import('./utils/service.js')
setFakeConfig({ watchPublicUrl: 'http://127.0.0.1:9001' })
const rule = bindRule('watch')
console.log(JSON.stringify({ bindAll: rule.bindAll, host: currentEnv('watch').GOK_WATCH_HOST, port: currentEnv('watch').GOK_WATCH_PORT }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.bindAll, false)
    assert.equal(r.host, '127.0.0.1')
    // 对外写的是 9001 也是回环，但监听口仍由 watchApiUrl 决定（18899）
    assert.equal(r.port, '18899')
  } finally {
    cleanup(root)
  }
})

test('绑定规则：IPv6 形式的回环（[::1]）也要判成只绑本机', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { bindRule } = await import('./utils/service.js')
setFakeConfig({ watchPublicUrl: 'http://[::1]:8899' })
console.log(JSON.stringify(bindRule('watch')))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.host, '[::1]', 'host 解析错了（IPv6 带方括号）')
    assert.equal(r.bindAll, false, 'IPv6 回环被误判成要绑全网卡')
  } finally {
    cleanup(root)
  }
})

test('绑定规则：没写协议的对外地址也要认出 host；消息服务永远只绑本机', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { setFakeConfig } = await import('./fake-config.mjs')
const { currentEnv, bindRule, servicePort } = await import('./utils/service.js')
setFakeConfig({ watchPublicUrl: 'gok.example.com' })
const watchRule = bindRule('watch')
// 消息服务没有对外地址这一说（publicKey 为空），host 按 campImApiUrl 判断
const imRule = bindRule('im')
console.log(JSON.stringify({
  watchHost: watchRule.host, watchBindAll: watchRule.bindAll, watchPort: servicePort('watch'),
  imHost: imRule.host, imBindAll: imRule.bindAll, imEnvHost: currentEnv('im').GOK_IM_HOST
}))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.watchHost, 'gok.example.com')
    assert.equal(r.watchBindAll, true)
    assert.equal(r.watchPort, 18899)
    assert.equal(r.imBindAll, false)
    assert.equal(r.imHost, '127.0.0.1')
    assert.equal(r.imEnvHost, '127.0.0.1')
  } finally {
    cleanup(root)
  }
})

/* ------------------------------------------------------------ spawn / stop */

test('startService + stopService：真起一个子进程、写 pidfile/日志、SIGTERM 收得掉', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    writeFakeBin(root, 'watch')

    const out = run(root, `
const fs = await import('node:fs')
const { startService, stopService, readLogTail, pidFile, logFile, isOurProcess, binPath } = await import('./utils/service.js')

const started = startService('watch')
if (!started.ok) throw new Error('起不来：' + started.message)

const pid = started.pid
const pf = pidFile('watch')
const rec = JSON.parse(fs.readFileSync(pf, 'utf8'))
const bin = binPath('watch', undefined)

// ⚠️ 要轮询、不能拍快照：spawn 返回时子进程可能还在 exec，
//    /proc/<pid>/cmdline 这一瞬间看到的还是 shell/node 的中间态（实测偶发）
let running = false
const deadline = Date.now() + 4000
while (Date.now() < deadline) {
  if (isOurProcess(pid, bin)) { running = true; break }
  await new Promise(r => setTimeout(r, 100))
}
const logExists = fs.existsSync(logFile('watch'))
const logTailBefore = readLogTail('watch', 5)

const stopped = await stopService('watch')
await new Promise(r => setTimeout(r, 400))
const aliveAfter = (() => { try { process.kill(pid, 0); return true } catch { return false } })()

console.log(JSON.stringify({
  pid, bin,
  startedPid: typeof pid === 'number' && pid > 0,
  recMatches: rec.pid === pid && rec.port === 18899 && rec.bin === bin,
  running, logExists, logTailBefore,
  stopped, aliveAfter,
  pidFileGone: !fs.existsSync(pf)
}))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.startedPid, true, 'pid 不正常：' + out.stdout)
    assert.equal(r.recMatches, true, 'pidfile 内容不对：' + out.stdout)
    assert.equal(r.running, true, 'isOurProcess 没认出自己的进程：' + out.stdout)
    assert.equal(r.logExists, true)
    assert.equal(r.stopped.ok, true)
    assert.equal(r.stopped.stopped, true)
    assert.equal(r.aliveAfter, false, 'SIGTERM 之后进程还在')
    assert.equal(r.pidFileGone, true)
    assert.ok(r.logTailBefore.some(l => l.includes('启动')), '日志里没有启动那行：' + JSON.stringify(r.logTailBefore))
  } finally {
    cleanup(root)
  }
})

test('startService：二进制没装时给一句能照做的话，不抛', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { startService } = await import('./utils/service.js')
console.log(JSON.stringify(startService('watch')))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.ok, false)
    assert.match(r.message, /还没装好服务端/)
    assert.match(r.message, /先发一次部署/)
  } finally {
    cleanup(root)
  }
})

test('stopService：没有 pidfile 时是安全的空操作', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { stopService } = await import('./utils/service.js')
console.log(JSON.stringify(await stopService('watch')))
`)
    assert.ok(out.ok, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout), { ok: true, stopped: false })
  } finally {
    cleanup(root)
  }
})

test('ensureService：没装 → not-installed；装过没起过 → never-started（都不下载、不起进程）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const fs = await import('node:fs')
const { ensureService, pidFile } = await import('./utils/service.js')
const { PluginPath } = await import('#components')
const a = await ensureService('watch')
// 装上二进制、但没有 pidfile = 从没起过
fs.mkdirSync(PluginPath + '/server', { recursive: true })
fs.writeFileSync(PluginPath + '/server/gok-watch', '#!/bin/sh\\nexit 0\\n', { mode: 0o755 })
const b = await ensureService('watch')
console.log(JSON.stringify({ a, b, pidExists: fs.existsSync(pidFile('watch')) }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.a.ok, false)
    assert.equal(r.a.reason, 'not-installed')
    assert.equal(r.b.ok, false)
    assert.equal(r.b.reason, 'never-started')
    // 关键：自动接管**绝不**自己起一个新服务
    assert.equal(r.pidExists, false)
  } finally {
    cleanup(root)
  }
})

test('ensureService：pidfile 里的进程好好地跑着 → 认领它，不新起', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    writeFakeBin(root, 'watch')

    const out = run(root, `
const fs = await import('node:fs')
const { spawn } = await import('node:child_process')
const { ensureService, pidFile, binPath } = await import('./utils/service.js')

// 手动起一个（模拟「上次机器人退时留下的、pidfile 还在」）
// ⚠️ unref + 自己记着 pid：沙箱脚本退出后不能被它拖着不结束
const bin = binPath('watch', undefined)
const proc = spawn(bin, [], { detached: true, stdio: 'ignore' })
proc.unref()
fs.writeFileSync(pidFile('watch'), JSON.stringify({ pid: proc.pid, bin, startedAt: new Date().toISOString(), port: 18899 }))

await new Promise(r => setTimeout(r, 900))
const r = await ensureService('watch')
try { process.kill(proc.pid, 'SIGTERM') } catch {}
await new Promise(res => setTimeout(res, 400))
let aliveAfter = false
try { process.kill(proc.pid, 0); aliveAfter = true } catch {}
console.log(JSON.stringify({ r, samePid: r.pid === proc.pid, aliveAfter }))
// ⚠️ 必须显式退出：那个 detached 的子进程会一直拖住事件循环
process.exit(0)
`, { timeoutMs: 20000 })
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.r.ok, true, out.stdout)
    assert.equal(r.r.reason, 'adopted')
    assert.equal(r.r.adopted, true)
    assert.equal(r.samePid, true)
    assert.equal(r.aliveAfter, false, '收尾没杀掉假进程，会留残留')
  } finally {
    cleanup(root)
  }
})

test('serviceStatus：没装 / 装没起，报得清楚', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const { serviceStatus } = await import('./utils/service.js')
const a = await serviceStatus('watch')
console.log(JSON.stringify({ installed: a.installed, running: a.running, alive: a.alive, legacyJs: a.legacyJs, port: a.port, target: a.target }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.installed, false)
    assert.equal(r.running, false)
    assert.equal(r.alive, false)
    assert.equal(r.legacyJs, false)
    assert.equal(r.port, 18899)
    assert.equal(r.target, 'x86_64-unknown-linux-gnu')
  } finally {
    cleanup(root)
  }
})

test('serviceStatus：认出老 JS 布局（server/watch-server.js），但不启动它', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
const fs = await import('node:fs')
const { serviceStatus, serverDir } = await import('./utils/service.js')
fs.mkdirSync(serverDir('watch'), { recursive: true })
fs.writeFileSync(serverDir('watch') + '/watch-server.js', '// 老 JS 服务')
const st = await serviceStatus('watch')
console.log(JSON.stringify({ legacyJs: st.legacyJs, installed: st.installed, running: st.running }))
`)
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.legacyJs, true)
    assert.equal(r.installed, false)
    assert.equal(r.running, false)
  } finally {
    cleanup(root)
  }
})

test('部署指令的 REG 不会误吃同名指令（#营地消息重装 vs #营地消息同步）', () => {
  const root = makeSandbox()
  try {
    ensurePluginRoot(root)
    const out = run(root, `
// 和 apps/campImDeploy.js 里的正则逐字一致
const deploy = /^#营地消息部署$/
const reinstall = /^#营地消息重装$/
const sync = /^#营地消息同步$/
const watchDeploy = /^#营地观战部署$/
const watchReinstall = /^#营地观战重装$/
const cases = ['#营地消息部署', '#营地消息重装', '#营地消息同步', '#营地消息重连', '#营地消息', '#营地观战重装']
console.log(JSON.stringify(cases.map(c => ({
  c,
  deploy: deploy.test(c),
  reinstall: reinstall.test(c),
  sync: sync.test(c),
  watchDeploy: watchDeploy.test(c),
  watchReinstall: watchReinstall.test(c)
}))))
`)
    assert.ok(out.ok, out.stderr)
    const rows = JSON.parse(out.stdout)
    const by = Object.fromEntries(rows.map(r => [r.c, r]))
    assert.equal(by['#营地消息部署'].deploy, true)
    assert.equal(by['#营地消息重装'].reinstall, true)
    assert.equal(by['#营地消息同步'].sync, true)
    // 几条互不串味
    assert.equal(by['#营地消息重装'].deploy, false)
    assert.equal(by['#营地消息部署'].reinstall, false)
    assert.equal(by['#营地消息'].deploy, false)
    assert.equal(by['#营地消息'].reinstall, false)
    assert.equal(by['#营地消息'].sync, false)
    // 观战那条只能被观战的正则吃
    assert.equal(by['#营地观战重装'].watchReinstall, true)
    assert.equal(by['#营地观战重装'].reinstall, false)
    assert.equal(by['#营地观战重装'].watchDeploy, false)
  } finally {
    cleanup(root)
  }
})
