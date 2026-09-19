/**
 * **分发服务**的运维与令牌签发：#营地分发部署 / #营地分发服务 / #营地分发发令牌 …
 *
 * ## 分发服务是什么
 *
 * 一个零依赖的 Node 小服务（默认端口 6868），跑在**主人自己的服务器**上，
 * 按 commit sha 把服务端代码打成 tar.gz 发出去。观战和营地消息的部署指令
 * 都从它这里下载代码 —— 这样服务端代码就不需要出现在任何公开仓库里。
 *
 * ## 「一个 token 通吃三套」是怎么做到的
 *
 * 分发服务签发令牌时，如果配了共享库（`GOK_DIST_SHARE_URL` + 管理密钥），
 * 它会**代共享库签**一个 `gok_xxx`，然后把这个值也存进自己的表。于是同一个令牌：
 *   · 部署观战/消息 → 分发服务查自己的表 → 放行
 *   · 接入共享库 → 共享库服务端本来认它 → 放行
 * 没配共享库时退化：自己签 `gokd_xxx`，只能用于部署。
 *
 * ## 三条硬规矩（跟 shareDeploy 同源）
 *
 * 1. **令牌只在私聊里出现**，群里只回一句「已私聊」。
 * 2. **管理密钥只在私聊里设置**（`#营地分发管理密钥`）。
 * 3. **卸载/重启只认自己起的那个进程**。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { PluginPath, PluginName, Config } from '#components'
import { shouldQuote, maskToken, AT_HEAD, stripAtText, pickAtText, resolveTargetUserId, resolveMemberName } from '#utils'
import { pm2, pm2Proc, pm2Bin, resetPm2Cache, isOurProcess } from '../utils/pm2.js'
import { sendMaster } from '../utils/masterMsg.js'
import { sendPrivate } from '../utils/privateMsg.js'

/** 云崽根目录 */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/** 分发服务的运行目录（跟共享库一个路子：住插件目录外面，更新插件碰不到） */
const SERVER_DIR = path.join(YunzaiRoot, 'data', 'gok-dist')
const ENV_FILE = path.join(SERVER_DIR, '.env')
const ENTRY_FILE = path.join(SERVER_DIR, 'bin', 'start.mjs')

const PROC_NAME = 'gok-dist'
const DEFAULT_PORT = 6868

/** 私库的地址（分发服务的代码在里面，独立分支 `dist`） */
const DEFAULT_REPO = 'https://github.com/cchanlan/gok-server.git'
const SERVER_BRANCH = 'dist'

const GROUP_HINT = '进群 972915804 找主人要'

/* ------------------------------------------------------------ 小工具 */

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 跑一条 git 命令。参数走数组不拼字符串 */
function git (args, { cwd = PluginPath, timeout = 180000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true })
  return {
    ok: !r.error && r.status === 0,
    out: String(r.stdout || '').trim(),
    err: String(r.stderr || '').trim() || (r.error ? r.error.message : '')
  }
}

/** 读分发服务自己的 .env */
function readEnvFile () {
  try {
    const out = {}
    for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const i = line.indexOf('=')
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
    return out
  } catch {
    return {}
  }
}

function writeEnvFile (values) {
  const lines = [
    '# 由 #营地分发部署 生成。管理密钥别外泄，也别提交进 git。',
    ''
  ]
  for (const [k, v] of Object.entries(values)) lines.push(`${k}=${v}`)
  lines.push('')
  fs.mkdirSync(SERVER_DIR, { recursive: true })
  fs.writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 })
}

/** 探一次健康接口 */
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

/** 调分发服务的管理接口 */
async function adminCall (base, adminSecret, pathname, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': adminSecret },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) return { ok: false, message: data?.message || `HTTP ${res.status}` }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, message: error?.name === 'TimeoutError' ? '连分发服务超时' : '连不上分发服务' }
  }
}

/* ------------------------------------------------------------ 插件 */

export class DistDeploy extends plugin {
  constructor () {
    super({
      name: '王者服务端分发运维',
      dsc: '部署分发服务 / 签发部署令牌（观战和营地消息共用一套地址和令牌）',
      event: 'message',
      priority: 0,
      rule: [
        { reg: '^#营地分发部署$', fnc: 'deploy', permission: 'master' },
        { reg: '^#营地分发服务$', fnc: 'status', permission: 'master' },
        { reg: `^#营地分发地址\\s*(\\S+)$`, fnc: 'setUrl', permission: 'master' },
        { reg: '^#营地分发管理密钥\\s*(\\S+)$', fnc: 'setAdminSecret', permission: 'master' },
        { reg: `${AT_HEAD}#营地分发发令牌\\s*(.*)$`, fnc: 'issue', permission: 'master' },
        { reg: '^#营地分发接入方$', fnc: 'clients', permission: 'master' },
        { reg: '^#营地分发吊销\\s*(\\d+)$', fnc: 'revoke', permission: 'master' }
      ]
    })
  }

  /** 群里执行时把详情走私聊，群里只留一句 */
  async replySafely (e, text, { hint } = {}) {
    if (!e.isGroup) return e.reply(text, shouldQuote())
    const delivered = await sendMaster(text)
    await e.reply(
      delivered
        ? (hint || '结果里有密钥，已经私聊发你了')
        : '⚠️ 私聊发不出去（机器人可能没加你好友），改成私聊我再来一次吧',
      shouldQuote()
    )
    return undefined
  }

  /** 管理接口的入口：本机优先，其次用配置的地址+密钥（分发服务跑在别的机器上时） */
  readServer () {
    const env = readEnvFile()
    if (env.GOK_DIST_ADMIN_SECRET) {
      const port = Number(env.GOK_DIST_PORT) || DEFAULT_PORT
      return { base: `http://127.0.0.1:${port}`, port, adminSecret: env.GOK_DIST_ADMIN_SECRET, remote: false }
    }
    const c = cfg()
    const url = String(c.distUrl || '').trim().replace(/\/+$/, '')
    const secret = String(c.distAdminSecret || '').trim()
    if (url && secret) return { base: url, port: null, adminSecret: secret, remote: true }
    return null
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
        '没找到 git，拉不了分发服务的代码。装好 git（重开云崽让它认出新的 PATH）再来',
        shouldQuote()
      )
    }

    const running = pm2Proc(PROC_NAME)
    if (running && !isOurProcess(running, SERVER_DIR)) {
      return e.reply([
        `有个叫 ${PROC_NAME} 的 pm2 进程，但跑的不是本插件的分发服务，没有动它。`,
        `（它的目录是 ${running.pm2_env?.pm_cwd || '未知'}）`
      ].join('\n'), shouldQuote())
    }

    const restarting = Boolean(running)
    await e.reply(restarting ? '正在重启分发服务…' : '正在部署分发服务，几十秒就好…', shouldQuote())

    try {
      // ① 拉代码（私库的 dist 分支）
      const repo = String(cfg().distRepoUrl || DEFAULT_REPO).trim()
      const fetched = this.fetchServerCode(repo)
      if (!fetched.ok && !fs.existsSync(ENTRY_FILE)) {
        throw new Error(
          `拉取分发服务代码失败：${fetched.err || '未知原因'}\n` +
          `· 私库地址对不对（现在是 ${repo}）\n` +
          '· 这台机器能不能访问它（私库要凭证）'
        )
      }

      // ② 密钥与配置。已有的一律复用 —— 换管理密钥等于之前发出去的令牌全要重发
      const existing = readEnvFile()
      const keys = {
        GOK_DIST_PORT: existing.GOK_DIST_PORT || String(DEFAULT_PORT),
        GOK_DIST_HOST: existing.GOK_DIST_HOST ?? '',
        GOK_DIST_ADMIN_SECRET: existing.GOK_DIST_ADMIN_SECRET || crypto.randomBytes(32).toString('hex'),
        GOK_DIST_REPO: existing.GOK_DIST_REPO || PluginPath,
        GOK_DIST_PACKAGES: existing.GOK_DIST_PACKAGES ||
          'watch=watch-server,im=im-server|camp-im-server.js+lib/xxtea.js',
        GOK_DIST_TRUST_PROXY: existing.GOK_DIST_TRUST_PROXY ?? '',
        GOK_DIST_CACHE_KEEP: existing.GOK_DIST_CACHE_KEEP || '5',
        // 共享库：配了才能「代签」出一个通吃三套的令牌
        GOK_DIST_SHARE_URL: existing.GOK_DIST_SHARE_URL || String(cfg().shareApiUrl || '').trim(),
        GOK_DIST_SHARE_ADMIN: existing.GOK_DIST_SHARE_ADMIN || String(cfg().shareAdminSecret || '').trim()
      }
      writeEnvFile(keys)

      // ③ 起进程
      const startup = restarting
        ? pm2(['restart', PROC_NAME, '--update-env'], { timeout: 60000 })
        : pm2(['start', ENTRY_FILE, '--name', PROC_NAME, '--interpreter', 'node', '--cwd', SERVER_DIR], { timeout: 60000 })
      if (!startup.ok) {
        throw new Error(`pm2 ${restarting ? '重启' : '启动'}失败：${startup.err || startup.out || '未知原因'}`)
      }

      const saved = pm2(['save'], { timeout: 30000 })
      if (!saved.ok) logger.warn(`[${PluginName}] pm2 save 失败，开机自启可能没生效：${saved.err || saved.out}`)

      const port = Number(keys.GOK_DIST_PORT) || DEFAULT_PORT
      const health = await waitHealth(port)
      if (!health) {
        const logs = pm2(['logs', PROC_NAME, '--lines', '15', '--nostream'], { timeout: 20000 })
        logger.error(`[${PluginName}] 分发服务起了但健康检查不通：${logs.out || logs.err}`)
        throw new Error('进程起了但健康检查没通，日志在 pm2 里')
      }

      resetPm2Cache()
      logger.mark(`[${PluginName}] 分发服务已${restarting ? '重启' : '部署'}：127.0.0.1:${port}`)

      const lines = [
        `✅ 分发服务${restarting ? '已重启' : '部署好了'}`,
        '',
        `进程：${PROC_NAME}（pm2 托管，开机自启）`,
        `本机地址：http://127.0.0.1:${port}`,
        `管理密钥：${keys.GOK_DIST_ADMIN_SECRET}`,
        '',
        keys.GOK_DIST_SHARE_URL
          ? `共享库：${keys.GOK_DIST_SHARE_URL}（发出去的令牌能同时部署和接入）`
          : '⚠️ 没配共享库 —— 发出去的令牌只能用于部署，接入不了共享库',
        '',
        '接下来：',
        `1. 把这个地址反代成外网能访问的（端口 ${port}），然后发 #营地分发地址 <外网地址>`,
        `2. 发 #营地分发发令牌 @某人 给他签一个`,
        '',
        '⚠️ 强烈建议上 HTTPS —— 明文 HTTP 下令牌和代码都会明文过网。'
      ]

      return this.replySafely(e, lines.join('\n'))
    } catch (error) {
      logger.error(`[${PluginName}] 部署分发服务失败：${error?.stack || error}`)
      return e.reply(`❌ 部署失败：${error?.message || error}`, shouldQuote())
    }
  }

  /** 把私库的 dist 分支弄到 SERVER_DIR */
  fetchServerCode (repo) {
    const hasGit = fs.existsSync(path.join(SERVER_DIR, '.git'))

    if (!fs.existsSync(SERVER_DIR)) {
      return git(['clone', '--depth', '1', '--branch', SERVER_BRANCH, repo, SERVER_DIR], { timeout: 300000 })
    }
    if (!hasGit) {
      if (!fs.existsSync(ENTRY_FILE)) {
        return {
          ok: false,
          err: `${SERVER_DIR} 已经存在，但里面没有 bin/start.mjs —— 看不出是本插件的目录，不敢动它`
        }
      }
      const inited = git(['init'], { cwd: SERVER_DIR })
      if (!inited.ok) return inited
      const remote = git(['remote', 'add', 'origin', repo], { cwd: SERVER_DIR })
      if (!remote.ok && !/already exists/i.test(remote.err)) return remote
    }

    const pulled = git(['fetch', '--depth', '1', 'origin', SERVER_BRANCH], { cwd: SERVER_DIR })
    if (!pulled.ok) return pulled
    // ⚠️ reset --hard 只动被跟踪的文件，.env 和 data/ 冲不掉
    return git(['reset', '--hard', 'FETCH_HEAD'], { cwd: SERVER_DIR })
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const proc = pm2Proc(PROC_NAME)
    const env = readEnvFile()
    const lines = ['📦 服务端分发']

    if (!proc || !isOurProcess(proc, SERVER_DIR)) {
      lines.push('进程：没在跑', '', '发 #营地分发部署 装一个')
      return e.reply(lines.join('\n'), shouldQuote())
    }

    const port = Number(env.GOK_DIST_PORT) || DEFAULT_PORT
    const health = await waitHealth(port, 3000)
    lines.push(`进程：运行中`, `本机地址：http://127.0.0.1:${port}`)
    lines.push(`健康检查：${health ? '正常' : '没响应（看看 pm2 logs）'}`)

    const server = this.readServer()
    if (server) {
      const stats = await adminCall(server.base, server.adminSecret, '/api/v1/admin/stats')
      if (stats.ok) {
        lines.push(`令牌：${stats.data.tokensActive}/${stats.data.tokensTotal} 个在用`)
        lines.push(`共享库：${stats.data.share?.ok ? '已配（令牌可通吃三套）' : `未配（${stats.data.share?.message || '只能用于部署'}）`}`)
        for (const p of stats.data.packages || []) {
          const size = p.size ? `${Math.round(p.size / 1024)} KB` : '还没打包'
          lines.push(`包 ${p.name}：${String(p.sha || '?').slice(0, 8)}（${size}）`)
        }
      } else {
        lines.push(`管理接口：${stats.message}`)
      }
    } else {
      lines.push('管理密钥：没配（发 #营地分发管理密钥 <密钥>）')
    }

    const restarts = Number(proc.pm2_env?.restart_time || 0)
    if (restarts > 0) lines.push(`重启次数：${restarts}${restarts > 5 ? '（有点多，看看日志）' : ''}`)

    return e.reply(lines.join('\n'), shouldQuote())
  }

  /* -------------------------------------------------------- 配置 */

  async setUrl (e) {
    const url = String(e.msg.match(/^#营地分发地址\s*(\S+)$/)?.[1] || '').trim()
    if (!/^https?:\/\/.+/i.test(url)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }
    Config.modify('config', 'distUrl', url.replace(/\/+$/, ''))
    return e.reply(`已设置分发服务地址：${url}`, shouldQuote())
  }

  async setAdminSecret (e) {
    if (e.isGroup) return e.reply('这条指令请私聊发，密钥不能进群', shouldQuote())
    const secret = String(e.msg.match(/^#营地分发管理密钥\s*(\S+)$/)?.[1] || '').trim()
    if (secret.length < 32) {
      return e.reply('密钥看着不对（太短了）。它是分发服务 .env 里的 GOK_DIST_ADMIN_SECRET', shouldQuote())
    }
    Config.modify('config', 'distAdminSecret', secret)
    return e.reply(`已设置管理密钥：${maskToken(secret)}`, shouldQuote())
  }

  /* -------------------------------------------------------- 发令牌 */

  /**
   * 给**别人**签一个部署令牌。两种发法：
   *   `#营地分发发令牌 某某的机器人` —— 拼好「接入那两行」回给主人，主人自己转
   *   `#营地分发发令牌 @某某`        —— 直接私聊发给 TA
   *
   * ⚠️ 令牌**任何情况下都不出现在群里**。
   */
  async issue (e) {
    const note = stripAtText(e.msg).replace(/^#营地分发发令牌\s*/, '').trim()

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

    const label = note || (target ? `${target.name} 的机器人` : '')
    if (!label) {
      return e.reply('加个备注（比如「某某的机器人」），或者 @ 一下要发给谁', shouldQuote())
    }

    const server = this.readServer()
    if (!server) {
      return e.reply(
        '这台管不了分发服务：没在本机部署（#营地分发部署），也没配远程管理' +
        '（#营地分发管理密钥 <密钥>，地址用 #营地分发地址 设的那个）',
        shouldQuote()
      )
    }

    try {
      const created = await adminCall(server.base, server.adminSecret, '/api/v1/admin/tokens', {
        method: 'POST',
        body: { name: label }
      })
      if (!created.ok) throw new Error(created.message)

      const token = created.data.token
      const configured = String(cfg().distUrl || '').trim()
      const url = configured || `http://你的服务器IP:${server.port}`

      const steps = [
        `#营地观战接入 ${url} ${token}`,
        `#营地消息接入 ${url} ${token}`
      ]

      const ownerText = [
        `📮 给「${label}」的部署令牌（只显示这一次，别弄丢）`,
        '',
        token,
        '',
        '把下面两行整段发给对方，让 TA 按需发（装哪个发哪行）：',
        ...steps,
        '',
        configured
          ? '地址用的是你已经配好的那个。'
          : `⚠️ 你还没配过分发服务地址，上面那行里的「你的服务器IP」要换成真实的（带 ${server.port} 端口）。`,
        created.data.origin === 'share'
          ? '这个令牌既能部署观战/消息，也能接入共享库。'
          : '⚠️ 没配共享库，这个令牌只能用于部署。',
        '想看谁在用、或者踢掉谁：#营地分发接入方'
      ].join('\n')

      if (target && configured) {
        const sent = await sendPrivate(target.userId, [
          `🔑 「${label}」的服务端部署令牌（只发这一次，别弄丢）`,
          '',
          '在你的机器人上发下面任意一行（装哪个发哪行）：',
          ...steps
        ].join('\n'), { bot: e.bot })

        if (sent.ok) {
          logger.mark(`[${PluginName}] 部署令牌已私聊给 ${target.userId}：${label}`)
          return e.reply(`已经把「${label}」的令牌私聊发给 ${target.name} 了`, shouldQuote())
        }

        logger.mark(`[${PluginName}] 私聊 ${target.userId} 失败（${sent.reason}），令牌改发主人`)
        const delivered = await sendMaster(ownerText)
        return e.reply(
          delivered
            ? `私聊给 ${target.name} 没发出去（TA 多半没开临时会话），令牌已经私聊发给你了，你转给 TA 吧`
            : `私聊给 ${target.name} 发不出去，你的私聊也没成功。你私聊我发一次这条指令，我把令牌发你`,
          shouldQuote()
        )
      }

      logger.mark(`[${PluginName}] 已签发部署令牌：${label}`)
      return this.replySafely(e, ownerText, { hint: '结果里带令牌，已经私聊发你了' })
    } catch (error) {
      logger.error(`[${PluginName}] 签发部署令牌失败：${error?.message || error}`)
      return e.reply(`签发失败：${error?.message || error}`, shouldQuote())
    }
  }

  async clients (e) {
    const server = this.readServer()
    if (!server) return e.reply('这台管不了分发服务，先 #营地分发部署 或者配管理密钥', shouldQuote())

    const r = await adminCall(server.base, server.adminSecret, '/api/v1/admin/tokens')
    if (!r.ok) return e.reply(`连不上分发服务：${r.message}`, shouldQuote())

    const list = r.data.tokens || []
    const active = list.filter(t => t.enabled).length
    const lines = [`👥 已签发的部署令牌（${active} 个在用，共 ${list.length} 个）`, '']

    for (const row of list) {
      lines.push(
        `#${row.id} ${row.name}`,
        `   令牌 ${row.tokenPrefix}… · ${row.enabled ? '在用' : '已吊销'}` +
        ` · 下载 ${row.downloadCount || 0} 次` +
        (row.lastSeenAt ? ` · 最后使用 ${fmtTime(row.lastSeenAt)}` : ' · 从没用过')
      )
    }

    lines.push('', '吊销：#营地分发吊销 <序号>')
    return e.reply(lines.join('\n'), shouldQuote())
  }

  async revoke (e) {
    const id = Number(e.msg.match(/^#营地分发吊销\s*(\d+)$/)?.[1] || 0)
    const server = this.readServer()
    if (!server) return e.reply('这台管不了分发服务，先 #营地分发部署 或者配管理密钥', shouldQuote())

    const r = await adminCall(server.base, server.adminSecret, `/api/v1/admin/tokens/${id}`, { method: 'DELETE' })
    if (!r.ok) return e.reply(`吊销失败：${r.message}`, shouldQuote())

    const lines = [`✅ 已吊销 #${id}（${r.data.name || ''}）`]
    if (r.data.shareRevoked === false) {
      lines.push('⚠️ 共享库那边没销掉（地址或密钥不对），建议手动去销')
    }
    return e.reply(lines.join('\n'), shouldQuote())
  }
}

/** 展示用：08-27 21:43 */
function fmtTime (ts) {
  const n = Number(new Date(ts))
  if (!n) return '—'
  const d = new Date(n)
  const p = v => String(v).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
