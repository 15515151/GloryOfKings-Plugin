/**
 * 原生服务子进程的**生命周期管理**（P3-B）：spawn / kill / 探活 / pidfile / 日志。
 *
 * ## 为什么不保活
 *
 * 架构决定：服务跟着机器人进程走，不用 pm2。所以这里只做三件事：
 *   · 部署时把二进制起起来（`startService`）
 *   · 子进程自己退了就记日志（`child.on('exit')`），**不重拉**
 *   · 机器人退的时候顺手 SIGTERM 掉自己起过的（`process.on('exit')`）
 *
 * 「不重拉」是刻意的：二进制换不到租约会拒绝启动、令牌被吊销会 401/403 秒退
 * （契约 §2.3），无脑保活会把它变成重启风暴，日志刷满还看不出真因。
 *
 * ## 谁才算「我们的进程」
 *
 * 只认 pidfile 里那个 PID，而且**必须**在 `/proc/<pid>/cmdline` 上看到我们那个二进制的
 * 绝对路径。PID 会被系统复用，光比数字会误杀别人的进程 —— 这条规矩和以前
 * pm2 时代的 `isOurProcess`（cwd 或脚本必须落在本插件目录下）是同一个思路。
 *
 * ## 日志
 *
 * 子进程的 stdout/stderr **直接写文件**（`stdio: ['ignore', fd, fd]`），不走管道：
 *   · 不污染主进程的 stdout（云崽日志里不该混进服务端的心跳输出）
 *   · 不会因为没人读管道而背压卡住子进程
 *   · 机器人挂了也不影响写日志
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Config, PluginData, PluginName, PluginPath } from '#components'
import { binaryName, detectTarget } from './platform.js'
import { fmtUptime, probeStatus } from './deploy.js'
import { deviceGuid, NATIVE_STATE_FILE, fetchLatest, readDistConfig } from './dist.js'

/** 两个服务的固定信息。`kind` 同时是分发服务上的包名 */
const KINDS = {
  watch: {
    label: '观战',
    dirName: 'server',
    entry: 'watch-server.js',
    apiKey: 'watchApiUrl',
    apiDefault: 'http://127.0.0.1:8899',
    publicKey: 'watchPublicUrl',
    portEnv: 'GOK_WATCH_PORT',
    hostEnv: 'GOK_WATCH_HOST',
    defaultPort: 8899
  },
  im: {
    label: '营地消息',
    dirName: 'server-im',
    entry: 'camp-im-server.js',
    apiKey: 'campImApiUrl',
    apiDefault: 'http://127.0.0.1:8900',
    // 消息服务没有「对外地址」这一说（它是纯本机后端），留空 = 按 apiKey 判断
    publicKey: '',
    portEnv: 'GOK_IM_PORT',
    hostEnv: 'GOK_IM_HOST',
    defaultPort: 8900
  }
}

/** 运行期文件（pid / 日志）统一住这儿，被 .gitignore 的 `data/*` 挡住 */
const RUNTIME_DIR = path.join(PluginData, 'gok')

/** 单文件日志上限。超了轮转成 .1（只留一代，够排查「这次为什么起不来」） */
const LOG_MAX_BYTES = 1024 * 1024

/** SIGTERM 之后等它自己退多久，超了就 SIGKILL */
const STOP_GRACE_MS = 8000

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function kindInfo (kind) {
  const info = KINDS[kind]
  if (!info) throw new Error(`不认识的 kind：${kind}`)
  return info
}

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 服务端二进制装在哪 */
export function serverDir (kind) {
  return path.join(PluginPath, kindInfo(kind).dirName)
}

/**
 * 服务**实际监听（= 插件去连）**在哪个端口。
 *
 * ⚠️ 只看 `watchApiUrl` / `campImApiUrl`，**绝不**看「对外地址」。
 *
 * 这里踩过一次，记下来：对外地址是**链接前缀**（`https://域名/watch` 这种都合法），
 * 它可以是 443、可以带路径、可以是 Cloudflare 那种只转发固定端口的反代。
 * 拿它推监听口会出现：填 `https://域名:8443` → 二进制去听 8443，而插件探活
 * 127.0.0.1:8899 → **探不到自己刚起的服务**，报「进程起了但状态接口没通」。
 * 「对外怎么访问」和「本机听哪个口」是两件事，中间那层转发由反代/隧道负责。
 */
export function servicePort (kind) {
  const info = kindInfo(kind)
  const fromApi = extractPort(cfg()[info.apiKey] || info.apiDefault)
  return fromApi || info.defaultPort
}

/**
 * 从一个地址里抠端口。抠不到返回 0。
 *
 * ⚠️ 必须**去掉协议头再找冒号**：写成 `/^[^/]*:(\d+)/` 的话，`http://127.0.0.1:18899`
 *    的 `[^/]*` 会一路吃到最后一个 `:`，然后在端口后面要求 `/?#` 或结尾 ——
 *    `18899` 后面是结尾，能匹配上……但 `http://host:9000/path` 这种就会被
 *    `[^/]*` 停在 `/` 前面、找不到端口。实测第一次就写错、把 `18899` 吞成了默认 8899。
 *
 * 认这几种：`http://h:8899`、`https://h:442/x`、`h:8899`、`http://h:8899/`
 * 没写端口（`http://h`）→ 0，由调用方决定回落。
 */
function extractPort (raw) {
  let s = String(raw || '').trim()
  if (!s) return 0
  const sep = s.indexOf('://')
  if (sep >= 0) s = s.slice(sep + 3)
  const slash = s.search(/[/?#]/)
  if (slash >= 0) s = s.slice(0, slash)
  const m = s.match(/:(\d+)$/)
  return m ? Number(m[1]) : 0
}

/**
 * 二进制**绑哪个网卡** —— 由「对外地址」决定（契约里没有这一项，是本插件定的）。
 *
 * 为什么用 `watchPublicUrl` 而不是 `watchApiUrl`：
 *   · `watchApiUrl` 是「插件怎么去指挥服务」，永远是本机回环，跟对外无关；
 *   · `watchPublicUrl` 是「群友从哪能点到服务」，它填什么，服务就得绑成什么样。
 * 两者混用一个键，就会出现「填了外网地址，服务却只绑 127.0.0.1，群友照样白屏」。
 *
 * 规则（和老 JS 版行为对齐，主人已确认）：
 *   对外地址是**回环或没配** → 只绑本机（`127.0.0.1`）；这样公网碰不到它
 *   对外地址是**任何别的 host**（公网域名 / 内网 IP / 0.0.0.0）→ 不设 `GOK_WATCH_HOST`，
 *   让二进制用它自己的默认（`::` 双栈、全网卡）。⚠️ 这时服务**直接暴露在公网**，
 *   而它没有 TLS、也没有鉴权，主人要自己清楚这件事。
 *
 * @returns {{host: string, bindAll: boolean}} host 仅用于展示 / 探活
 */
export function bindRule (kind) {
  const info = kindInfo(kind)
  const c = cfg()
  const publicRaw = String(c[info.publicKey] || '').trim()

  let host = ''
  if (publicRaw) {
    const m = publicRaw.match(/^(?:https?:\/\/)?(\[[^\]]+\]|[^/:?#]+)/i)
    host = m ? m[1] : ''
  }

  // 没配对外地址时，按「插件调服务」的 host 判断（通常是回环 → 只绑本机）
  if (!host) {
    const apiRaw = String(c[info.apiKey] || info.apiDefault)
    const m = apiRaw.match(/^(?:https?:\/\/)?(\[[^\]]+\]|[^/:?#]+)/i)
    host = m ? m[1] : '127.0.0.1'
  }

  const loopback = LOOPBACK.has(host)
  return {
    host,
    // 回环 → 交给 buildEnv 显式绑 127.0.0.1；其余（含域名）→ 不覆盖，绑全网卡
    bindAll: !loopback
  }
}

/** 探活地址。服务在不在，**只认这个**：端口通才算活着，pm2 状态一概不看 */
export function probeUrl (kind) {
  return `http://127.0.0.1:${servicePort(kind)}/api/status`
}

export function pidFile (kind) {
  kindInfo(kind)
  return path.join(RUNTIME_DIR, `${kind}.pid`)
}

export function logFile (kind) {
  kindInfo(kind)
  return path.join(RUNTIME_DIR, `${kind}.log`)
}

/** 本机 target，取不到时返回 null（不抛 —— 状态展示路径上不该因为平台不支持就炸） */
function safeTarget () {
  try {
    return detectTarget()
  } catch {
    return null
  }
}

/** 二进制的绝对路径 */
export function binPath (kind, target) {
  const tgt = target || safeTarget()
  if (!tgt) return null
  return path.join(serverDir(kind), binaryName(kind, tgt))
}

/** 已装的版本信息（读台账）。没装过返回 null */
export function installedState (kind) {
  try {
    return JSON.parse(fs.readFileSync(path.join(serverDir(kind), NATIVE_STATE_FILE), 'utf8'))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ env */

/**
 * 给子进程的环境变量。**唯一**决定子进程 env 的地方，做成纯函数方便单测。
 *
 * ⚠️ 令牌只走这里，绝不拼进 argv（契约 §2.5 最后一条）。
 * ⚠️ `GOK_AUTH_POOL` 两个服务都显式传：观战的默认是 `<exe_dir>/../data/AuthPool.json`
 *    （落在插件 data 目录，正好），但**消息服务的默认是 `<cwd>/data/AuthPool.json`**
 *    （`gok-im/src/config.rs`），和观战不是一回事 —— 不传就会读到一个空的池子。
 *    显式传还让两个服务读**同一个文件**，和现有 JS 版一致，已登录的号不会「掉登录」。
 */
export function buildEnv ({ kind, target, baseUrl, token, port, bindHost, bindAll = false, cdnHttps = '' }) {
  const info = kindInfo(kind)
  const env = {
    ...process.env,
    // 心跳/租约全靠这两个，缺一个二进制会拒绝启动（契约 §2.5）
    GOK_BASE_URL: String(baseUrl || '').replace(/\/+$/, ''),
    GOK_TOKEN: String(token || ''),
    // 和 /key 用的是**同一个**设备号（同一份文件、同一个值）
    GOK_DEVICE_GUID: deviceGuid(),
    // 授权池固定指到插件 data 目录，别让二进制按 cwd 自己猜
    GOK_AUTH_POOL: path.join(PluginData, 'AuthPool.json'),
    [info.portEnv]: String(port)
  }

  // gok-watch 会校验此值是否为纯 HTTPS origin；空串显式关闭，避免继承旧进程环境。
  if (kind === 'watch') env.GOK_WATCH_CDN_HTTPS = String(cdnHttps || '').trim()

  // 观战二进制默认绑 `::`（双栈）且**没有回退**：IPv6 被禁的机器上它会直接起不来。
  //
  // ⚠️ `bindAll` 时**故意不设** GOK_*_HOST，让二进制用它自己的 `::` 默认（全网卡）——
  //    这是「对外地址填了公网域名/网卡 IP 就该让外网连得上」的落地方式。
  //    回环时显式设 127.0.0.1：既避开 IPv6 缺失的机器上绑 :: 失败，也多一层「只能本机碰」的保护。
  if (!bindAll && LOOPBACK.has(String(bindHost || ''))) {
    env[info.hostEnv] = '127.0.0.1'
  }

  return env
}

/** 按当前配置拼一份 env */
export function currentEnv (kind) {
  const { url, token } = readDistConfig()
  const rule = bindRule(kind)
  return buildEnv({
    kind,
    target: safeTarget(),
    baseUrl: url,
    token,
    port: servicePort(kind),
    bindHost: rule.host,
    bindAll: rule.bindAll,
    cdnHttps: kind === 'watch' ? cfg().watchCdnHttps : ''
  })
}

/**
 * 给部署回执 / 状态回复用的**绑定事实**：这个服务实际绑在哪。
 *
 * ⚠️ 这里刻意**只给事实、不给建议**：观战是「要不要对外」的问题，消息服务则是
 *    **本来就不该对外**（它是纯本机后端，插件定时轮询它）。建议文案由各自的
 *    Deploy 文件补，免得对 IM 说出「外网要访问得走本机反代」这种误导话。
 */
export function bindSummary (kind) {
  const rule = bindRule(kind)
  const port = servicePort(kind)
  return rule.bindAll
    ? `${port}（全网卡，外网可直连 —— 服务没有 TLS 和鉴权）`
    : `${port}（只监听 127.0.0.1，外网访问不到）`
}

/* ------------------------------------------------------------ pidfile */

function readPidFile (kind) {
  try {
    const data = JSON.parse(fs.readFileSync(pidFile(kind), 'utf8'))
    return Number(data?.pid) > 0 ? data : null
  } catch {
    return null
  }
}

function writePidFile (kind, data) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(pidFile(kind), JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    logger?.warn?.(`[${PluginName}] 写 pid 文件失败（不影响服务）：${error?.message || error}`)
  }
}

function removePidFile (kind) {
  try {
    fs.rmSync(pidFile(kind), { force: true })
  } catch {}
}

/** 这个 PID 还在不在。EPERM = 活着但不归我们管（那也算在） */
function alive (pid) {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 这个 PID 是不是**我们那个二进制**。
 *
 * 只看 PID 数字不够：PID 会被复用，误判的后果是把别人的进程 SIGTERM 掉。
 * Linux 上直接比 `/proc/<pid>/cmdline` 的第一个参数（最硬的证据）；
 * Windows 上退化成 tasklist 的映像名比对。
 */
/** 两个路径是不是指向同一个文件（fail 时退化成字符串相等） */
function sameFile (a, b) {
  if (!a || !b) return false
  if (a === b) return true
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  } catch {
    return false
  }
}

export function isOurProcess (pid, bin) {
  if (!alive(pid) || !bin) return false

  if (process.platform === 'linux') {
    try {
      const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (!parts.length) return false

      // 编译出来的二进制：cmdline[0] 就是它自己的路径
      if (sameFile(parts[0], bin)) return true

      // 带 shebang 的脚本（测试里的假二进制、将来万一有人塞脚本）：内核把
      // cmdline[0] 记成解释器（`#!/usr/bin/env node` → `node`），真实路径跑到
      // 后面几个参数里去了。所以再扫一遍参数，认**解析后同一个文件**的才算。
      for (let i = 1; i < parts.length; i++) {
        if (sameFile(parts[i], bin)) return true
      }
      return false
    } catch {
      return false
    }
  }

  if (process.platform === 'win32') {
    try {
      const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      })
      return String(r.stdout || '').toLowerCase().includes(path.basename(bin).toLowerCase())
    } catch {
      return false
    }
  }

  // 其他 POSIX（macOS 之类，本来也不支持产物，但别让它误杀）：认命，只认 PID 存在
  return true
}

/** 收掉上次残留的、确实是我们起的进程。返回是否收掉了 */
export function killStale (kind, bin, logger) {
  const rec = readPidFile(kind)
  if (!rec) return false

  if (!isOurProcess(rec.pid, bin)) {
    // 进程早没了，或者 PID 被复用了 → 只清记录，绝不杀
    removePidFile(kind)
    return false
  }

  logger?.warn?.(`[${PluginName}] 发现上次残留的 ${kindInfo(kind).label}进程（PID ${rec.pid}），先收掉`)
  try {
    process.kill(rec.pid, 'SIGTERM')
  } catch {}
  removePidFile(kind)
  return true
}

/* ------------------------------------------------------------ 日志 */

/** 超过上限就轮转成 .1。子进程还开着这个 fd 时 rename 会失败（Windows），失败只忽略 */
export function rotateIfBig (kind) {
  const file = logFile(kind)
  try {
    if (fs.statSync(file).size < LOG_MAX_BYTES) return
    fs.rmSync(file + '.1', { force: true })
    fs.renameSync(file, file + '.1')
  } catch {
    // 文件不在 / 被占用，都无所谓
  }
}

/** 读日志最后 n 行（`#营地观战服务` 在端口不通时贴出来） */
export function readLogTail (kind, n = 15) {
  try {
    const lines = fs.readFileSync(logFile(kind), 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-n)
  } catch {
    return []
  }
}

function appendLog (kind, line) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.appendFileSync(logFile(kind), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {}
}

/* ------------------------------------------------------------ 子进程表 */

/** 本进程起过 / 认领过的子进程（机器人退出时要把它们带走） */
const children = new Map()

/** 模块顶层只挂一次。Yunzai 每条消息都会 new 一次插件类，靠这个标志去重 */
let exitHookInstalled = false
function installExitHook () {
  if (exitHookInstalled) return
  exitHookInstalled = true

  process.on('exit', () => {
    // exit 回调里只能做同步操作，所以直接读 pidfile + SIGTERM
    for (const kind of children.keys()) {
      const rec = readPidFile(kind)
      if (rec && isOurProcess(rec.pid, rec.bin)) {
        try {
          process.kill(rec.pid, 'SIGTERM')
        } catch {}
      }
    }
  })
}

/* ------------------------------------------------------------ 启动 / 停止 */

/**
 * 起一个服务子进程。
 *
 * ⚠️ 调用方应先确认旧进程已停：同一个端口上留着旧进程的话新的会绑不上。
 *    `startService` 内部会先 `killStale`（只收我们自己那个二进制）。
 *
 * @returns {{ok: boolean, pid?: number, message?: string}}
 */
export function startService (kind, { logger } = {}) {
  const info = kindInfo(kind)
  const tgt = safeTarget()
  if (!tgt) return { ok: false, message: '这台机器的平台没有原生版本，装不了服务' }

  const bin = binPath(kind, tgt)
  if (!fs.existsSync(bin)) {
    return { ok: false, message: `还没装好服务端（缺 ${path.relative(PluginPath, bin)}），先发一次部署` }
  }

  // 上次残留的先收掉，否则端口撞车（只收我们自己那个二进制）
  killStale(kind, bin, logger)

  rotateIfBig(kind)
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })

  let fd
  try {
    fd = fs.openSync(logFile(kind), 'a')
  } catch (error) {
    return { ok: false, message: `打不开日志文件：${error?.message || error}` }
  }

  const port = servicePort(kind)
  appendLog(kind, `==== 启动 ${path.basename(bin)}（端口 ${port}）====`)

  let child
  try {
    child = spawn(bin, [], {
      cwd: serverDir(kind),
      env: currentEnv(kind),
      // 直接写文件：不占管道、不污染主进程 stdout
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      detached: false
    })
  } catch (error) {
    try { fs.closeSync(fd) } catch {}
    return { ok: false, message: `起不来：${error?.message || error}` }
  } finally {
    // 父进程这一份 fd 用完就关（子进程已经 dup 走了）
    try { fs.closeSync(fd) } catch {}
  }

  children.set(kind, child)
  installExitHook()

  writePidFile(kind, {
    pid: child.pid,
    bin,
    startedAt: new Date().toISOString(),
    port
  })

  child.on('error', error => {
    children.delete(kind)
    appendLog(kind, `启动失败：${error?.message || error}`)
    logger?.error?.(`[${PluginName}] ${info.label}服务启动失败：${error?.message || error}`)
  })

  child.on('exit', (code, signal) => {
    children.delete(kind)
    // 退出码写日志（契约 §7 的要求），但**不重拉**：见文件头「为什么不保活」
    appendLog(kind, `==== 进程退出：code=${code ?? '—'} signal=${signal || '—'} ====`)
    logger?.debug?.(`[${PluginName}] ${info.label}服务退出：code=${code ?? '—'} signal=${signal || '—'}`)
  })

  return { ok: true, pid: child.pid }
}

/** 等一个 PID 真的消失（最多 timeoutMs） */
async function waitGone (pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return !alive(pid)
}

/**
 * 停掉服务。**只停** pidfile 里、且确认是我们那个二进制的进程。
 *
 * @returns {Promise<{ok: boolean, stopped?: boolean, message?: string}>}
 */
export async function stopService (kind, { timeoutMs = STOP_GRACE_MS, logger } = {}) {
  const info = kindInfo(kind)
  const rec = readPidFile(kind)
  if (!rec) return { ok: true, stopped: false }

  const child = children.get(kind)

  if (child && typeof child.once === 'function' && child.exitCode === null && !child.killed) {
    // 本进程起的：等 'exit' 事件，比轮询准
    const gone = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve(!alive(rec.pid))
      }
    })
    if (gone) {
      removePidFile(kind)
      return { ok: true, stopped: true }
    }
  } else if (isOurProcess(rec.pid, rec.bin)) {
    // 认领来的（上次机器人退时留下的）：先 SIGTERM，等不到再 SIGKILL
    try {
      process.kill(rec.pid, 'SIGTERM')
    } catch {}
    if (await waitGone(rec.pid, timeoutMs)) {
      removePidFile(kind)
      return { ok: true, stopped: true }
    }
  } else {
    // 进程早没了：清记录就行
    removePidFile(kind)
    children.delete(kind)
    return { ok: true, stopped: false }
  }

  // 宽限期过了还不退 → 强杀（只对我们确认过的那个 PID）
  if (isOurProcess(rec.pid, rec.bin)) {
    logger?.warn?.(`[${PluginName}] ${info.label}服务 ${timeoutMs}ms 没退，强制结束 PID ${rec.pid}`)
    try {
      process.kill(rec.pid, 'SIGKILL')
    } catch {}
    await waitGone(rec.pid, 3000)
  }
  children.delete(kind)
  removePidFile(kind)
  return { ok: true, stopped: true }
}

/* ------------------------------------------------------------ 状态 / 探活 */

/**
 * 服务的完整状态。
 *
 * 「活着」的判据**只有端口探活**，但同时分开报「进程在不在」：
 *   · 进程在、端口不通 → 正在换租约 / 崩了一半（要看日志）
 *   · 进程不在、端口通 → 上次残留的进程还占着端口，或者 pm2 时代的老服务还在跑
 * 这两种情况主人的处理方式完全不同，混成一个「运行中」只会误导人。
 */
export async function serviceStatus (kind) {
  const info = kindInfo(kind)
  const tgt = safeTarget()
  const bin = binPath(kind, tgt)
  const rec = readPidFile(kind)
  const child = children.get(kind)

  const installed = Boolean(bin && fs.existsSync(bin))
  const legacyJs = fs.existsSync(path.join(serverDir(kind), info.entry))

  let running = false
  let pid = null
  if (child && typeof child.once === 'function' && child.exitCode === null && !child.killed) {
    running = true
    pid = child.pid
  } else if (rec && isOurProcess(rec.pid, rec.bin)) {
    running = true
    pid = rec.pid
  }

  const status = await probeStatus(servicePort(kind))
  const st = installedState(kind)

  return {
    kind,
    label: info.label,
    installed,
    legacyJs,
    running,
    pid,
    alive: Boolean(status),
    status,
    port: servicePort(kind),
    binary: bin,
    version: st?.sha || null,
    target: st?.target || tgt,
    installedAt: st?.installedAt || null,
    startedAt: rec?.startedAt || null,
    uptimeMs: rec?.startedAt ? Date.now() - Date.parse(rec.startedAt) : 0,
    logTail: readLogTail(kind)
  }
}

/**
 * 开机自动接管：**只拉起已经装好、而且上次确实起过的**那个服务。
 *
 * 按已确认的决策，它**不下载、不查版本**：
 *   · 没装 → 静默返回（部署是主人的显式动作）
 *   · 装过但从没起过（没有 pidfile）→ 也不动它，留给主人的部署指令
 *   · pidfile 里的进程还在 → 认领它
 *   · pidfile 里的进程没了、二进制还在 → 起一个
 *
 * @returns {Promise<{ok: boolean, reason: string, adopted?: boolean, pid?: number, message?: string}>}
 */
export async function ensureService (kind, { logger } = {}) {
  const tgt = safeTarget()
  if (!tgt) return { ok: false, reason: 'unsupported-platform' }

  const bin = binPath(kind, tgt)
  if (!fs.existsSync(bin)) return { ok: false, reason: 'not-installed' }

  const rec = readPidFile(kind)
  if (!rec) return { ok: false, reason: 'never-started' }

  if (isOurProcess(rec.pid, bin)) {
    // 认领一个我们没亲手 spawn 的进程：只登记状态，退出时不替它做决定，
    // 也不清 pidfile（服务是死是活由状态指令去说）
    children.set(kind, { pid: rec.pid, adopted: true, exitCode: null, killed: false, once: null, kill: null })
    installExitHook()

    const status = await probeStatus(servicePort(kind))
    if (!status) {
      logger?.warn?.(
        `[${PluginName}] ${kindInfo(kind).label}服务在跑（PID ${rec.pid}）但状态接口不通，` +
        `发 #营地${kind === 'watch' ? '观战' : '消息'}服务 看日志`
      )
    }
    return { ok: true, reason: 'adopted', adopted: true, pid: rec.pid }
  }

  // 上次的进程没了 → 重新起。只起已装的二进制，绝不下载
  killStale(kind, bin, logger)
  const started = startService(kind, { logger })
  if (!started.ok) return { ok: false, reason: 'start-failed', message: started.message }
  return { ok: true, reason: 'restarted', pid: started.pid }
}

/**
 * 给状态 / 部署指令用：问一次 `/latest`，看有没有新版。**只查，不下载**。
 * 自动更新是刻意不做的（会在运行期重启别人正在看的直播），要更新得主人点一下。
 */
export async function checkUpdate (kind) {
  const tgt = safeTarget()
  if (!tgt) return { ok: false, message: '这台机器的平台没有原生版本' }

  const { url, token } = readDistConfig()
  if (!url || !token) return { ok: false, message: '还没接入分发服务' }

  const latest = await fetchLatest(kind, tgt, { url, token })
  if (!latest.ok) return latest

  const st = installedState(kind)
  return {
    ok: true,
    sha: latest.sha,
    current: st?.sha || null,
    hasNew: Boolean(st?.sha && st.sha !== latest.sha)
  }
}

export { fmtUptime }

