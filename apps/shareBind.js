/**
 * 营地ID 共享的指令入口。
 *
 * 两组开关，各管各的：
 *   **用户**：`#开启营地ID共享` / `#关闭营地ID共享` —— 默认关，开了才会把自己的
 *   营地ID 传上共享库。这是上传个人信息的功能，默认必须是不共享。
 *   **主人**：`#接入营地共享库` / `#关闭营地共享库` / 地址 / 令牌 —— 决定这台机器人
 *   要不要连某个共享库。没接入时用户那两条指令会直接说「本机器人还没接入」。
 *
 * 命名上刻意和既有的 `#共享营地账号`（apps/accountManager.js，共享的是**登录态**）
 * 拉开距离，以免用户以为开这个等于把账号交出去。
 */
import { Config, PluginName } from '#components'
import {
  AT_HEAD, AT_TAIL, shouldQuote,
  readShareConfig, probeShare, isShareReady, getShareStatus, getBoundIds, reconcileNow
} from '#utils'
import { enableSharing, disableSharing, getUserShareState } from '../utils/shareUsers.js'
import { markDeclined, clearDeclined } from '../utils/shareNotifyState.js'

/** 展示用：08-27 21:43 */
const fmtTime = ts => {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 令牌只露头尾，免得在群里贴出去 */
const maskToken = token => {
  const text = String(token || '')
  if (text.length <= 10) return text ? '已配置' : '未配置'
  return `${text.slice(0, 6)}…${text.slice(-4)}`
}

export class ShareBind extends plugin {
  constructor () {
    super({
      name: '王者营地ID共享',
      dsc: '把营地ID绑定共享到公共库，跨机器人免重复绑定',
      event: 'message',
      // 和插件其他新指令一致用 0：queryGameStats 的战绩正则是宽匹配，抢在它前面更稳
      priority: 0,
      rule: [
        { reg: `${AT_HEAD}#(开启|打开)营地(ID)?共享${AT_TAIL}`, fnc: 'enable' },
        { reg: `${AT_HEAD}#(关闭|取消)营地(ID)?共享${AT_TAIL}`, fnc: 'disable' },
        { reg: `${AT_HEAD}#营地(ID)?共享(状态|情况)${AT_TAIL}`, fnc: 'status' },
        // 重传一次。自动同步有小时级节流、又在后台跑，用户觉得「对方查不到我」时
        // 需要一个立刻能按的按钮
        { reg: `${AT_HEAD}#同步营地(ID)?共享${AT_TAIL}`, fnc: 'resync' },

        { reg: '^#营地共享库$', fnc: 'masterPanel', permission: 'master' },
        { reg: '^#接入营地共享库$', fnc: 'masterEnable', permission: 'master' },
        { reg: '^#关闭营地共享库$', fnc: 'masterDisable', permission: 'master' },
        { reg: '^#营地共享库地址\\s*(\\S+)$', fnc: 'setUrl', permission: 'master' },
        { reg: '^#营地共享库令牌\\s*(\\S+)$', fnc: 'setToken', permission: 'master' }
      ]
    })
  }

  /* ------------------------------------------------------------ 用户侧 */

  async enable (e) {
    // 群里发这条是给自己开的，@ 别人没意义：共享的是「你的 QQ 在别的群里绑过的号」
    const result = await enableSharing(e.user_id)
    if (!result.ok) return e.reply(result.message, shouldQuote())

    return e.reply([
      `✅ 已开启营地ID共享（${result.count} 个营地ID）`,
      '以后你在别的机器人上不用重新绑定。',
      '想取消就发 #关闭营地ID共享'
    ].join('\n'), shouldQuote())
  }

  async disable (e) {
    const result = await disableSharing(e.user_id)
    if (!result.ok) return e.reply(result.message, shouldQuote())

    return e.reply([
      '已关闭营地ID共享，之前传上去的也删了。',
      '别的机器人几秒内就看不到了。'
    ].join('\n'), shouldQuote())
  }

  /**
   * 手动重传一次。
   *
   * 自动同步是后台跑的、还带一小时节流，用户「我明明开了共享对方却查不到」时
   * 需要一个立刻能按的按钮 —— 尤其是他刚在别处改完绑定、不想等的时候。
   *
   * ⚠️ 判据是**「库里有没有你」**，不是「本机开没开共享」：用户在 A 机器人上开的共享，
   * 到 B 机器人上想手动推一次也该认 —— B 的本地开关本来就该是关的（他从没在 B 开过）。
   * 用本地开关判断会把「已经接入的人」挡在外面，这跟对账那边的判据也不一致。
   */
  async resync (e) {
    if (!isShareReady()) {
      return e.reply('本机器人还没接入营地ID共享库，请主人发 #营地共享库', shouldQuote())
    }

    const qq = String(e.user_id)
    const ids = getBoundIds(qq)
    if (!ids.length) {
      return e.reply('你还没有绑定营地ID，先发 #绑定营地 [营地ID]', shouldQuote())
    }

    // reconcileNow 内部就是「查库 → 在册就把本机这组传上去」，正是手动同步要的语义。
    // 它还会顺手维护「这个人开过共享」的标记，后续自动同步也跟着通了
    const result = await reconcileNow(qq)

    if (result === 'not-shared') {
      return e.reply('你还没开启共享，先发 #开启营地ID共享', shouldQuote())
    }
    if (result === 'failed') {
      return e.reply('连不上共享库，稍后再试', shouldQuote())
    }

    return e.reply(`已同步 ${ids.length} 个营地ID 到共享库，别的机器人现在就能查到。`, shouldQuote())
  }

  async status (e) {
    if (!isShareReady()) {
      return e.reply('本机器人还没接入营地ID共享库，请主人发 #营地共享库 看看', shouldQuote())
    }

    const qq = String(e.user_id)
    const state = getUserShareState(qq)
    const ids = getBoundIds(qq)

    if (!state.enabled) {
      return e.reply([
        '🏷 营地ID共享状态',
        '状态：未开启（默认就是不共享）',
        ids.length
          ? '发了 #开启营地ID共享 之后，你在别的机器人上不用重新绑定'
          : '你还没绑定营地ID，先发 #绑定营地 [营地ID]',
        // 主人也可能是在问「我这台机器上那个共享库服务端怎么样」——那是另一条指令，
        // 两条只差一个「库」字，不点一句他很容易以为自己发错了
        e.isMaster ? '（想看本机共享库服务端的状态，发 #营地共享库状态）' : ''
      ].filter(Boolean).join('\n'), shouldQuote())
    }

    return e.reply([
      '🏷 营地ID共享状态',
      '状态：已开启',
      `共享的营地ID：${ids.length ? ids.join('、') : '—'}`,
      `上次同步：${fmtTime(state.updatedAt)}`,
      '取消共享发 #关闭营地ID共享'
    ].join('\n'), shouldQuote())
  }

  /* ------------------------------------------------------------ 主人侧 */

  async masterPanel (e) {
    const cfg = readShareConfig()
    const ready = isShareReady()
    const runtime = getShareStatus()

    const lines = [
      '🗂 营地共享库',
      `接入状态：${ready ? '已接入' : '未接入'}${cfg.enabled && !ready ? '（开关开着但配置不全）' : ''}`,
      `地址：${cfg.apiUrl || '未填'}`,
      `令牌：${maskToken(cfg.token)}`
    ]

    if (ready) {
      lines.push(`本机缓存：${runtime.cachedCount} 条`)
      lines.push(`连通性：${runtime.circuitOpen ? '暂时不可用（自动重试中）' : '正常'}`)
    }

    lines.push(
      '',
      '接入某个库（自己搭的或别人的）：',
      '#营地共享库地址 <地址>',
      '#营地共享库令牌 <令牌>',
      '#接入营地共享库 / #关闭营地共享库',
      '',
      '自己搭一个：',
      '#营地共享库部署            一键装好（pm2 托管）',
      '#营地共享库状态            服务端跑没跑、库里多少人',
      '#营地共享库接入方          看谁在用你的库',
      '#营地共享库发令牌 <备注>    给别人的机器人签一个',
      '#营地共享库吊销 <序号>      踢掉某个接入方',
      '#营地共享库卸载            停掉服务（密钥和数据保留）'
    )

    return e.reply(lines.join('\n'), shouldQuote())
  }

  async masterEnable (e) {
    const cfg = readShareConfig()
    if (!cfg.apiUrl) {
      return e.reply('先发 #营地共享库地址 <地址> 设置共享库地址', shouldQuote())
    }
    if (!cfg.token) {
      return e.reply('先发 #营地共享库令牌 <令牌> 设置令牌', shouldQuote())
    }

    // 先试连再落盘：配置写错了要当场知道，而不是等用户发指令时才发现
    const probe = await probeShare(cfg)
    if (!probe.ok) {
      return e.reply(`接入失败：${probe.message}`, shouldQuote())
    }

    Config.modify('config', 'shareEnabled', true)
    // 主人重新接入了，把「他以前说过不要」的标记撤掉，以后更新照常提醒
    clearDeclined()
    logger.mark(`[${PluginName}] 已接入营地ID共享库：${cfg.apiUrl}`)

    return e.reply([
      '✅ 已接入营地ID共享库',
      probe.message,
      '',
      '接下来：',
      '· 用户发 #开启营地ID共享 才会把自己的营地ID传上去（默认不传）',
      '· 本机需要有可用的全局账号，共享过来的号才查得动（#营地wx全局登录）',
      '· 只有查询指令认共享数据，推送和排行榜仍只认本机绑定'
    ].join('\n'), shouldQuote())
  }

  async masterDisable (e) {
    Config.modify('config', 'shareEnabled', false)
    // 记一笔「主人明确不要」，以后版本更新就不再主动提醒他了。
    // 想反悔随时发 #营地共享库 看状态（那条路径一直都在）
    markDeclined()
    logger.mark(`[${PluginName}] 已关闭营地ID共享库接入`)

    return e.reply([
      '已关闭营地ID共享库接入。',
      '本机不再上传、也不再查询共享数据。已经传上去的记录还留在库里，',
      '要清掉的话得让库的主人删，或者重新接入后各自发 #关闭营地ID共享。'
    ].join('\n'), shouldQuote())
  }

  async setUrl (e) {
    const url = String(e.msg.match(/^#营地共享库地址\s*(\S+)$/)?.[1] || '').trim()

    if (!/^https?:\/\/.+/i.test(url)) {
      return e.reply('地址要以 http:// 或 https:// 开头', shouldQuote())
    }

    Config.modify('config', 'shareApiUrl', url.replace(/\/+$/, ''))
    return e.reply(`已设置共享库地址：${url}\n接着发 #营地共享库令牌 <令牌>，然后 #接入营地共享库`, shouldQuote())
  }

  async setToken (e) {
    const token = String(e.msg.match(/^#营地共享库令牌\s*(\S+)$/)?.[1] || '').trim()

    if (token.length < 8) {
      return e.reply('令牌看着不对（太短了），从共享库主人那里要一个', shouldQuote())
    }

    Config.modify('config', 'shareToken', token)
    // 回显打码：这条指令可能在群里发，令牌不该贴在群聊记录里
    return e.reply(`已设置令牌：${maskToken(token)}\n接着发 #接入营地共享库 试连一次`, shouldQuote())
  }
}
