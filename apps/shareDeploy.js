/**
 * 营地ID共享库的**服务端运维**：#部署 / #状态 / #卸载。
 *
 * 和 apps/shareBind.js 的分工：那边管「本机要不要接某个库」（客户端配置），
 * 这边管「本机自己搭的那个库跑没跑」（服务端进程）。
 *
 * ## 为什么是 QQ 指令而不是命令行脚本
 *
 * 插件本来就跑在云崽里，而部署要做的每件事（生成密钥、写文件、起进程、签发令牌）
 * 都能用 Node API 完成 —— 一份代码 Windows 和 Linux 通用，不用像 meme 那样
 * 再配一份 PowerShell 脚本和一套按平台分派的解析逻辑。
 *
 * ## 三条硬规矩
 *
 * 1. **令牌只在私聊里出现**。群里执行的话结果一律走私聊，群里只回一句「已私聊」。
 * 2. **卸载只认自己起的那个进程**：cwd 或入口脚本必须落在本插件 server/ 目录下。
 *    光比进程名会把别人的东西停掉（这条教训是从 meme 的卸载逻辑带过来的）。
 * 3. **盐要复用，卸载也不能删**。换了盐，数据库里所有 QQ 的哈希当场变成无意义的
 *    字符串 —— 查询永远 404，等于所有人的共享记录一起作废。所以密钥必须跟数据
 *    同生共死：留数据就得留盐，删盐就要连数据一起删，不能只删一半。
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import fetch from 'node-fetch'
import { PluginPath, PluginName } from '#components'
import { shouldQuote, readShareConfig } from '#utils'
import { pm2, pm2Proc, pm2Bin, resetPm2Cache, isOurProcess } from '../utils/pm2.js'
import { sendMaster } from '../utils/masterMsg.js'

const SERVER_DIR = path.join(PluginPath, 'server')
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
        // 是「设置我自己要用的令牌」，两者只差一个字，用户会搞混
        { reg: '^#营地共享库?发令牌\\s*(.+)$', fnc: 'issue', permission: 'master' },
        { reg: '^#营地共享库?接入方$', fnc: 'clients', permission: 'master' },
        { reg: '^#营地共享库?吊销\\s*(\\d+)$', fnc: 'revoke', permission: 'master' }
      ]
    })
  }

  /**
   * 结果里可能有令牌，不能往群里发。
   * 群里执行时把详情走私聊，群里只留一句「发你私聊了」。
   */
  async replySafely (e, text) {
    if (!e.isGroup) return e.reply(text, shouldQuote())

    const delivered = await sendMaster(text)
    await e.reply(
      delivered
        ? '结果里带令牌，已经私聊发你了'
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

    if (!fs.existsSync(ENTRY_FILE)) {
      return e.reply('没找到服务端文件（server/bin/start.mjs），插件更新一下再试', shouldQuote())
    }

    // 已经在跑就别重复起，pm2 会报名字冲突，报错还不好懂
    const running = pm2Proc(PROC_NAME)
    if (isOurProcess(running, SERVER_DIR)) {
      const env = readEnvFile()
      return this.replySafely(e, [
        '这个共享库已经在跑了：',
        `  http://127.0.0.1:${env.GOK_PORT || DEFAULT_PORT}`,
        '',
        '要重新来一遍就先发 #营地共享库卸载'
      ].join('\n'))
    }

    if (!pm2Bin()) {
      return e.reply(
        '没找到 pm2，先装一个再部署：npm i -g pm2\n' +
        '（装完如果还报找不到，重启一下云崽让它认出新的 PATH）',
        shouldQuote()
      )
    }

    await e.reply('正在部署营地ID共享库，十几秒就好…', shouldQuote())

    try {
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

      logger.mark(`[${PluginName}] 营地ID共享库已部署：127.0.0.1:${port}`)

      return this.replySafely(e, [
        '✅ 营地ID共享库部署好了',
        '',
        `地址：http://你的服务器IP:${port}`,
        '（IPv4 和 IPv6 都在监听；把服务器防火墙和云主机安全组的这个端口放行，外面就能连）',
        `进程：${PROC_NAME}，由 pm2 托管`,
        `数据：${path.relative(PluginPath, DB_FILE)}`,
        `密钥：${path.relative(PluginPath, ENV_FILE)}（别外泄）`,
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
        '⚠️ 这么跑是明文 HTTP，令牌会明文过网络。介意的话在前面配个 HTTPS 反代' +
        '（server/README.md 里有 nginx 示例），再把 .env 里的 GOK_HOST 改成 127.0.0.1。'
      ].join('\n'))
    } catch (error) {
      logger.error(`[${PluginName}] 部署共享库失败：${error?.stack || error}`)
      return this.replySafely(e, `❌ 部署失败：${error?.message || error}`)
    }
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const proc = pm2Proc(PROC_NAME)
    const ours = isOurProcess(proc, SERVER_DIR)
    const env = readEnvFile()
    const port = Number(env.GOK_PORT) || DEFAULT_PORT

    const lines = ['🗂 营地ID共享库服务端']

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
      lines.push(`数据库：${fmtSize(fs.statSync(DB_FILE).size)}`)
    } catch {
      lines.push('数据库：还没生成')
    }

    lines.push(`密钥文件：${fs.existsSync(ENV_FILE) ? '已生成' : '没有'}`)

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /* -------------------------------------------------------- 卸载 */

  async uninstall (e) {
    const confirmed = /确认$/.test(String(e.msg || '').trim())

    if (!confirmed) {
      return e.reply([
        '要卸载营地ID共享库吗？这一步只停服务，其余都留着：',
        '',
        `· 密钥：${path.relative(PluginPath, ENV_FILE)}`,
        `· 数据：${path.relative(PluginPath, DB_FILE)}`,
        '',
        '刻意保留是有原因的：库里存的是 QQ 的加盐哈希，**换一把盐这些哈希就全废了**，',
        '所以密钥必须跟数据同生共死。重新部署能接着用原来的数据。',
        '想彻底清干净就把上面这两个自己删掉。',
        '',
        '确认就发：#营地共享库卸载确认'
      ].join('\n'), shouldQuote())
    }

    const proc = pm2Proc(PROC_NAME)
    if (proc && !isOurProcess(proc, SERVER_DIR)) {
      // 同名但不是我们的，宁可不动 —— 停错了别人的服务很难查
      return e.reply(
        '找到同名的 pm2 进程，但它的目录不是本插件的 server/，' +
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

    resetPm2Cache()
    logger.mark(`[${PluginName}] 营地ID共享库已卸载（密钥和数据保留）`)

    const lines = [`卸载完成：${done.join('、')}`]
    if (failed.length) lines.push('', '但有几步没成：', ...failed.map(t => `· ${t}`))

    // 密钥**故意删掉**是错的：库里是 QQ 的加盐哈希，换盐等于让所有记录作废，
    // 而数据库是保留的 —— 只留锁不留钥匙。两者要么一起留，要么一起删。
    lines.push(
      '',
      '密钥和数据都留着，重新部署能接着用：',
      `· ${path.relative(PluginPath, ENV_FILE)}`,
      fs.existsSync(DB_FILE) ? `· ${path.relative(PluginPath, DB_FILE)}` : '· （还没有数据库文件）',
      '',
      '彻底不想要了就把这两个删掉，别只删其中一个。'
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
   * 给**别人**的机器人签一个令牌。
   *
   * 部署时自动签的那个是给自己用的，这个才是往外发的。回复里直接把「让对方发的三行」
   * 拼好了，主人整段转发即可 —— 少一步手抄就少一次抄错。
   */
  async issue (e) {
    const note = String(e.msg.match(/^#营地共享库发令牌\s*(.+)$/)?.[1] || '').trim()

    const server = this.readServerEnv()
    if (!server) {
      return e.reply('这台还没部署营地ID共享库，先发 #营地共享库部署', shouldQuote())
    }

    try {
      const created = await issueToken(server.port, server.adminSecret, note)
      const configured = readShareConfig().apiUrl
      const apiUrl = configured || `http://你的服务器IP:${server.port}`

      logger.mark(`[${PluginName}] 已签发共享库令牌：${note}`)

      return this.replySafely(e, [
        `📮 给「${note}」的令牌（只显示这一次，别弄丢）`,
        '',
        created.token,
        '',
        '把下面三行整段发给对方，让 TA 在自己的机器人上依次发出来：',
        `#营地共享库地址 ${apiUrl}`,
        `#营地共享库令牌 ${created.token}`,
        '#接入营地共享库',
        '',
        configured
          ? '地址用的是你已经配好的那个。'
          : `⚠️ 你还没配过共享库地址，上面那行里的「你的服务器IP」要换成真实的（带 ${server.port} 端口）。`,
        '想看谁在用、或者踢掉谁：#营地共享库接入方'
      ].join('\n'))
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

    lines.push('', '发给别人：#营地共享库发令牌 <备注>')
    lines.push('踢掉一个：#营地共享库吊销 <序号>')

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /** 吊销。对方那边的机器人再请求会直接连不上（403） */
  async revoke (e) {
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
}
