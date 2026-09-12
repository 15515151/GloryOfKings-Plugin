/**
 * 营地ID共享库的**服务端运维**：#部署 / #状态 / #卸载。
 *
 * 和 apps/shareBind.js 的分工：那边管「本机要不要接某个库」（客户端配置），
 * 这边管「本机自己搭的那个库跑没跑」（服务端进程）。
 *
 * ## 服务端代码从哪来
 *
 * 服务端已经分离到仓库的 `server` 分支，插件目录里不再自带。部署时从 origin 把
 * 那个分支浅克隆到 `<云崽根>/data/gok-share-server/`，再用 pm2 拉起 —— 服务端连同
 * 它的密钥、数据库都住在插件目录**外面**，更新、重装插件都不会碰它们。
 *
 * ## 为什么是 QQ 指令而不是命令行脚本
 *
 * 插件本来就跑在云崽里，而部署要做的每件事（拉代码、生成密钥、写文件、起进程、
 * 签发令牌）都能用 Node API 完成 —— 一份代码 Windows 和 Linux 通用，不用像 meme 那样
 * 再配一份 PowerShell 脚本和一套按平台分派的解析逻辑。
 *
 * ## 三条硬规矩
 *
 * 1. **令牌只在私聊里出现**。群里执行的话结果一律走私聊，群里只回一句「已私聊」。
 * 2. **卸载只认自己起的那个进程**：cwd 或入口脚本必须落在 server 目录下。
 *    光比进程名会把别人的东西停掉（这条教训是从 meme 的卸载逻辑带过来的）。
 * 3. **盐要复用，卸载也不删**。换了盐，数据库里所有 QQ 的哈希当场变成无意义的
 *    字符串 —— 查询永远 404，等于所有人的共享记录一起作废。所以重新部署时
 *    盐是复用不是重造；卸载只清代码，`.env` 和 `data/` 原地保留，
 *    重新部署接着用原来的数据。要彻底清就两样一起手动删，不能只删一半。
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { spawnSync } from 'node:child_process'
import { PluginPath, PluginName } from '#components'
import {
  shouldQuote, readShareConfig, readUserData, reconcileNow, isShareReady, pushBind,
  getShareStatus, querySharedBind, maskToken, AT_HEAD,
  stripAtText, pickAtText, resolveTargetUserId, resolveMemberName
} from '#utils'
import { pm2, pm2Proc, pm2Bin, resetPm2Cache, isOurProcess } from '../utils/pm2.js'
import { sendMaster } from '../utils/masterMsg.js'
import { sendPrivate } from '../utils/privateMsg.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级）。服务端安家在云崽的 data/ 里，不跟插件走 */
const YunzaiRoot = path.resolve(PluginPath, '../..')
const SERVER_DIR = path.join(YunzaiRoot, 'data', 'gok-share-server')
const SERVER_BRANCH = 'server'

const ENV_FILE = path.join(SERVER_DIR, '.env')
const ENTRY_FILE = path.join(SERVER_DIR, 'bin', 'start.mjs')
const DB_FILE = path.join(SERVER_DIR, 'data', 'share.db')

const PROC_NAME = 'gok-share'
const DEFAULT_PORT = 8787
/** 和服务端 src/config.mjs 里的门槛保持一致 */
const MIN_NODE_MAJOR = 24

/* ------------------------------------------------------------ 小工具 */

function readEnvFile () {
  try {
    const out = {}
    for (const rawLine of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue

      const eq = line.indexOf('=')
      if (eq <= 0) continue
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}

function writeEnvFile (values) {
  const text = [
    '# 由 #营地共享库部署 生成。两把密钥都别外泄，也别提交进 git。',
    '#',
    '# ⚠️ GOK_SALT 一旦更换，数据库里所有 QQ 的哈希就全成了无意义的字符串，',
    '# 查询永远查不到东西 —— 等于所有人的共享记录一起作废。所以重新部署时',
    '# 这一步是复用已有值，不是重新生成。',
    `GOK_SALT=${values.GOK_SALT}`,
    `GOK_ADMIN_SECRET=${values.GOK_ADMIN_SECRET}`,
    `GOK_PORT=${values.GOK_PORT}`,
    values.GOK_HOST
      ? `GOK_HOST=${values.GOK_HOST}`
      : '#GOK_HOST=（留空 = 所有网卡，IPv4 和 IPv6 都能连）',
    ''
  ].join('\n')

  fs.writeFileSync(ENV_FILE, text, { mode: 0o600 })}

/** 已有就复用，没有才生成。见文件头第 3 条规矩 */
function ensureKeys (existing = {}) {
  // 老版本把 `0.0.0.0` 当默认值写进了 .env。现在默认改成「不指定」——
  // 交给服务端自己挑，有 IPv6 就绑双栈的 `::`，v4/v6 都通。
  // 所以要把这个旧默认值当成「没设过」，否则升级上来的机器仍然只监听 IPv4，
  // 而 `ss` 看起来「明明在监听」，特别难查（主人就是这么踩到的）。
  // 真想只监听 v4 的人，填那块网卡的具体 IPv4 地址，别填 0.0.0.0。
  const inheritedHost = existing.GOK_HOST === '0.0.0.0' ? '' : (existing.GOK_HOST || '')

  return {
    GOK_SALT: existing.GOK_SALT || crypto.randomBytes(32).toString('hex'),
    GOK_ADMIN_SECRET: existing.GOK_ADMIN_SECRET || crypto.randomBytes(32).toString('hex'),
    GOK_PORT: existing.GOK_PORT || String(DEFAULT_PORT),
    GOK_HOST: inheritedHost
  }
}

/** 从 start 往上找一个能监听的端口，别跟已占用的端口较劲 */
async function pickFreePort (start) {
  for (let port = start; port < start + 20; port++) {
    const free = await new Promise(resolve => {
      const probe = net.createServer()
      probe.once('error', () => resolve(false))
      // 不指定 host：服务端待会儿也是绑所有网卡，用同一口径探才准
      probe.once('listening', () => probe.close(() => resolve(true)))
      probe.listen(port)
    })
    if (free) return port
  }
  return null
}

async function waitHealth (port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) return await res.json()
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

async function issueToken (port, adminSecret, name) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': adminSecret },
    body: JSON.stringify({ name: name || '本机机器人' }),
    signal: AbortSignal.timeout(8000)
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`签发令牌失败（HTTP ${res.status}${text ? `：${text.slice(0, 120)}` : ''}）`)
  }
  return res.json()
}

async function probeAdmin (port, adminSecret) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/stats`, {
      headers: { 'X-Admin-Secret': adminSecret },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** 列出已签发的接入方。返回 null 表示连不上服务端 */
async function listClients (port, adminSecret) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/tokens`, {
      headers: { 'X-Admin-Secret': adminSecret },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    return (await res.json()).clients || []
  } catch {
    return null
  }
}

/** 吊销一个接入方。返回 false 表示没这个 id 或者连不上 */
async function revokeClient (port, adminSecret, id) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/admin/tokens/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Secret': adminSecret },
      signal: AbortSignal.timeout(5000)
    })
    return res.ok
  } catch {
    return false
  }
}

/* ------------------------------------------------ 服务端代码的拉取与迁移 */

/**
 * 跑一条 git 命令。和 utils/pm2.js 同样的讲究：参数走数组不拼字符串，
 * 路径带空格、带中文都不用自己加引号。
 */
function git (args, { cwd = PluginPath, timeout = 180000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true })
  return {
    ok: !r.error && r.status === 0,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim() || (r.error ? r.error.message : '')
  }
}

/** 这个插件仓库的 origin 地址，拿不到返回 null */
function originUrl () {
  const r = git(['remote', 'get-url', 'origin'], { timeout: 20000 })
  return r.ok ? r.out : null
}

/**
 * 把 server 分支的代码弄到 SERVER_DIR，三种起点都接得住：
 *  - 目录不存在 → 浅克隆
 *  - 已是克隆 → fetch + reset 到远端最新（只动被跟踪的文件，.env 和 data/ 冲不掉）
 *  - 目录存在但不是克隆（卸载后只剩 .env 和 data/ 的那种）→ git init 接回克隆，
 *    reset --hard 同样只写被跟踪的文件
 * 非克隆目录里既没有 .env 也没有 data/ 时，多半是别人的东西，拒绝动。
 */
/** 已有克隆（或刚 init 完）时：拉远端最新，reset --hard 只动被跟踪的文件 */
function pullIntoExistingClone () {
  const pulled = git(['fetch', '--depth', '1', 'origin', SERVER_BRANCH], { cwd: SERVER_DIR })
  if (!pulled.ok) return pulled
  return git(['reset', '--hard', 'FETCH_HEAD'], { cwd: SERVER_DIR })
}

function fetchServerCode (url) {
  if (fs.existsSync(path.join(SERVER_DIR, '.git'))) {
    return pullIntoExistingClone()
  }

  if (!fs.existsSync(SERVER_DIR)) {
    return git(['clone', '--depth', '1', '--branch', SERVER_BRANCH, url, SERVER_DIR], { timeout: 300000 })
  }

  // 目录在但不是克隆：多半是卸载后只剩 .env 和 data/ 的残留，git init 接回克隆
  const ours = fs.existsSync(ENV_FILE) || fs.existsSync(path.join(SERVER_DIR, 'data'))
  if (!ours) {
    return {
      ok: false,
      err: `${SERVER_DIR} 已经存在，而且看不出是本插件用过的目录 —— 不知道里面是什么，不敢动它。确认没用了就手动删掉再部署`
    }
  }

  const inited = git(['init'], { cwd: SERVER_DIR })
  if (!inited.ok) return inited
  const remote = git(['remote', 'add', 'origin', url], { cwd: SERVER_DIR })
  if (!remote.ok) return remote
  return pullIntoExistingClone()
}

/** 08-27 21:43 */
function fmtTime (ts) {
  const n = Number(ts)
  if (!n) return '—'
  const d = new Date(n)
  const p = v => String(v).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtSize (bytes) {
  if (!bytes) return '—'
  const mb = bytes / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fmtUptime (ms) {
  if (!ms || ms < 0) return '—'
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
}

/* ------------------------------------------------------------ 插件 */

export class ShareDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地ID共享库运维',
      dsc: '部署 / 查看 / 卸载营地ID共享库的服务端',
      event: 'message',
      priority: 0,
      rule: [
        // 「营地共享库X」和「营地共享X」两种叫法都收 —— 主人自己就打过 `#营地共享接入方`，
        // 少了中间那个「库」字。除了「状态」以外都能这么放宽，理由见下面那行注释。
        { reg: '^#营地共享库?部署$', fnc: 'deploy', permission: 'master' },
        // ⚠️ 这条**不能**跟着写成 `营地共享库?状态`：`#营地共享状态` 是用户侧
        // （apps/shareBind.js）在用的，两边都匹配同一条消息时由 loader 按注册顺序挑，
        // 结果不确定。宁可让它必须带「库」字。
        { reg: '^#营地共享库状态$', fnc: 'status', permission: 'master' },
        { reg: '^#营地共享库?卸载(确认)?$', fnc: 'uninstall', permission: 'master' },
        // 「发令牌」是给**别人**的机器人签的（部署时那条是给自己用的）。
        // 刻意不叫 `#营地共享库令牌列表` 之类：既有那条 `#营地共享库令牌 <值>`
        // 是「设置我自己要用的令牌」，两者只差一个字，用户会搞混。
        // - 备注是 `(.*)` 而不是 `(.+)`：@ 了人的话不写备注也说得通（拿 TA 的昵称当备注）
        // - 加 AT_HEAD 是为了认「先 @ 人再发指令」这种写法（群里最常见的顺序）
        { reg: `${AT_HEAD}#营地共享库?发令牌\\s*(.*)$`, fnc: 'issue', permission: 'master' },
        { reg: '^#营地共享库?接入方$', fnc: 'clients', permission: 'master' },
        { reg: '^#营地共享库?吊销\\s*(\\d+)$', fnc: 'revoke', permission: 'master' },
        // 全量对账。自动对账是「用户发指令时后台顺手做」、还带一小时节流，
        // 这条是人工兜底：刚接入完、或者怀疑某些人没传上去时手动推一遍
        { reg: '^#营地共享库?同步$', fnc: 'syncAll', permission: 'master' },
        // 直接问库。排查「两台都同步了、对面还说我没绑定」的第一站
        { reg: '^#营地共享库?查\\s*(\\d{5,12})$', fnc: 'lookup', permission: 'master' }
      ]
    })
  }

  /**
   * 结果里可能有令牌或者别人的 QQ，不能往群里发。
   * 群里执行时把详情走私聊，群里只留一句「发你私聊了」。
   *
   * @param {string} [hint] 群里那句提示。默认按「内容敏感」写，
   *   发令牌那种要显式传一句更贴切的，不然会张冠李戴（同步结果说成「带令牌」）
   */
  async replySafely (e, text, { hint } = {}) {
    if (!e.isGroup) return e.reply(text, shouldQuote())

    const delivered = await sendMaster(text)
    await e.reply(
      delivered
        ? (hint || '结果不太方便发在群里，已经私聊发你了')
        : '⚠️ 私聊发不出去（机器人可能没加你好友），改成私聊我再来一次吧',
      shouldQuote()
    )
    return undefined
  }

  /* -------------------------------------------------------- 部署 */

  async deploy (e) {
    // 先查 Node：服务端要 node:sqlite，低于 24 连进程都起不来
    const major = Number(process.versions.node.split('.')[0])
    if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
      return e.reply(
        `部署需要 Node ${MIN_NODE_MAJOR} 或更高（当前 ${process.versions.node}），先升级 Node 再来`,
        shouldQuote()
      )
    }

    if (!pm2Bin()) {
      return e.reply(
        '没找到 pm2，先装一个再部署：npm i -g pm2\n' +
        '（装完如果还报找不到，重启一下云崽让它认出新的 PATH）',
        shouldQuote()
      )
    }

    // 已经在跑就别重复起，pm2 会报名字冲突，报错还不好懂
    const running = pm2Proc(PROC_NAME)
    if (isOurProcess(running, SERVER_DIR)) {
      const env = readEnvFile()
      return this.replySafely(e, [
        '这个共享库已经在跑了：',
        `  http://127.0.0.1:${env.GOK_PORT || DEFAULT_PORT}`,
        `  目录：${path.relative(YunzaiRoot, SERVER_DIR)}/`,
        '',
        '要重新来一遍就先发 #营地共享库卸载'
      ].join('\n'))
    }

    await e.reply('正在部署营地ID共享库（要从 git 拉一下服务端代码），几十秒就好…', shouldQuote())

    try {
      // 服务端在仓库的 server 分支里，插件目录不再自带 —— 先把代码弄过来
      if (!git(['--version'], { timeout: 20000 }).ok) {
        throw new Error('没找到 git，拉不了服务端代码。装好 git（重开云崽认 PATH）再来')
      }

      const url = originUrl()
      if (!url) {
        throw new Error(
          '这个插件仓库没配 origin 远端，不知道去哪拉 server 分支。\n' +
          `手动克隆到 ${SERVER_DIR} 之后，再发一次部署就能接着走：\n` +
          `  git clone --depth 1 -b ${SERVER_BRANCH} <仓库地址> ${SERVER_DIR}`
        )
      }

      let codeFromLocal = false
      const fetched = fetchServerCode(url)
      if (!fetched.ok) {
        // 拉取失败但本地已经有代码 → 用本地的继续（离线重装、远端抽风都能用）
        if (!fs.existsSync(ENTRY_FILE)) {
          throw new Error(
            `拉取 ${SERVER_BRANCH} 分支失败：${fetched.err || '未知原因'}\n` +
            `· 确认这个分支已经推到远端（部署要从 origin 拉）\n` +
            '· 看看这台服务器能不能访问远端'
          )
        }
        codeFromLocal = true
        logger.warn(`[${PluginName}] server 分支拉取失败，用本地已有的代码继续：${fetched.err}`)
      }

      const existing = readEnvFile()
      const keys = ensureKeys(existing)

      // 首次部署时挑个空闲端口；已有配置就沿用，免得反代那边对不上
      if (!existing.GOK_PORT) {
        const port = await pickFreePort(DEFAULT_PORT)
        if (!port) throw new Error(`从 ${DEFAULT_PORT} 起找了 20 个端口都被占了，先腾一个出来`)
        keys.GOK_PORT = String(port)
      }

      writeEnvFile(keys)

      const start = pm2([
        'start', ENTRY_FILE,
        '--name', PROC_NAME,
        '--interpreter', 'node',
        '--cwd', SERVER_DIR
      ], { timeout: 60000 })

      if (!start.ok) {
        throw new Error(`pm2 启动失败：${start.err || start.out || '未知原因'}`)
      }

      const port = Number(keys.GOK_PORT)
      const health = await waitHealth(port)
      if (!health) {
        const logs = pm2(['logs', PROC_NAME, '--lines', '15', '--nostream'], { timeout: 20000 })
        logger.error(`[${PluginName}] 共享库起来了但健康检查不通：${logs.out || logs.err}`)
        throw new Error('进程起了但健康检查没通过，先发 #营地共享库状态 看看，日志在 pm2 里')
      }

      const created = await issueToken(port, keys.GOK_ADMIN_SECRET, '本机机器人')

      logger.mark(`[${PluginName}] 营地ID共享库已部署：127.0.0.1:${port}（${SERVER_DIR}）`)

      const lines = [
        '✅ 营地ID共享库部署好了',
        '',
        `地址：http://你的服务器IP:${port}`,
        '（防火墙 + 云主机安全组放行这个端口）',
        `进程：${PROC_NAME}，由 pm2 托管`,
        `目录：${path.relative(YunzaiRoot, SERVER_DIR)}/（在插件外面，更新插件不影响它）`,
        `数据：${path.relative(YunzaiRoot, DB_FILE)}`,
        `密钥：${path.relative(YunzaiRoot, ENV_FILE)}（别外泄）`
      ]

      if (codeFromLocal) {
        lines.push('', '⚠️ 远端没连上，用的是本地已有的服务端代码；连上网后重新部署一次就能更新。')
      }

      lines.push(
        '',
        '你的令牌（只在这里显示这一次，收好）：',
        created.token,
        '',
        '接下来：',
        `1. 放行 ${port} 端口（服务器防火墙 + 云主机安全组都要）`,
        `2. 发 #营地共享库地址 http://你的服务器IP:${port}`,
        `3. 发 #营地共享库令牌 ${created.token}`,
        '4. 发 #接入营地共享库',
        '',
        `⚠️ 明文 HTTP，令牌明文过网络。介意就配 HTTPS 反代（${path.relative(YunzaiRoot, SERVER_DIR)}/README.md 有示例）。`
      )

      return this.replySafely(e, lines.join('\n'), { hint: '结果里带令牌，已经私聊发你了' })
    } catch (error) {
      logger.error(`[${PluginName}] 部署共享库失败：${error?.stack || error}`)
      return this.replySafely(e, `❌ 部署失败：${error?.message || error}`)
    }
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const env = readEnvFile()
    const proc = pm2Proc(PROC_NAME)
    const ours = isOurProcess(proc, SERVER_DIR)

    // 本机没搭过库 = 这台是**接入方**。接入方本来就不该有服务端进程，
    // 报「进程没在跑，去部署一个」是彻头彻尾的误导 —— 主人就被这条唬过。
    // 这种情况改成把「你接入的那个库」的状态显示出来
    if (!ours && !env.GOK_ADMIN_SECRET) {
      const cfg = readShareConfig()
      if (!isShareReady()) {
        return e.reply([
          '这台还没接入共享库。',
          '自己搭：#营地共享库部署',
          '接入别人的：#营地共享库'
        ].join('\n'), shouldQuote())
      }

      const runtime = getShareStatus()
      return e.reply([
        '🗂 营地ID共享库（这台是接入方）',
        `地址：${cfg.apiUrl}`,
        `令牌：${maskToken(cfg.token)}`,
        `本机缓存：${runtime.cachedCount} 条`,
        `连通性：${runtime.circuitOpen ? '暂时不可用（自动重试中）' : '正常'}`
      ].join('\n'), shouldQuote())
    }

    const lines = ['🗂 营地ID共享库服务端']
    const port = Number(env.GOK_PORT) || DEFAULT_PORT

    if (!proc) {
      lines.push('进程：没在跑')
      lines.push('', '发 #营地共享库部署 装一个')
    } else if (!ours) {
      // 同名但不是我们起的 —— 别去碰它，只说清楚
      lines.push('进程：有个同名的 pm2 进程，但不是本插件起的，没有动它')
      lines.push(`（它的目录是 ${proc.pm2_env?.pm_cwd || '未知'}）`)
    } else {
      const status = proc.pm2_env?.status || 'unknown'
      const uptime = status === 'online' ? Date.now() - Number(proc.pm2_env?.pm_uptime || 0) : 0
      lines.push(`进程：${status === 'online' ? '运行中' : status}${uptime ? `（已跑 ${fmtUptime(uptime)}）` : ''}`)
      lines.push(env.GOK_HOST
        ? `监听：${env.GOK_HOST}:${port}`
        : `监听：所有网卡 ${port} 端口（IPv4 + IPv6）`)

      lines.push(`目录：${path.relative(YunzaiRoot, SERVER_DIR)}/`)

      const health = await waitHealth(port, 3000)
      lines.push(`健康检查：${health ? '正常' : '没响应（进程在但连不上，看看 pm2 logs）'}`)

      if (health) {
        const stats = await probeAdmin(port, env.GOK_ADMIN_SECRET || '')
        if (stats) {
          lines.push(`库里数据：${stats.totalQq} 个人，${stats.totalRows} 条绑定`)
          lines.push(`接入方：${stats.clientsActive}/${stats.clientsTotal} 个在用`)
        } else {
          lines.push('管理接口：连不上（密钥文件可能变了）')
        }
      }

      const restarts = Number(proc.pm2_env?.restart_time || 0)
      if (restarts > 0) lines.push(`重启次数：${restarts}${restarts > 5 ? '（有点多，看看日志）' : ''}`)
    }

    try {
      lines.push(`数据库：${fmtSize(fs.statSync(DB_FILE).size)}（${path.relative(YunzaiRoot, DB_FILE)}）`)
    } catch {
      lines.push('数据库：还没生成')
    }

    lines.push(`密钥文件：${fs.existsSync(ENV_FILE) ? `已生成（${path.relative(YunzaiRoot, ENV_FILE)}）` : '没有'}`)

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /* -------------------------------------------------------- 卸载 */

  async uninstall (e) {
    const confirmed = /确认$/.test(String(e.msg || '').trim())

    if (!confirmed) {
      return e.reply([
        '要卸载营地ID共享库吗？确认后会停掉 pm2 进程、清掉代码，但留下：',
        '',
        `· 密钥：${path.relative(YunzaiRoot, ENV_FILE)}`,
        `· 数据：${path.relative(YunzaiRoot, DB_FILE)}`,
        '',
        '重新部署能接着用原来的数据（盐不变，记录都认）。',
        '彻底不想要了就把这两样手动删掉 —— 要删就一起删，别只删一个。',
        '',
        '确认就发：#营地共享库卸载确认'
      ].join('\n'), shouldQuote())
    }

    const proc = pm2Proc(PROC_NAME)
    if (proc && !isOurProcess(proc, SERVER_DIR)) {
      // 同名但不是我们的，宁可不动 —— 停错了别人的服务很难查
      return e.reply(
        '找到同名的 pm2 进程，但它跑的目录不在本插件的服务端目录里，' +
        '为免误停别人的服务，这里不动它。要清理请自己确认一下',
        shouldQuote()
      )
    }

    const done = []
    const failed = []

    if (proc) {
      const del = pm2(['delete', PROC_NAME], { timeout: 30000 })
      if (del.ok) done.push('已停掉 pm2 进程')
      else failed.push(`停进程失败：${del.err || del.out}`)

      // delete 之后不 save，pm2 重启时会把它从 dump 里复活
      const saved = pm2(['save'], { timeout: 30000 })
      if (!saved.ok) failed.push('pm2 save 失败（下次 pm2 重启用可能又冒出来）')
    } else {
      done.push('没有在跑的进程')
    }

    // 只清代码，.env 和 data/ 原地保留 —— 盐和数据库同生共死，一起留着重新部署才接得上
    if (fs.existsSync(SERVER_DIR)) {
      try {
        for (const entry of fs.readdirSync(SERVER_DIR, { withFileTypes: true })) {
          if (entry.name === '.env' || entry.name === 'data') continue
          fs.rmSync(path.join(SERVER_DIR, entry.name), { recursive: true, force: true })
        }
        done.push('已清掉代码（密钥和数据保留）')
      } catch (error) {
        failed.push(
          `清代码失败（${error?.message || error}）。多半是文件还被占着，稍等一下手动删掉即可，` +
          `注意 ${path.relative(YunzaiRoot, ENV_FILE)} 和 data/ 别删`
        )
      }
    } else {
      done.push('服务端目录本来就不存在')
    }

    resetPm2Cache()
    logger.mark(`[${PluginName}] 营地ID共享库已卸载（${done.join('、')}）`)

    const lines = [`卸载完成：${done.join('、')}`]
    if (failed.length) lines.push('', '但有几步没成：', ...failed.map(t => `· ${t}`))

    lines.push(
      '',
      '密钥和数据都留着，重新部署能接着用：',
      `· ${path.relative(YunzaiRoot, ENV_FILE)}`,
      fs.existsSync(DB_FILE) ? `· ${path.relative(YunzaiRoot, DB_FILE)}` : '· （还没有数据库文件）',
      '',
      '彻底不想要了就把这两样手动删掉，要删就一起删。'
    )

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /* -------------------------------------------------- 给别人发令牌 */

  /** 读服务端配置。没部署过（或密钥文件没了）返回 null */
  readServerEnv () {
    const env = readEnvFile()
    if (!env.GOK_ADMIN_SECRET) return null

    return {
      port: Number(env.GOK_PORT) || DEFAULT_PORT,
      adminSecret: env.GOK_ADMIN_SECRET
    }
  }

  /**
   * 给**别人**的机器人签一个令牌。两种发法：
   *
   *  - `#营地共享库发令牌 某某的机器人` —— 把「让对方发的三行」拼好回给主人，主人自己转
   *  - `#营地共享库发令牌 @某某`        —— 直接私聊发给 TA，省掉主人转这一手
   *
   * ⚠️ 令牌**任何情况下都不出现在群里**（文件头第 1 条规矩）：@ 的那个人收不到时，
   * 令牌退回私聊给主人，群里只说一句「没发出去」。
   */
  async issue (e) {
    const note = stripAtText(e.msg).replace(/^#营地共享库?发令牌\s*/, '').trim()

    // @ 的是谁。点选出来的 @ 带 e.at（QQ 号）；手打的「@昵称」消息里没有 at 段，
    // 只能按名字去群成员里找（resolveTargetUserId 内部就是这么兜的）
    let target = null
    const atName = pickAtText(e.msg)
    if ((e.at && !e.atme) || atName) {
      let userId = e.at && !e.atme ? String(e.at) : ''
      if (!userId) {
        const resolved = await resolveTargetUserId(e)
        if (resolved.hint) return e.reply(resolved.hint, shouldQuote())
        userId = resolved.userId
      }
      target = { userId, name: (await resolveMemberName(e.group, userId)) || userId }
    }

    // 没写备注就拿被 @ 的人顶替，省得主人再想一个名字
    const label = note || (target ? `${target.name} 的机器人` : '')
    if (!label) {
      return e.reply('加个备注（比如「某某的机器人」），或者 @ 一下要发给谁', shouldQuote())
    }

    const server = this.readServerEnv()
    if (!server) {
      return e.reply('这台还没部署营地ID共享库，先发 #营地共享库部署', shouldQuote())
    }

    try {
      const created = await issueToken(server.port, server.adminSecret, label)
      const configured = readShareConfig().apiUrl
      const apiUrl = configured || `http://你的服务器IP:${server.port}`

      const steps = [
        `#营地共享库地址 ${apiUrl}`,
        `#营地共享库令牌 ${created.token}`,
        '#接入营地共享库'
      ]

      const ownerText = [
        `📮 给「${label}」的令牌（只显示这一次，别弄丢）`,
        '',
        created.token,
        '',
        '把下面三行整段发给对方，让 TA 在自己的机器人上依次发出来：',
        ...steps,
        '',
        configured
          ? '地址用的是你已经配好的那个。'
          : `⚠️ 你还没配过共享库地址，上面那行里的「你的服务器IP」要换成真实的（带 ${server.port} 端口）。`,
        '想看谁在用、或者踢掉谁：#营地共享库接入方'
      ].join('\n')

      // 地址还没配过时，「三行」里的地址是个占位符，直接甩给对方只会让 TA 更迷糊 ——
      // 所以这种情况不管 @ 没 @，都按老路子把结果留给主人
      if (target && configured) {
        const sent = await sendPrivate(target.userId, [
          `🔑 「${label}」的营地ID共享库接入信息（只发这一次，别弄丢）`,
          '',
          '在你的机器人上依次发这三行就行：',
          ...steps
        ].join('\n'), { bot: e.bot })

        if (sent.ok) {
          logger.mark(`[${PluginName}] 共享库令牌已私聊给 ${target.userId}：${label}`)
          return e.reply(`已经把「${label}」的令牌私聊发给 ${target.name} 了`, shouldQuote())
        }

        logger.mark(`[${PluginName}] 私聊 ${target.userId} 失败（${sent.reason}），令牌改发主人：${label}`)
        const delivered = await sendMaster(ownerText)
        return e.reply(
          delivered
            ? `私聊给 ${target.name} 没发出去（TA 多半没开临时会话），令牌已经私聊发给你了，你转给 TA 吧`
            : `私聊给 ${target.name} 发不出去，你的私聊也没成功。你私聊我发一次这条指令，我把令牌发你`,
          shouldQuote()
        )
      }

      logger.mark(`[${PluginName}] 已签发共享库令牌：${label}`)

      return this.replySafely(e, ownerText, {
        hint: target
          ? '地址还没配好，结果里带令牌，先私聊发你了'
          : '结果里带令牌，已经私聊发你了'
      })
    } catch (error) {
      logger.error(`[${PluginName}] 签发共享库令牌失败：${error?.message || error}`)
      return e.reply(`签发失败：${error?.message || error}`, shouldQuote())
    }
  }

  /** 列出已签发的接入方。令牌明文只在签发那一次出现，这里只能看到前缀 */
  async clients (e) {
    const server = this.readServerEnv()
    if (!server) {
      return e.reply('这台还没部署营地ID共享库，先发 #营地共享库部署', shouldQuote())
    }

    const list = await listClients(server.port, server.adminSecret)
    if (list === null) {
      return e.reply('连不上服务端，先发 #营地共享库状态 看看', shouldQuote())
    }

    const active = list.filter(row => row.enabled).length
    const lines = [`👥 已签发的接入方（${active} 个在用，共 ${list.length} 个）`, '']

    if (!list.length) {
      lines.push('还一个都没发过')
    } else {
      for (const row of list) {
        lines.push(`${row.id}. ${row.name}${row.enabled ? '' : '（已吊销）'}`)
        lines.push(
          `   令牌 ${row.tokenPrefix}… · 最后请求 ${Number(row.lastSeenAt) ? fmtTime(row.lastSeenAt) : '从没请求过'}`
        )
      }
    }

    lines.push('', '发给别人：#营地共享库发令牌 <备注>（@一下群友就直接私聊发给 TA）')
    lines.push('踢掉一个：#营地共享库吊销 <序号>')

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /** 吊销。对方那边的机器人再请求会直接连不上（403） */  async revoke (e) {
    const id = Number(e.msg.match(/^#营地共享库吊销\s*(\d+)$/)?.[1])

    const server = this.readServerEnv()
    if (!server) {
      return e.reply('这台还没部署营地ID共享库，先发 #营地共享库部署', shouldQuote())
    }

    const ok = await revokeClient(server.port, server.adminSecret, id)
    if (!ok) {
      return e.reply(`没找到 ${id} 号接入方，发 #营地共享库接入方 看看列表`, shouldQuote())
    }

    logger.mark(`[${PluginName}] 已吊销共享库接入方 #${id}`)
    return e.reply(
      `已吊销 ${id} 号。对方的机器人下次请求共享库会被拒（他自己的其他功能不受影响）。`,
      shouldQuote()
    )
  }

  /**
   * 把本机**所有**绑定过的用户全量对一遍账。
   *
   * ⚠️ 用的是**客户端配置**（`shareApiUrl` / `shareToken`），不是 `server/.env` ——
   * 所以**接入别人库的机器人一样能用**，不是只有搭库那台才能跑。
   * 这里以前读的是 readServerEnv()，把接入方全挡在外面了。
   *
   * 自动对账是「用户发指令时后台顺手做」、还带一小时节流；这条是人工兜底 ——
   * 刚接入完共享库、或者怀疑某些人的数据没传上去时手动推一遍。
   *
   * 只处理「库里本来就有他记录」的人。库里没有说明他没开共享，不该替他传 ——
   * 这是「共享」而不是「上传所有人的数据」，边界必须守住。
   */
  async syncAll (e) {
    if (!isShareReady()) {
      return e.reply('这台还没接入营地ID共享库，发 #营地共享库 看看当前状态和接入办法', shouldQuote())
    }

    const store = readUserData()
    const users = Object.keys(store).filter(qq => Array.isArray(store[qq]?.ids) && store[qq].ids.length)
    if (!users.length) {
      return e.reply('本机还没有人绑定过营地ID', shouldQuote())
    }

    // 每人至少一次请求，串行做完要一会儿；先给回执，不然以为指令死了
    await e.reply(
      `正在对账本机 ${users.length} 个绑定用户，大约 ${Math.ceil(users.length * 0.3)} 秒…`,
      shouldQuote()
    )

    let pushed = 0
    let notShared = 0
    let failed = 0
    // 记下具体是谁同步上去了。只有主人看得到，而且这条结果走私聊 ——
    // 「谁开过共享」是别人的隐私，不该跟着发进群里
    const pushedList = []

    // 先把自己传上去：按下这条指令的**就是主人本人**，这个动作本身就是授权，
    // 不该因为他「没发过 #开启营地ID共享」而把自己漏在外头 ——
    // 主人踩过的就是这个坑：两台都同步了，对方还是说他没绑定
    const selfQQ = String(e.user_id || '')
    const selfIds = Array.isArray(store[selfQQ]?.ids) ? store[selfQQ].ids : []
    if (selfQQ && selfIds.length) {
      const own = await pushBind(selfQQ, selfIds, selfIds[store[selfQQ].current] || '')
      if (own.ok) {
        pushed += 1
        pushedList.push(selfQQ)
      } else {
        failed += 1
      }
    }

    for (const qq of users) {
      if (qq === selfQQ) continue // 自己上面已经传过

      const result = await reconcileNow(qq)
      if (result === 'shared') {
        pushed += 1
        pushedList.push(qq)
      } else if (result === 'not-shared') notShared += 1
      else failed += 1

      // 串行 + 小间隔，别把自己打出一串 429
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    logger.mark(`[${PluginName}] 共享库全量对账完成：同步 ${pushed}、未共享 ${notShared}、失败 ${failed}`)

    const lines = [
      '全量对账完成：',
      `· 同步上去：${pushed} 人`,
      `· 没开共享、跳过：${notShared} 人`
    ]
    if (failed) lines.push(`· 失败：${failed} 人（连不上或者额度用完，稍后再试）`)
    if (pushedList.length) lines.push('', `同步上去的是：${pushedList.join('、')}`)

    if (notShared) lines.push('', '没传的让他们自己发一次 #开启营地ID共享。')

    // 结果里有别人的 QQ，群里执行时走私聊
    return this.replySafely(e, lines.join('\n'))
  }

  /**
   * 直接问库：这个 QQ 在库里有没有记录、有哪些营地ID。
   *
   * 排查「两台都同步了、对面还是说我没绑定」的第一站 —— 先确认库里到底有没有，
   * 比来回猜「是不是缓存」「要不要重启」快得多。
   */
  async lookup (e) {
    if (!isShareReady()) {
      return e.reply('这台还没接入营地ID共享库，发 #营地共享库 看看', shouldQuote())
    }

    const qq = String(e.msg.match(/(\d{5,12})\s*$/)?.[1] || '')
    const result = await querySharedBind(qq)

    if (result.error) return e.reply(`查不了：${result.error}`, shouldQuote())

    if (!result.found) {
      return e.reply(`库里没有 ${qq}，让 TA 自己发一次 #开启营地ID共享`, shouldQuote())
    }

    return e.reply([
      `库里 ${qq} 的记录：`,
      `营地ID：${result.campIds.length ? result.campIds.join('、') : '（空）'}`,
      `当前号：${result.current || '—'}`
    ].join('\n'), shouldQuote())
  }
}
