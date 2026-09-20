/**
 * 营地观战服务端的**一键部署**：#营地观战接入 / #营地观战部署 / #营地观战重装 / #营地观战服务。
 *
 * ## 服务端是什么
 *
 * **一个按平台下发的原生二进制**（Rust 编译）。它从**主人的分发服务**按当前平台取回来：
 * `/latest?target=` 问版本 → `/download` 取密文 → `/key` 取密钥 → AES-256-GCM 解密
 * → sha256 校验 → 解开得 `gok-watch`（契约 §2.2）。
 *
 * ## 为什么不再用 pm2
 *
 * 服务**跟着机器人进程走**：插件 `spawn` 出子进程，机器人退它就退（同一进程组），
 * 插件自己也在 `process.on('exit')` 时 SIGTERM 它。心跳（`/api/v1/lease`）由二进制
 * **自己**发，插件不实现、也不保活 —— 无脑保活会把「令牌被吊销」变成重启风暴（契约 §2.3）。
 *
 * ## 数据为什么不会被更新冲掉
 *
 * 观战的数据在 `<插件>/data/`（录像 `data/watch/recordings`、授权池 `data/AuthPool.json`），
 * 二进制在 `<插件>/server/` —— **两者不重叠**。而且安装是先解到 `server/.staging-*`、
 * 校验通过才 rename 覆盖，失败时旧二进制一个字节都不动。二进制刻意放 `server/`：
 * 它内部按 `<exe_dir>/../data` 找数据目录，正好落回插件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PluginPath, PluginName, Config } from '#components'
import { shouldQuote } from '#utils'
import { detectTarget } from '../utils/platform.js'
import { fetchLatest, installNative, readDistConfig, safeUrl } from '../utils/dist.js'
import { fmtUptime, waitStatus } from '../utils/deploy.js'
import {
  bindRule, bindSummary, binPath, checkUpdate, ensureService, logFile, readLogTail,
  serverDir, servicePort, serviceStatus, startService, stopService
} from '../utils/service.js'

/** 云崽根目录（插件住在 `<根>/plugins/<名字>`，往上两级）—— 只为把路径显示得短一点 */
const YunzaiRoot = path.resolve(PluginPath, '../..')

/** 分发服务上的包名 */
const KIND = 'watch'

/** 引导语：没配分发服务时统一用这句 */
const GROUP_HINT = '进群 972915804 找主人要部署地址和令牌，然后发 #营地观战接入 <地址> <令牌>'

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

/**
 * 「对外地址没配」是部署后最常见的坑：本机能开、群友点了是空的。
 *
 * ⚠️ 这个提示以前写的是「填成外网能访问的域名」就完事，但服务只绑 127.0.0.1 时
 *    填了也没用（外网连不到）。现在绑定地址真的由它决定（见 utils/service.js 的
 *    `bindRule`），所以文案要把「填了会发生什么」一起说清楚。
 */
function publicUrlHintLines () {
  if (String(cfg().watchPublicUrl || '').trim()) return []
  return [
    '',
    '⚠️ 直播间对外地址还没配 —— 现在发出去的链接只有本机能开，群友点了是白屏。',
    `去锅巴面板把「直播间对外地址」填成外网能访问的（域名或公网 IP + 端口），`,
    `比如 http://你的域名:${servicePort(KIND)}。`,
    '填完发一次 #营地观战部署 —— 服务会跟着绑到全网卡（老版本也是这么绑的）。',
    '⚠️ 它是纯 HTTP、没有鉴权，等于把播放页挂到公网，记得放行/限制防火墙。'
  ]
}

/** 目录已经存在、但看不出是我们的东西 → 拒绝动它 */
function looksForeign () {
  const dir = serverDir(KIND)
  if (!fs.existsSync(dir)) return false
  const bin = binPath(KIND)
  const hasState = fs.existsSync(path.join(dir, '.gok-native.json'))
  const hasLegacy = fs.existsSync(path.join(dir, 'watch-server.js'))
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

export class WatchDeploy extends plugin {
  constructor () {
    super({
      name: '王者营地观战运维',
      dsc: '部署 / 查看营地观战服务端（原生二进制，跟着机器人进程）',
      event: 'message',
      // ⚠️ 必须是负的：apps/watchBattle.js 那条宽匹配是 `#(?:营地)?观战\s*(.*)$`，
      //    `#营地观战接入 …` 也会被它吃掉、掉进序号解析里报一句「编号不对」。
      //    云崽按 priority **从小到大**依次执行 fnc，这里抢在它前面 return true，
      //    它就不会再跑。（watchBattle 那边另有一道放行兜底，防 priority 语义变化。）
      priority: -1,
      rule: [
        // 一步到位：写配置 + 立刻部署。主人和群友用的是同一条
        // （群友装了这个插件之后，在他自己那台机器人上就是主人）
        { reg: '^#营地观战接入\\s+(\\S+)\\s+(\\S+)$', fnc: 'connect', permission: 'master' },
        { reg: '^#营地观战部署$', fnc: 'deploy', permission: 'master' },
        // 部署是幂等的（版本没变不重下）。二进制坏了、或者想强刷时用这条
        { reg: '^#营地观战重装$', fnc: 'reinstall', permission: 'master' },
        { reg: '^#营地观战服务$', fnc: 'status', permission: 'master' }
      ]
    })
  }

  /* -------------------------------------------------------- 接入 */

  /**
   * 一步接入：`#营地观战接入 <地址> <令牌>`。
   *
   * **先试连再落盘** —— 地址或令牌写错了要当场知道，而不是等发部署指令时才报错
   * （这条经验是从 shareBind 的 masterEnable 带过来的）。
   */
  async connect (e) {
    const m = /^#营地观战接入\s+(\S+)\s+(\S+)$/.exec(String(e.msg || '').trim())
    if (!m) return e.reply('格式：#营地观战接入 <地址> <令牌>', shouldQuote())

    const rawUrl = m[1].trim()
    const token = m[2].trim()

    if (!/^https?:\/\//i.test(rawUrl)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }
    if (token.length < 20) {
      return e.reply('令牌看着不对（太短了）。' + GROUP_HINT, shouldQuote())
    }

    // 平台先看：macOS / arm32 在这台机器上根本装不了，别等下载失败才发现
    const t = target()
    if (!t.ok) return e.reply(`❌ ${t.message}`, shouldQuote())

    // 试连：问一次版本。失败就不写配置
    const probe = await fetchLatest(KIND, t.target, { url: rawUrl, token })
    if (!probe.ok) {
      return e.reply(
        `连不上分发服务：${probe.message}\n地址和令牌都没错的话，${GROUP_HINT}`,
        shouldQuote()
      )
    }

    // ⚠️ 写的是 `shareApiUrl` + `distToken`：合并之后三套（共享库 / 观战 / 消息）
    //    共用同一个地址和令牌，锅巴里也只有这两处填写口。老的 distUrl / shareToken
    //    只在**读取**时作回退，别再把新值写回废弃字段
    Config.modify('config', 'shareApiUrl', rawUrl.replace(/\/+$/, ''))
    Config.modify('config', 'distToken', token)
    logger.mark(`[${PluginName}] 已接入分发服务：${safeUrl(rawUrl)}`)

    // 落盘成功 → 直接接着部署，群友不用再发一条
    return this.deploy(e, { adopted: true })
  }

  /* -------------------------------------------------------- 部署 */

  /** `#营地观战部署`：版本没变就不重下，只重启（契约 §2.2 第③步） */
  async deploy (e, { adopted = false } = {}) {
    return this.installAndStart(e, { adopted, force: false })
  }

  /** `#营地观战重装`：强制重新下载安装。二进制坏了 / 想强刷时用 */
  async reinstall (e) {
    return this.installAndStart(e, { adopted: false, force: true })
  }

  /**
   * 部署 / 重装的真身。
   *
   * @param {object} opts
   * @param {boolean} opts.adopted 是不是刚 `#营地观战接入` 完顺手调的
   * @param {boolean} opts.force   强制重下
   */
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
        `${path.relative(YunzaiRoot, serverDir(KIND))} 已经存在，但里面没有 gok-watch —— ` +
        '看不出是本插件的目录，不敢动它。确认没用了就手动删掉再部署',
        shouldQuote()
      )
    }

    const before = await serviceStatus(KIND)
    const restarting = before.running || before.alive

    await e.reply(
      force
        ? '正在重新安装观战服务（强制重新下载，几十秒就好）…'
        : restarting
          ? '正在更新观战服务…'
          : '正在部署观战服务（要从分发服务下载二进制），几十秒就好…',
      shouldQuote()
    )

    try {
      // 老布局遗留：以前这里住的是 JS 源码（git 浅克隆 / 明文包）。不删它，
      // 但也不再用它 —— 状态里会认出来并提示这是老的 JS 服务
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

      // 解完再校验一遍：文件不在就别硬起，免得半死不活
      const bin = installNativeBin(installed.target)
      if (!bin) {
        throw new Error(`装完找不到二进制：${path.relative(PluginPath, binPath(KIND, installed.target) || '')}`)
      }

      // 先停旧的，再起新的：同一个端口上留着旧进程的话新的绑不上。
      // 停不掉就直说，不要「起了但没生效」那种假成功
      const stopped = await stopService(KIND, { logger })
      if (!stopped.ok) {
        throw new Error(stopped.message || '旧的观战服务停不下来，先手动处理一下再试')
      }

      const started = startService(KIND, { logger })
      if (!started.ok) throw new Error(started.message)

      const port = servicePort(KIND)
      const health = await waitStatus(port, '/api/status', 25000)
      if (!health) {
        const tail = logTailText()
        logger.error(`[${PluginName}] 观战服务起了但状态接口不通：\n${tail}`)
        throw new Error(
          `服务进程起来了（PID ${started.pid}）但状态接口没通，日志最后几行：\n${tail || '（日志是空的）'}`
        )
      }

      logger.mark(
        `[${PluginName}] 观战服务已${restarting ? '重启' : '部署'}：127.0.0.1:${port}` +
        `（${serverDir(KIND)}，版本 ${installed.sha}${installed.updated ? '' : '，已是最新'})`
      )

      const lines = [
        `✅ 观战服务${restarting ? '已更新' : '部署好了'}`,
        '',
        `进程：PID ${started.pid}（跟着机器人走，不保活、不开机自启）`,
        // 把「监听在哪」直接摊开：填了外网地址却只绑回环，是这轮最容易踩的坑
        `监听：${bindSummary(KIND)}`,
        `版本：${installed.sha}`,
        `账号：${health.accounts ?? 0} 个，还能开 ${health.free ?? 0} 路`
      ]

      if (!installed.updated && restarting) {
        lines.push('', '版本本来就是最新的，只重启了一遍。')
      }

      if (!health.ffmpeg) {
        lines.push('', '⚠️ 这台机器上没找到 ffmpeg，取流会失败。装好之后发一次 #营地观战部署')
      }

      lines.push(...publicUrlHintLines())
      if (!bindRule(KIND).bindAll) {
        lines.push('', '（要让群友看直播就把「直播间对外地址」填好再部署一次，见上面提示）')
      }
      lines.push('', '看谁在打：发 #营地观战')

      return e.reply(lines.join('\n'), shouldQuote())
    } catch (error) {
      logger.error(`[${PluginName}] 部署观战服务失败：${error?.stack || error}`)
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
      return e.reply(['🛰 营地观战服务', '', `❌ ${t.message}`].join('\n'), shouldQuote())
    }

    const st = await serviceStatus(KIND)
    const lines = ['🛰 营地观战服务', '']

    if (st.legacyJs && !st.installed) {
      lines.push('这台装的是**老的 JS 服务**（server/watch-server.js）—— 它已经不再被启动，')
      lines.push('二进制版本才是现在的服务端。发 #营地观战部署 换过来（旧文件不会删）。')
      return e.reply(lines.join('\n'), shouldQuote())
    }

    if (!st.installed) {
      lines.push('服务端：还没装', '', `发 #营地观战部署 装一个（${GROUP_HINT}）`)
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
    lines.push(`监听：${bindSummary(KIND)}`)

    if (!st.alive) {
      lines.push(
        st.running
          ? '状态接口：没响应（进程在但连不上，多半是租约没换到或被吊销了）'
          : '状态接口：没响应（进程不在）'
      )
      const tail = logTailText()
      if (tail) lines.push('', '日志最后几行：', tail)
      else lines.push('', `日志还是空的：${path.relative(YunzaiRoot, logFile(KIND))}`)
      lines.push('', '重起一次：#营地观战部署（版本没变只重启，不重下）')
      return e.reply(lines.join('\n'), shouldQuote())
    }

    const s = st.status
    lines.push(`ffmpeg：${s.ffmpeg ? '就绪' : '没找到（装好再发 #营地观战部署）'}`)
    // 「还能开 N 路」数的是**好友里能看的**，和账号总数不是一个量纲 —— 并排写容易误读
    lines.push(`账号：${s.accounts ?? 0} 个（其中 ${(s.watchers || []).length} 个有好友可看），还能开 ${s.free ?? 0} 路`)
    lines.push(`在播：${(s.rooms || []).length} 路${s.recording ? '（有在录）' : ''}`)

    // 只提示，不自动更新（自动更新会在运行期重启别人正在看的直播）
    const up = await checkUpdate(KIND)
    if (up.ok && up.hasNew) {
      lines.push('', `⬆️ 服务器上有新版本 ${up.sha}（这台在跑 ${up.current}）`, '要更新就发 #营地观战部署')
    } else if (!up.ok && up.message) {
      lines.push('', `（查版本失败：${up.message}）`)
    }

    lines.push(...publicUrlHintLines())

    return e.reply(lines.join('\n'), shouldQuote())
  }
}

/** 装完之后再确认一次二进制真的在（平台不支持时 binPath 会返回 null） */
function installNativeBin (tgt) {
  const bin = binPath(KIND, tgt)
  return bin && fs.existsSync(bin) ? bin : null
}

// 启动后接管已经装好的服务：模块顶层排一次，**不放 constructor**。
// Yunzai 的 loader 每收到一条消息都会给每个 plugin 类 new 一个实例，
// 写在 constructor 里等于每条消息都 spawn 一次（apps/cacheManager.js 有同一段教训）。
// 只拉起已装的，不下载、不查版本；没装就静默跳过。
setTimeout(() => {
  ensureService(KIND, { logger }).catch(error => {
    logger.debug(`[${PluginName}] 观战服务自动接管跳过：${error?.message || error}`)
  })
}, 20 * 1000).unref?.()
