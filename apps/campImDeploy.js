/**
 * 营地消息服务端的**一键部署**：#营地消息部署 / #营地消息服务。
 *
 * ## 服务端代码从哪来
 *
 * **不在 master 上** —— 单独住在仓库的 **`im-server` 分支**里。部署时把那个分支
 * 浅克隆到 `<插件>/server-im/`，`.gitignore` 把整个 `server-im/` 挡住，所以：
 *   · 客户端的插件更新（拉 master）永远碰不到服务端代码
 *   · 服务端也不用跟着插件的发版节奏走
 *
 * ⚠️ 分支名是 `im-server`。**别和另外两个搞混**：
 *   · `watch-server` → 营地观战服务（apps/watchDeploy.js，落在 `server/`）
 *   · `server`       → 营地ID共享库（apps/shareDeploy.js）
 *
 * ## 为什么部署在插件目录里
 *
 * 服务端要读 `data/AuthPool.json`。留在 `server-im/` 下，`HERE/..` 这个相对路径
 * 天然成立 —— 一行路径代码都不用改。它也自带一份零依赖的 `lib/xxtea.js`，
 * 不依赖插件本体的 utils（服务端是独立进程，import 不了那边的云崽运行时依赖）。
 *
 * ## 两条硬规矩（跟 watchDeploy / shareDeploy 同源）
 *
 * 1. **只动自己起的那个进程**：cwd 或入口脚本必须落在本插件的 server-im 目录下。
 *    光比进程名会把别人的同名进程停掉 —— 这条教训是从 meme 的卸载逻辑带过来的。
 * 2. **认不出就不动**：`server-im/` 存在、没 `.git`、里面又没有 `camp-im-server.js`
 *    （认不出是我们的目录）→ 拒绝，让主人自己确认。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PluginPath, PluginName, Config } from '#components'
import { shouldQuote } from '#utils'
import { pm2, pm2Proc, pm2Bin, resetPm2Cache, isOurProcess } from '../utils/pm2.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级）—— 只为把路径显示得短一点 */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/** 服务端代码拉到这里（在插件目录里，被 .gitignore 挡着，不跟插件本体一起提交） */
const SERVER_DIR = path.join(PluginPath, 'server-im')
const ENTRY_FILE = path.join(SERVER_DIR, 'camp-im-server.js')
const HAS_CLONE = path.join(SERVER_DIR, '.git')

/** 服务端代码住这个分支。⚠️ 不是 `server`（共享库）也不是 `watch-server`（观战） */
const SERVER_BRANCH = 'im-server'

const PROC_NAME = 'gok-im'
const DEFAULT_PORT = 8900

/**
 * 拉下来之后必须齐活的文件。少一个服务端起不来。
 *
 * ⚠️ `lib/xxtea.js` 由**分支**提供（服务端自带一份零依赖的），
 *    和观战那边从插件本体读 `utils/xxtea.js` 的做法不同 ——
 *    因为 IM 服务端完全不需要云崽运行时。
 */
const NEEDED = [
  'server-im/camp-im-server.js',
  'server-im/lib/xxtea.js'
]

/* ------------------------------------------------------------ 小工具 */

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 服务端在哪个端口：从配置的服务地址里抠，抠不到按默认 */
function serverPort () {
  const m = String(cfg().campImApiUrl || '').match(/:(\d+)/)
  return m ? Number(m[1]) : DEFAULT_PORT
}

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

/** 已有克隆（或刚 init 完）时：拉远端最新，reset --hard 只动被跟踪的文件 */
function pullIntoExistingClone () {
  const fetched = git(['fetch', '--depth', '1', 'origin', SERVER_BRANCH], { cwd: SERVER_DIR })
  if (!fetched.ok) return fetched
  return git(['reset', '--hard', 'FETCH_HEAD'], { cwd: SERVER_DIR })
}

/**
 * 把 `im-server` 分支的代码弄到 SERVER_DIR，三种起点都接得住：
 *  - 已是克隆 → fetch + reset 到远端最新
 *  - 目录不存在 → 浅克隆
 *  - 目录存在但不是克隆 → git init 接回克隆
 * 认不出是我们的目录时**拒绝动**（见文件头第 2 条规矩）。
 */
function fetchServerCode (url) {
  if (fs.existsSync(HAS_CLONE)) return pullIntoExistingClone()

  if (!fs.existsSync(SERVER_DIR)) {
    return git(['clone', '--depth', '1', '--branch', SERVER_BRANCH, url, SERVER_DIR], { timeout: 300000 })
  }

  if (!fs.existsSync(ENTRY_FILE)) {
    return {
      ok: false,
      err: `${path.relative(YunzaiRoot, SERVER_DIR)} 已经存在，但里面没有 camp-im-server.js —— ` +
        '看不出是本插件的目录，不敢动它。确认没用了就手动删掉再部署'
    }
  }

  const inited = git(['init'], { cwd: SERVER_DIR })
  if (!inited.ok) return inited
  const remote = git(['remote', 'add', 'origin', url], { cwd: SERVER_DIR })
  if (!remote.ok && !/already exists/i.test(remote.err)) return remote
  return pullIntoExistingClone()
}

/** 探一次状态接口。连不上返回 null（不抛） */
async function probeStatus (port, timeout = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(timeout)
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** 等它起来（pm2 拉起到真正监听之间有几百毫秒的空窗） */
async function waitStatus (port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await probeStatus(port)
    if (s) return s
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

function fmtUptime (ms) {
  if (!ms || ms < 0) return '—'
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
}

/* ------------------------------------------------------------ 插件 */

export class CampImDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地消息运维',
      dsc: '部署 / 查看营地消息服务端（im-server 分支上那套）',
      event: 'message',
      // ⚠️ 必须是负的：`#营地消息` 那条规则是精确匹配 `^#营地消息$`，
      //    `#营地消息部署` 不会被它吃掉，但保险起见和 watchDeploy 保持一致。
      priority: -1,
      rule: [
        { reg: '^#营地消息部署$', fnc: 'deploy', permission: 'master' },
        { reg: '^#营地消息服务$', fnc: 'status', permission: 'master' }
      ]
    })
  }

  /* -------------------------------------------------------- 部署 */

  async deploy (e) {
    if (!pm2Bin()) {
      return e.reply(
        '没找到 pm2，先装一个再部署：npm i -g pm2\n' +
        '（装完如果还报找不到，重启一下云崽让它认出新的 PATH）',
        shouldQuote()
      )
    }

    if (!git(['--version'], { timeout: 20000 }).ok) {
      return e.reply(
        '没找到 git，拉不了服务端代码。装好 git（重开云崽让它认出新的 PATH）再来',
        shouldQuote()
      )
    }

    const url = originUrl()
    if (!url) {
      return e.reply([
        '这个插件仓库没配 origin 远端，不知道去哪拉服务端代码。',
        `手动克隆到 ${path.relative(YunzaiRoot, SERVER_DIR)} 之后，再发一次部署就能接着走：`,
        `  git clone --depth 1 -b ${SERVER_BRANCH} <仓库地址> ${SERVER_DIR}`
      ].join('\n'), shouldQuote())
    }

    // 同名进程但不是我们起的 —— 别去碰它，只说清楚（见文件头第 1 条规矩）
    const running = pm2Proc(PROC_NAME)
    if (running && !isOurProcess(running, SERVER_DIR)) {
      return e.reply([
        `有个叫 ${PROC_NAME} 的 pm2 进程，但跑的不是本插件的营地消息服务，没有动它。`,
        `（它的目录是 ${running.pm2_env?.pm_cwd || '未知'}）`
      ].join('\n'), shouldQuote())
    }

    const restarting = Boolean(running)
    await e.reply(
      restarting
        ? '正在重启营地消息服务…'
        : '正在部署营地消息服务（要从 git 拉一下服务端代码），几十秒就好…',
      shouldQuote()
    )

    try {
      let codeFromLocal = false
      const fetched = fetchServerCode(url)
      if (!fetched.ok) {
        if (!fs.existsSync(ENTRY_FILE)) {
          throw new Error(
            `拉取 ${SERVER_BRANCH} 分支失败：${fetched.err || '未知原因'}\n` +
            `· 确认这个分支已经推到远端（部署要从 origin 拉）\n` +
            '· 看看这台服务器能不能访问远端'
          )
        }
        codeFromLocal = true
        logger.warn(`[${PluginName}] ${SERVER_BRANCH} 分支拉取失败，用本地已有的代码继续：${fetched.err}`)
      }

      const missing = NEEDED.filter(f => !fs.existsSync(path.join(PluginPath, f)))
      if (missing.length) {
        throw new Error(`服务端文件不齐，缺：${missing.join('、')}。请主人检查 ${SERVER_BRANCH} 分支上的文件是否完整`)
      }

      const startup = restarting
        ? pm2(['restart', PROC_NAME, '--update-env'], { timeout: 60000 })
        : pm2([
            'start', ENTRY_FILE,
            '--name', PROC_NAME,
            '--interpreter', 'node',
            '--cwd', SERVER_DIR
          ], { timeout: 60000 })

      if (!startup.ok) {
        throw new Error(`pm2 ${restarting ? '重启' : '启动'}失败：${startup.err || startup.out || '未知原因'}`)
      }

      const saved = pm2(['save'], { timeout: 30000 })
      if (!saved.ok) logger.warn(`[${PluginName}] pm2 save 失败，开机自启可能没生效：${saved.err || saved.out}`)

      const port = serverPort()
      const status = await waitStatus(port)
      if (!status) {
        const logs = pm2(['logs', PROC_NAME, '--lines', '15', '--nostream'], { timeout: 20000 })
        logger.error(`[${PluginName}] 营地消息服务起了但状态接口不通：${logs.out || logs.err}`)
        throw new Error('进程起了但状态接口没通，日志在 pm2 里，先发 #营地消息服务 看看')
      }

      resetPm2Cache()
      logger.mark(`[${PluginName}] 营地消息服务已${restarting ? '重启' : '部署'}：127.0.0.1:${port}（${SERVER_DIR}）`)

      const online = (status.clients || []).filter(c => c.state === 'online').length
      const total = (status.clients || []).length
      const lines = [
        `✅ 营地消息服务${restarting ? '已重启' : '部署好了'}`,
        '',
        `进程：${PROC_NAME}（pm2 托管，开机自启）`,
        `端口：${port}`,
        `账号：${online}/${total} 在线`
      ]

      if (!total) {
        lines.push('', '还没有可用的营地账号\n发 #营地wx全局登录 扫码添加')
      }

      if (codeFromLocal) {
        lines.push('', `⚠️ 远端没连上（或者 ${SERVER_BRANCH} 分支还没推上去），用的是本地已有的服务端代码。`)
      }

      lines.push('', '看状态：发 #营地消息')

      return e.reply(lines.join('\n'), shouldQuote())
    } catch (error) {
      logger.error(`[${PluginName}] 部署营地消息服务失败：${error?.stack || error}`)
      return e.reply(`❌ 部署失败：${error?.message || error}`, shouldQuote())
    }
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const proc = pm2Proc(PROC_NAME)
    const port = serverPort()
    const lines = ['📨 营地消息服务']

    if (!proc) {
      lines.push('', '没在跑', '发 #营地消息部署 装一个')
      return e.reply(lines, shouldQuote())
    }
    if (!isOurProcess(proc, SERVER_DIR)) {
      lines.push('', `有个叫 ${PROC_NAME} 的进程，但不是本插件起的，没有动它`)
      return e.reply(lines, shouldQuote())
    }

    lines.push('', `进程：${proc.pm2_env?.status || '未知'}`)
    lines.push(`已跑：${fmtUptime(Date.now() - (proc.pm2_env?.pm_uptime || 0))}`)
    const restarts = proc.pm2_env?.restart_time
    if (restarts) lines.push(`重启次数：${restarts}`)
    lines.push(`端口：${port}`)

    const status = await probeStatus(port)
    if (!status) {
      lines.push('', '⚠️ 状态接口不通，先看看 pm2 日志')
    } else {
      const clients = status.clients || []
      const online = clients.filter(c => c.state === 'online').length
      lines.push(`账号：${online}/${clients.length} 在线`)
      if (status.queue) lines.push(`待处理：${status.queue.lastId || 0} 条`)
    }

    return e.reply(lines, shouldQuote())
  }
}
