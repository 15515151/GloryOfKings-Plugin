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
  AT_HEAD, AT_TAIL, shouldQuote, maskToken,
  readShareConfig, probeShare, isShareReady, getShareStatus, getBoundIds, getCurrentId, pushBind
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

/** 令牌只露头尾，免得在群里贴出去（实现已挪到 utils/shareStore.js，两个 app 共用一份） */

export class ShareBind extends plugin {
  constructor () {
    super({
      name: '王者营地ID共享',
      dsc: '把营地ID绑定共享到公共库，跨机器人免重复绑定',
      event: 'message',
      // 和插件其他新指令一致用 0：queryGameStats 的战绩正则是宽匹配，抢在它前面更稳
      priority: 0,
      rule: [
        // 这四条里夹着个 `ID`，用户手打多半是小写 —— 一律带 `i` 放宽（跟登录指令一个口径）
        { reg: new RegExp(`${AT_HEAD}#(开启|打开)营地(ID)?共享${AT_TAIL}`, 'i'), fnc: 'enable' },
        { reg: new RegExp(`${AT_HEAD}#(关闭|取消)营地(ID)?共享${AT_TAIL}`, 'i'), fnc: 'disable' },
        { reg: new RegExp(`${AT_HEAD}#营地(ID)?共享(状态|情况)${AT_TAIL}`, 'i'), fnc: 'status' },
        // 重传一次。自动同步有小时级节流、又在后台跑，用户觉得「对方查不到我」时
        // 需要一个立刻能按的按钮
        { reg: new RegExp(`${AT_HEAD}#同步营地(ID)?共享${AT_TAIL}`, 'i'), fnc: 'resync' },

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
   * 手动同步：把自己的绑定**直接传上去**。
   *
   * ⚠️ 刻意**不**要求先开 `#开启营地ID共享`，也**不**要求「库里已经有你」。
   * 这条指令本身就是用户的授权动作 —— 而他之所以要按它，多半正是因为库里还没有他
   * （在 A 机器人上开过共享的人在 B 机器人上按，或者压根没开过、只想推一次）。
   * 要求「先开开关」会把最需要它的那种情况挡在门外。
   *
   * 和「开启共享」的区别：开启是**持续**的（以后改绑定会自动跟着同步），
   * 这条只推**这一次**。
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

    const result = await pushBind(qq, ids, getCurrentId(qq) || '')
    if (!result.ok) {
      return e.reply(`同步失败：${result.message}`, shouldQuote())
    }

    const lines = [`已把你的 ${result.count} 个营地ID 传到共享库，别的机器人现在就能查到。`]

    // 一次性推和「开着共享」是两回事，得说清楚，不然他改完绑定发现没跟着变会困惑
    if (!getUserShareState(qq).enabled) {
      lines.push('', '你是手动推的这一次，以后改了绑定不会自动跟过去。')
      lines.push('想一直保持同步，发 #开启营地ID共享。')
    }

    return e.reply(lines.join('\n'), shouldQuote())
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
        '状态：未开启',
        ids.length
          ? '发 #开启营地ID共享 后，你在别的机器人上不用重新绑定'
          : '你还没绑定营地ID，先发 #绑定营地 [营地ID]',
        // 主人也可能是在问「我这台机器上那个共享库服务端怎么样」——那是另一条指令，
        // 两条只差一个「库」字，不点一句他很容易以为自己发错了
        e.isMaster ? '（服务端状态发 #营地共享库状态）' : ''
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
      '#营地共享库发令牌 <备注>    给别人的机器人签一个（@一下群友就直接私聊给 TA）',
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
      '本机要有全局账号（#营地wx全局登录 / #营地QQ全局登录），共享过来的号才查得动。',
      '用户发 #开启营地ID共享 才会传自己的号；推送和排行榜不认共享数据。'
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
      '已经传上去的记录还在库里，要清掉得让库的主人删。'
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
