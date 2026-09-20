/**
 * 营地消息服务端的**一键部署**：#营地消息接入 / #营地消息部署 / #营地消息重装 / #营地消息服务。
 *
 * ## 服务端是什么
 *
 * 和观战一样，是**按平台下发的原生二进制**（`gok-im`），从主人的分发服务取回：
 * `/latest?target=` → `/download` → `/key` → AES-256-GCM 解密 → sha256 校验
 * → 解开得单文件（契约 §2.2）。
 *
 * ## 为什么部署在插件目录里
 *
 * 服务端要读写 `<插件>/data/AuthPool.json`（授权池）。默认它按 cwd 找
 * `<cwd>/data/AuthPool.json`，所以插件这边**显式**传 `GOK_AUTH_POOL`
 * （见 utils/service.js 的 buildEnv）—— 观战二进制的默认是 `<exe_dir>/../data`，
 * 两者默认值不一样，不显式传就会读到一个空的池子。
 *
 * ## 为什么不落 `<exe_dir>/../data`
 *
 * 消息服务的二进制放 `server-im/`，数据仍在插件 `data/`：和 `server/` 观战对齐，
 * 也不会和插件本体的东西重叠。
 *
 * ## 三条硬规矩（和 watchDeploy 同源）
 *
 * 1. **认不出就不动**：`server-im/` 存在、没台账、也没老 JS 入口 → 拒绝，让主人确认。
 * 2. **失败保留旧版**：安装全程在 `.staging-*` 里，校验通过才 rename 覆盖。
 * 3. **不保活**：进程退了只记日志；心跳由二进制自己发。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginPath, PluginName, Config } from '#components'
import { shouldQuote } from '#utils'
import { detectTarget } from '../utils/platform.js'
import { fetchLatest, installNative, readDistConfig, safeUrl } from '../utils/dist.js'
import { fmtUptime, waitStatus } from '../utils/deploy.js'
import {
  bindSummary, binPath, checkUpdate, ensureService, logFile, readLogTail, serverDir,
  servicePort, serviceStatus, startService, stopService
} from '../utils/service.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级）—— 只为把路径显示得短一点 */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/** 分发服务上的包名 */
const KIND = 'im'

/** 老 JS 布局的入口文件名，只用来识别「这台装的是老服务」 */
const LEGACY_ENTRY = 'camp-im-server.js'

/** 引导语：没配分发服务时统一用这句 */
const GROUP_HINT = '进群 972915804 找主人要部署地址和令牌，然后发 #营地消息接入 <地址> <令牌>'

/* ------------------------------------------------------------ 小工具 */

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/** 本机平台 → 三元组。不支持时把错误原文交给调用方去回话 */
function target () {
  try {
    return { ok: true, target: detectTarget() }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}

/** 目录已经存在、但看不出是我们的东西 → 拒绝动它 */
function looksForeign () {
  const dir = serverDir(KIND)
  if (!fs.existsSync(dir)) return false
  const bin = binPath(KIND)
  const hasState = fs.existsSync(path.join(dir, '.gok-native.json'))
  const hasLegacy = fs.existsSync(path.join(dir, LEGACY_ENTRY))
  return !hasState && !hasLegacy && !(bin && fs.existsSync(bin))
}

/** 日志最后几行拼成一段。没有日志返回空串 */
function logTailText (n = 12) {
  return readLogTail(KIND, n).join('\n')
}

function fmtBytes (n) {
  return n ? `${(n / 1024 / 1024).toFixed(1)} MB` : '大小未知'
}

function binSize (file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/* ------------------------------------------------------------ 插件 */

export class CampImDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地消息运维',
      dsc: '部署 / 查看营地消息服务端（原生二进制，跟着机器人进程）',
      event: 'message',
      // ⚠️ 必须是负的：`#营地消息` 那条规则是精确匹配 `^#营地消息$`，
      //    `#营地消息部署` 不会被它吃掉，但保险起见和 watchDeploy 保持一致。
      priority: -1,
      rule: [
        // 一步到位：写配置 + 立刻部署。主人和群友用的是同一条
        // （群友装了这个插件之后，在他自己那台机器人上就是主人）
        { reg: '^#营地消息接入\\s+(\\S+)\\s+(\\S+)$', fnc: 'connect', permission: 'master' },
        { reg: '^#营地消息部署$', fnc: 'deploy', permission: 'master' },
        // 部署是幂等的（版本没变不重下）。二进制坏了、或者想强刷时用这条
        { reg: '^#营地消息重装$', fnc: 'reinstall', permission: 'master' },
        { reg: '^#营地消息服务$', fnc: 'status', permission: 'master' }
      ]
    })
  }

  /* -------------------------------------------------------- 接入 */

  /**
   * 一步接入：`#营地消息接入 <地址> <令牌>`。
   *
   * **先试连再落盘** —— 地址或令牌写错了要当场知道，而不是等发部署指令时才报错。
   */
  async connect (e) {
    const m = /^#营地消息接入\s+(\S+)\s+(\S+)$/.exec(String(e.msg || '').trim())
    if (!m) return e.reply('格式：#营地消息接入 <地址> <令牌>', shouldQuote())

    const rawUrl = m[1].trim()
    const token = m[2].trim()

    if (!/^https?:\/\//i.test(rawUrl)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }
    if (token.length < 20) {
      return e.reply('令牌看着不对（太短了）。' + GROUP_HINT, shouldQuote())
    }

    // 平台先看：macOS / arm32 在这台机器上根本装不了
    const t = target()
    if (!t.ok) return e.reply(`❌ ${t.message}`, shouldQuote())

    const probe = await fetchLatest(KIND, t.target, { url: rawUrl, token })
    if (!probe.ok) {
      return e.reply(
        `连不上分发服务：${probe.message}\n地址和令牌都没错的话，${GROUP_HINT}`,
        shouldQuote()
      )
    }

    // ⚠️ 同 watchDeploy：写 `shareApiUrl` + `distToken`（三套共用一个令牌）
    Config.modify('config', 'shareApiUrl', rawUrl.replace(/\/+$/, ''))
    Config.modify('config', 'distToken', token)
    logger.mark(`[${PluginName}] 已接入分发服务：${safeUrl(rawUrl)}`)

    return this.deploy(e, { adopted: true })
  }

  /* -------------------------------------------------------- 部署 */

  /** `#营地消息部署`：版本没变就不重下，只重启 */
  async deploy (e, { adopted = false } = {}) {
    return this.installAndStart(e, { adopted, force: false })
  }

  /** `#营地消息重装`：强制重新下载安装 */
  async reinstall (e) {
    return this.installAndStart(e, { adopted: false, force: true })
  }

  async installAndStart (e, { adopted = false, force = false } = {}) {
    const t = target()
    if (!t.ok) return e.reply(`❌ ${t.message}`, shouldQuote())

    const { url, token } = readDistConfig()
    if (!url || !token) {
      return e.reply(
        adopted ? '配置没写进去，重发一次试试' : `还没接入分发服务。${GROUP_HINT}`,
        shouldQuote()
      )
    }

    if (looksForeign()) {
      return e.reply(
        `${path.relative(YunzaiRoot, serverDir(KIND))} 已经存在，但里面没有 gok-im —— ` +
        '看不出是本插件的目录，不敢动它。确认没用了就手动删掉再部署',
        shouldQuote()
      )
    }

    const before = await serviceStatus(KIND)
    const restarting = before.running || before.alive

    await e.reply(
      force
        ? '正在重新安装营地消息服务（强制重新下载，几十秒就好）…'
        : restarting
          ? '正在更新营地消息服务…'
          : '正在部署营地消息服务（要从分发服务下载二进制），几十秒就好…',
      shouldQuote()
    )

    try {
      // 老布局遗留的 .git（以前是浅克隆）。不删它也不会用，清掉免得困惑
      const oldGit = path.join(serverDir(KIND), '.git')
      if (fs.existsSync(oldGit)) {
        try {
          fs.rmSync(oldGit, { recursive: true, force: true })
          logger.mark(`[${PluginName}] 清掉旧的 .git（服务端现在是原生二进制）`)
        } catch (error) {
          logger.warn(`[${PluginName}] 清旧 .git 失败（不影响部署）：${error?.message || error}`)
        }
      }

      const installed = await installNative({
        name: KIND,
        destDir: serverDir(KIND),
        url,
        token,
        force,
        logger
      })
      if (!installed.ok) {
        throw new Error(`${installed.message}\n如果地址令牌没问题，${GROUP_HINT}`)
      }

      const bin = binPath(KIND, installed.target)
      if (!bin || !fs.existsSync(bin)) {
        throw new Error(`装完找不到二进制：${bin ? path.relative(PluginPath, bin) : '（平台不支持）'}`)
      }

      const stopped = await stopService(KIND, { logger })
      if (!stopped.ok) {
        throw new Error(stopped.message || '旧的营地消息服务停不下来，先手动处理一下再试')
      }

      const started = startService(KIND, { logger })
      if (!started.ok) throw new Error(started.message)

      const port = servicePort(KIND)
      const health = await waitStatus(port, '/api/status', 25000)
      if (!health) {
        const tail = logTailText()
        logger.error(`[${PluginName}] 营地消息服务起了但状态接口不通：\n${tail}`)
        throw new Error(
          `服务进程起来了（PID ${started.pid}）但状态接口没通，日志最后几行：\n${tail || '（日志是空的）'}`
        )
      }

      logger.mark(
        `[${PluginName}] 营地消息服务已${restarting ? '重启' : '部署'}：127.0.0.1:${port}` +
        `（${serverDir(KIND)}，版本 ${installed.sha}${installed.updated ? '' : '，已是最新'})`
      )

      const clients = health.clients || []
      const online = clients.filter(c => c.state === 'online').length
      const lines = [
        `✅ 营地消息服务${restarting ? '已更新' : '部署好了'}`,
        '',
        `进程：PID ${started.pid}（跟着机器人走，不保活、不开机自启）`,
        // 消息服务是纯本机后端（插件每 campImPollMs 轮询它），**不该对外**
        `监听：${bindSummary(KIND)} —— 这个是本机后端，不用对外`,
        `版本：${installed.sha}`,
        `账号：${online}/${clients.length} 在线`
      ]

      if (!clients.length) {
        lines.push('', '还没有可用的营地账号', '发 #营地wx全局登录 扫码添加')
      }

      if (!installed.updated && restarting) {
        lines.push('', '版本本来就是最新的，只重启了一遍。')
      }

      lines.push('', '看状态：发 #营地消息')

      return e.reply(lines.join('\n'), shouldQuote())
    } catch (error) {
      logger.error(`[${PluginName}] 部署营地消息服务失败：${error?.stack || error}`)
      return e.reply(
        `❌ 部署失败：${error?.message || error}\n\n（旧的服务和旧的二进制都没有被动过）`,
        shouldQuote()
      )
    }
  }

  /* -------------------------------------------------------- 状态 */

  async status (e) {
    const t = target()
    if (!t.ok) {
      return e.reply(['📨 营地消息服务', '', `❌ ${t.message}`].join('\n'), shouldQuote())
    }

    const st = await serviceStatus(KIND)
    const lines = ['📨 营地消息服务', '']

    if (st.legacyJs && !st.installed) {
      lines.push(`这台装的是**老的 JS 服务**（server-im/${LEGACY_ENTRY}）—— 它已经不再被启动，`)
      lines.push('二进制版本才是现在的服务端。发 #营地消息部署 换过来（旧文件不会删）。')
      return e.reply(lines.join('\n'), shouldQuote())
    }

    if (!st.installed) {
      lines.push('服务端：还没装', '', `发 #营地消息部署 装一个（${GROUP_HINT}）`)
      return e.reply(lines.join('\n'), shouldQuote())
    }

    lines.push(`服务端：${st.version || '（版本未知）'}`)
    lines.push(`平台：${st.target}`)
    lines.push(`二进制：${path.relative(YunzaiRoot, st.binary)}（${fmtBytes(binSize(st.binary))}）`)
    lines.push(
      st.running
        ? `进程：在跑（PID ${st.pid}，已跑 ${fmtUptime(st.uptimeMs)}）`
        : '进程：没在跑'
    )
    lines.push(`监听：${bindSummary(KIND)} —— 这个是本机后端，不用对外`)

    if (!st.alive) {
      lines.push(
        st.running
          ? '状态接口：没响应（进程在但连不上，多半是租约没换到或被吊销了）'
          : '状态接口：没响应（进程不在）'
      )
      const tail = logTailText()
      if (tail) lines.push('', '日志最后几行：', tail)
      else lines.push('', `日志还是空的：${path.relative(YunzaiRoot, logFile(KIND))}`)
      lines.push('', '重起一次：#营地消息部署（版本没变只重启，不重下）')
      return e.reply(lines.join('\n'), shouldQuote())
    }

    const s = st.status
    const clients = s.clients || []
    const online = clients.filter(c => c.state === 'online').length
    lines.push(`账号：${online}/${clients.length} 在线`)
    if (s.queue) lines.push(`待处理：${s.queue.lastId || 0} 条`)

    // 只提示，不自动更新
    const up = await checkUpdate(KIND)
    if (up.ok && up.hasNew) {
      lines.push('', `⬆️ 服务器上有新版本 ${up.sha}（这台在跑 ${up.current}）`, '要更新就发 #营地消息部署')
    } else if (!up.ok && up.message) {
      lines.push('', `（查版本失败：${up.message}）`)
    }

    return e.reply(lines.join('\n'), shouldQuote())
  }
}

// 启动后接管已经装好的服务：模块顶层排一次，**不放 constructor**。
// Yunzai 的 loader 每收到一条消息都会给每个 plugin 类 new 一个实例，
// 写在 constructor 里等于每条消息都 spawn 一次（apps/cacheManager.js 有同一段教训）。
// 只拉起已装的，不下载、不查版本；没装就静默跳过。
setTimeout(() => {
  ensureService(KIND, { logger }).catch(error => {
    logger.debug(`[${PluginName}] 营地消息服务自动接管跳过：${error?.message || error}`)
  })
}, 20 * 1000).unref?.()
