/**
 * 王者战绩推送 / 开局提醒。
 *
 * 这个功能的配置项（锅巴面板开关 + cron、config.yaml 的 onlineReminder/battleResultCron、
 * index.js 里注册的 GameRecordPush.yaml）在插件里一直存在，但从来没有实现过——
 * 没有任何定时任务，pushList 也没被读过。本文件就是补上那个缺口。
 *
 * 设计要点：
 * - 个人订阅制。用户在群里 #开启战绩推送，只轮询订阅过的人，推到他订阅时所在的那个群。
 *   不做全群自动推送：UserData.yaml 里有 20+ 个绑定用户，全量轮询按 800ms 串行要 20 秒一轮，
 *   而且大部分人并不想被推送。
 * - 三条播报（打完 / 开局 / 上下线）都不 @ 本人，一律把玩家名写进文案：订阅者自己刚打完
 *   那局最清楚，@ 只是给他多刷一条红点，真正需要认人的是群里其他人。
 * - 开局提醒和战绩推送共用同一次请求。实测 isGaming 翻转与新场次进 list 是同一时刻发生的，
 *   拆成两个 task 只会让请求量翻倍、频控风险翻倍。详见 utils/pushStore.js 文件头的实测记录。
 * - 打完一局发的是和 #查询战绩N 同一张详情图（utils/battleDetailImage.js），这需要额外拉一次
 *   battledetail 并走 puppeteer，所以只给最新那局出图；出图失败一律回退纯文字，不能吞掉推送。
 * - 上下线提醒是独立开关，走的是主页接口（另一个端点）。开了它反而更省：profile 的返回体比
 *   战绩列表小一个量级，先查它拿到 gameOnline，就能判断这一轮值不值得再拉战绩列表。
 * - 请求量是自适应的，不是恒定按 cron。这个 task 是插件里唯一的常驻定时任务，营地对总量敏感
 *   （频控 -30107），而离线的号既不会开局也不会出新战绩。两层节流：
 *   ① 该不该拉战绩列表 —— pushStore.needBattleList，零代价，不影响任何提醒；
 *   ② 这一轮该不该查 —— pushStore.resolveNextCheck 按不活跃时长退避，跳过若干轮，
 *      代价是上线播报最坏晚「封顶倍数 × cron」，配置项 idleBackoffMax 填 1 可关掉。
 *
 * 数据层与全部纯计算逻辑在 utils/pushStore.js，这里只管指令交互和消息发送。
 */
import {
  loadPushList,
  savePushList,
  mergeSubState,
  disableSubFlag,
  isFlagOn,
  subGroups,
  withSubGroup,
  withoutSubGroup,
  streakMilestone,
  fetchLatest,
  fetchOnlineState,
  hasOnlineSignal,
  getHeroNameMap,
  calcStreak,
  pickNewBattles,
  diffOnlineState,
  summarizeSession,
  resolveOnlineSince,
  formatBattleText,
  formatGamingText,
  formatOnlineText,
  needBattleList,
  isSubActive,
  resolveNextCheck,
  normalizeName,
  ONLINE_LABEL,
  FETCH_HIDDEN,
  MAX_DETAIL_BATTLES,
  REQUEST_INTERVAL,
  DEFAULT_IDLE_BACKOFF_MAX,
  sleep
} from '../utils/pushStore.js'
import { fetchBattleDetail, renderBattleDetail } from '../utils/battleDetailImage.js'
import { fetchRoleNames } from '../utils/roleName.js'
import { getAllBindings } from '../utils/rankStore.js'
import { membersOfGroup, groupsOfMember, isIndexReady, getGroupIndex, refreshGroupIndex } from '../utils/groupIndex.js'
import { getCurrentId, getLocalImage, Button, shouldQuote, pickGroupSafe, resolveMemberName, isBlackUser } from '#utils'
import { Config } from '#components'

/**
 * 轮询并发锁。订阅多时一轮要几十秒，cron 设得短就会出现上一轮没跑完下一轮又启动，
 * 同一场战绩被两轮同时读到、各推一次。模块级变量足够——一个进程里只有一个 task 实例。
 */
let running = false

export class GameRecordPush extends plugin {
  constructor () {
    super({
      name: '王者战绩推送',
      dsc: '打完自动推战绩，开局提醒',
      event: 'message',
      // 必须比 queryGameStats（priority 1）更优先。它的 `#?(查询|王者)战绩\s*(.*)$` 是宽匹配，
      // 会把 #王者战绩推送 当成「查战绩 推送」吞掉；两者同为 1 时谁先命中取决于模块加载顺序。
      // 这里三条 reg 都是 ^…$ 完整锚定，抢先匹配不会误吞其它指令。
      priority: 0,
      rule: [
        { reg: '^#(开启|关闭)(王者)?战绩推送$', fnc: 'toggle' },
        { reg: '^#(开启|关闭)(王者)?上下线提醒$', fnc: 'toggleOnline' },
        { reg: '^#(开启|关闭)(王者)?在线状态(展示)?$', fnc: 'toggleStatus' },
        { reg: '^#(王者)?战绩推送(状态|列表)?$', fnc: 'status' },
        { reg: '^#清空王者战绩推送$', fnc: 'clearAll', permission: 'master' }
      ]
    })

    // 总开关关闭时给空 task，Yunzai 的 loader 只收集 cron 和 fnc 都有值的项
    const cfg = readConfig()
    this.task = cfg.onlineReminder !== false && cfg.battleResultCron
      ? {
          name: '王者战绩推送',
          cron: cfg.battleResultCron,
          fnc: () => this.checkAll(),
          log: false
        }
      : { name: '', fnc: '', cron: '' }
  }

  /**
   * 两个开关的公共校验：必须在群里发（推送要群号）、总开关开着、绑过营地ID。
   * @returns {Promise<string>} 通过时返回营地ID，未通过时已经回复过了，返回空串
   */
  async prepareToggle (e, label) {
    if (!e.isGroup) {
      await e.reply(`${label}需要在群里开启，提醒会发到你开启时所在的群`, shouldQuote())
      return ''
    }

    if (readConfig().onlineReminder === false) {
      await e.reply(`推送总开关当前是关闭状态，请让主人在 #王者设置 里打开`, shouldQuote())
      return ''
    }

    // 订阅入口刻意**不**去问营地ID共享库：这里解析出来的 campId 会被写进
    // GameRecordPush.yaml 固化成本地订阅的一部分，共享库那边后来改了值它也跟不上。
    // 共享只服务「当场发的查询指令」，详见 utils/shareStore.js 顶部
    const campId = getCurrentId(e.user_id)
    if (!campId) {
      await e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
      return ''
    }

    return String(campId)
  }

  /** #开启战绩推送 / #关闭战绩推送 */
  async toggle (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      await this.disableIn(e, qq, 'battle', '战绩推送')
      return
    }

    const campId = await this.prepareToggle(e, '战绩推送')
    if (!campId) return

    const list = loadPushList()
    const existed = list[qq] || {}
    // 已经订阅过、只是换个群再开一次：只往推送群列表里追加，游标一概不动。
    // 重新拉一次把游标挪到当前最新，会把这期间打的局吞掉（原来只有单群时无所谓，
    // 因为那就是「重新订阅」；多群下这是很常见的「再加一个群」）
    const { groups, group, added } = withSubGroup(existed, e.group_id)
    const wasOn = isFlagOn(existed, 'battle') && subGroups(existed).length > 0

    if (wasOn) {
      list[qq] = { ...existed, battle: true, groups, group, campId: String(campId) }
      savePushList(list)
      await e.reply([
        added
          ? `✅ 本群已加入战绩推送，现在会推到 ${groups.length} 个群`
          : '战绩推送本来就在本群开着，无需重复开启',
        Button.push(true)
      ], shouldQuote())
      return
    }

    // 立刻拉一次把游标初始化到当前最新一场。
    // 不做这一步，第一轮轮询会把最近打的那局当成新战绩推出来。
    const data = await fetchLatest(campId, qq)

    if (data === FETCH_HIDDEN) {
      await e.reply('你的营地隐藏了战绩，推送拿不到数据，请先在营地里关闭战绩隐藏', shouldQuote())
      return
    }

    if (!data) {
      await e.reply('拉取战绩失败，可能是营地接口频控或登录态失效，请稍后再试', shouldQuote())
      return
    }

    const latest = (data.list || [])[0] || {}
    list[qq] = {
      ...existed,
      battle: true,
      groups,
      group,
      campId: String(campId),
      lastGameSeq: String(latest.gameSeq || ''),
      lastGameTime: String(latest.dtEventTime || ''),
      // 订阅时正在打的那局不提醒，否则一开启就收到一条「开打了」
      lastGamingStart: String(data.gaming?.dtEventTime || ''),
      // 连胜里程碑也从零开始，别拿上次订阅期间攒下的键把第一个里程碑吞掉
      lastStreakKey: '',
      // 清掉可能残留的退避档位：这里是就地合并，上次关订阅前攒下的 skipTicks
      // 会被继承，刚开启就要干等十分钟才第一次检查
      skipTicks: 0,
      idleSince: '',
      enabledAt: Date.now()
    }
    savePushList(list)

    const cron = readConfig().battleResultCron || ''
    // 营地ID旁边带上昵称，用户才认得出推的是哪个号
    const roleName = (await fetchRoleNames([campId], qq))[campId] || ''
    await e.reply([
      [
        `✅ 已开启战绩推送（营地ID ${campId}${roleName ? ` ${roleName}` : ''}）`,
        '打完一局会在本群播报（不 @ 你），开局也提醒一次',
        cron ? `检查间隔：最快 ${cron}` : '',
        '别的群也要收，去那个群再发一次',
        '连上下线一起提醒发 #开启上下线提醒'
      ].filter(Boolean).join('\n'),
      Button.push(true)
    ], shouldQuote())
  }

  /**
   * 关掉一路推送。
   *
   * 多群订阅下「在哪个群关」是有意义的：只摘掉当前这个群，别的群照推。
   * 摘完一个群都不剩、或本来就不是在推送群里发的（私聊 / 别的群），才把开关整个关掉。
   *
   * @param {'battle'|'online'} key 开关名
   * @param {string} label 展示名，用于文案
   */
  async disableIn (e, qq, key, label) {
    const list = loadPushList()
    const sub = list[qq]

    if (!sub || !isFlagOn(sub, key)) {
      await e.reply(`你还没有开启${label}`, shouldQuote())
      return
    }

    const groups = subGroups(sub)
    const here = String(e.group_id || '')

    // 多群里关掉当前这一个：其它群的推送保持不动
    if (e.isGroup && groups.length > 1 && groups.includes(here)) {
      const { groups: rest, group } = withoutSubGroup(sub, here)
      list[qq] = { ...sub, groups: rest, group }
      savePushList(list)
      await e.reply(
        `已停止在本群推送${label}，其余 ${rest.length} 个群不变（想全关就在那些群里也发一次）`,
        shouldQuote()
      )
      return
    }

    disableSubFlag(qq, key)
    await e.reply(
      key === 'battle'
        ? [`已关闭${label}`, Button.push(false)]
        : `已关闭${label}`,
      shouldQuote()
    )
  }

  /** #开启上下线提醒 / #关闭上下线提醒 */
  async toggleOnline (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)

    if (!enable) {
      await this.disableIn(e, qq, 'online', '上下线提醒')
      return
    }

    const campId = await this.prepareToggle(e, '上下线提醒')
    if (!campId) return

    const list = loadPushList()
    const existed = list[qq] || {}
    const { groups, group, added } = withSubGroup(existed, e.group_id)

    // 已经开着、只是再加个群：不重新拉基准（那会把状态机的 lastOnlineState 抹掉重来）
    if (isFlagOn(existed, 'online') && subGroups(existed).length > 0) {
      list[qq] = { ...existed, online: true, groups, group, campId: String(campId) }
      savePushList(list)
      await e.reply(
        added
          ? `✅ 本群已加入上下线提醒，现在会推到 ${groups.length} 个群`
          : '上下线提醒本来就在本群开着，无需重复开启',
        shouldQuote()
      )
      return
    }

    // 立刻拉一次当前状态做基准。没有基准的话第一轮会把「当前在线」当成刚上线推一条
    const state = await fetchOnlineState(campId, qq)

    if (state === FETCH_HIDDEN) {
      await e.reply('你的营地隐藏了主页，拿不到在线状态，请先在营地里关闭主页隐藏', shouldQuote())
      return
    }

    if (!state) {
      await e.reply('拉取在线状态失败，可能是营地接口频控或登录态失效，请稍后再试', shouldQuote())
      return
    }

    // 营地把在线状态和战绩做成两个独立的隐私开关：只关前者的号，profile 里
    // gameOnline / onlineTime / offlineTime 三个字段全给 0（不是「离线」，是「不告诉你」），
    // 这时开上下线提醒等于永远推不出东西，直接拦下来说清楚要去开哪个开关。
    if (!hasOnlineSignal(state)) {
      await e.reply(
        '❌ 营地没返回你的在线状态，开了也推不出来。\n' +
        '去王者营地 →「我的」→ 设置 → 隐私设置，打开在线状态（对外展示），再重新开启',
        shouldQuote()
      )
      return
    }

    const nowSec = Math.floor(Date.now() / 1000)
    list[qq] = {
      ...existed,
      online: true,
      // 只开上下线提醒时也要有 group/campId，且不能顺手把战绩推送打开
      battle: existed.battle === true,
      groups,
      group,
      campId: String(campId),
      lastOnlineState: String(state.gameOnline),
      // 主页接口是玩家名的来源之一，缓存给不 @ 的那几条文案用
      ...(state.roleName ? { roleName: String(state.roleName) } : {}),
      // 订阅时已经在线：没观察到上线瞬间，只能回退到营地的 onlineTime（会做陈旧值检查）
      onlineSince: state.gameOnline !== 0 ? String(resolveOnlineSince(state.onlineTime, nowSec)) : '',
      // 同 toggle：就地合并会继承上次的退避档位，刚开启不该还在退避里
      skipTicks: 0,
      idleSince: '',
      enabledAt: existed.enabledAt || Date.now()
    }
    savePushList(list)

    const cron = readConfig().battleResultCron || ''
    await e.reply([
      `✅ 已开启上下线提醒（营地ID ${campId}${state.roleName ? ` ${state.roleName}` : ''}）`,
      `当前状态：${ONLINE_LABEL[state.gameOnline] || '未知'}`,
      '上下线会在本群播报（不 @ 你），下线时附本次战绩总结',
      cron ? `检查间隔：最快 ${cron}` : '',
      '关闭发 #关闭上下线提醒'
    ].filter(Boolean).join('\n'), shouldQuote())
  }

  /**
   * #开启在线状态 / #关闭在线状态（别名带「展示」二字）
   *
   * 只控制「要不要出现在 #谁在打游戏 名单里」，**和营地的「在线状态」隐私设置无关**：
   * 那个管的是营地自己的数据给不给看，这个管的是本插件要不要把采集到的快照展示给群友。
   *
   * 也不做任何播报——上下线播报是 #开启上下线提醒（online）的事，两者独立：
   * 只想被看到、不想被播报的号就只开这一个。
   */
  async toggleStatus (e) {
    const enable = e.msg.includes('开启')
    const qq = String(e.user_id)
    const list = loadPushList()
    const sub = list[qq]

    if (!enable) {
      if (!sub || !isFlagOn(sub, 'onlineStatus')) {
        await e.reply('你本来就没开在线状态展示', shouldQuote())
        return
      }
      // 关掉时**留一条记录**而不是把整条订阅删掉。
      //
      // 删掉是不行的：影子订阅每一轮都会把「在群里 + 绑了营地号」的人自动补回来，
      // 于是用户发了关闭指令、下一轮开关又自己变回开 —— 关不掉。
      // 所以关的时候写 onlineStatus:false + optedOut:true，影子订阅看到 optedOut 就跳过。
      // 其余开关（battle/online/日报…）原样保留，不能因为关这个就把人家的推送删了。
      list[qq] = { ...(sub || {}), onlineStatus: false, optedOut: true }
      savePushList(list)
      await e.reply('已关闭在线状态展示，之后 #谁在打游戏 不会再列出你', shouldQuote())
      return
    }

    // 绑了营地号就够 —— 采集只需要营地ID，不需要在群里发（影子订阅一个群都不推）
    // 同 :120，订阅入口不去问共享库（值会被固化进订阅文件）
    const campId = getCurrentId(qq)
    if (!campId) {
      await e.reply(['你还没有绑定营地ID，先发送 #绑定营地 [营地ID]', Button.bind()], shouldQuote())
      return
    }

    // 已经开着的两种情况：避免重复的一次性提示
    const alreadyShown = isFlagOn(sub, 'onlineStatus')

    list[qq] = {
      ...(sub || {}),
      // 影子和正常订阅的统一写法：battle 显式写 false，否则 isFlagOn 会按「缺字段算开着」
      battle: sub?.battle === true,
      online: sub?.online === true,
      onlineStatus: true,
      campId: String(campId),
      // 重新开启就清掉「用户关过」的标记（见关闭分支的说明），别把标记写进每一条记录
      ...(sub?.optedOut ? { optedOut: false } : {}),
      // 不重置 lastOnlineState 等快照字段：已经攒着的在线状态立刻可用，
      // 清掉的话要等下一轮轮询才重新有数据
      ...(sub ? {} : { enabledAt: Date.now(), skipTicks: 0, idleSince: '' })
    }
    savePushList(list)

    // 文案不再说「不开就不列你」：绑了营地号、人在群里，默认就会被列进去
    // （见 gameRecordPush 的影子订阅），这个开关管的是「要不要采集你的在线状态」。
    await e.reply(
      alreadyShown
        ? '在线状态展示本来就在开着，无需重复开启'
        : '✅ 已开启在线状态展示\n本群会出现在 #谁在打游戏 里（上下线不播报，要播报发 #开启上下线提醒）\n关闭发 #关闭在线状态展示',
      shouldQuote()
    )
  }

  /** #战绩推送状态 */
  async status (e) {
    const qq = String(e.user_id)
    const sub = loadPushList()[qq]
    const cfg = readConfig()

    if (!sub) {
      await e.reply([
        [
          '你还没开启推送',
          '推每局战绩：#开启战绩推送',
          '推上下线：#开启上下线提醒',
          cfg.onlineReminder === false ? '⚠️ 插件推送总开关关着，开了也不会推' : ''
        ].filter(Boolean).join('\n'),
        Button.push(false)
      ], shouldQuote())
      return
    }

    const battleOn = sub.battle !== false
    const onlineOn = sub.online === true
    const statusOn = isFlagOn(sub, 'onlineStatus')
    const groups = subGroups(sub)
    // 自适应节流的现状。不显示的话用户没法判断「怎么半天没动静」是退避还是坏了
    const cap = Math.max(1, Number(cfg.idleBackoffMax) || DEFAULT_IDLE_BACKOFF_MAX)
    const skip = Number(sub.skipTicks) || 0

    await e.reply([
      [
        '📢 推送订阅',
        `战绩推送：${battleOn ? '已开启' : '未开启'}`,
        `上下线提醒：${onlineOn ? '已开启' : '未开启'}`,
        `在线状态展示：${statusOn ? '已开启' : '未开启'}`,
        `营地ID：${sub.campId || '—'}`,
        `推送群：${groups.length ? groups.join('、') : '—'}${groups.length > 1 ? `（共 ${groups.length} 个）` : ''}`,
        `检查间隔：最快 ${cfg.battleResultCron || '—'}`,
        `离线退避：${cap === 1 ? '关闭（按上面间隔）' : `最长拉到 ${cap} 倍间隔`}${skip > 0 ? `｜退避中，还要跳 ${skip} 轮` : ''}`,
        cfg.onlineReminder === false ? '⚠️ 插件推送总开关关着，暂时不会推' : '',
        battleOn ? '关闭：#关闭战绩推送' : '开启：#开启战绩推送',
        onlineOn ? '关闭：#关闭上下线提醒' : '开启：#开启上下线提醒',
        statusOn ? '关闭：#关闭在线状态' : '开启：#开启在线状态'
      ].filter(Boolean).join('\n'),
      Button.push(battleOn)
    ], shouldQuote())
  }

  /** #清空王者战绩推送（主人） */
  async clearAll (e) {
    const count = Object.keys(loadPushList()).length
    savePushList({})
    await e.reply(`已清空全部战绩推送订阅（${count} 个）`, shouldQuote())
  }

  /**
   * 定时轮询。一次请求同时判两件事：正在打的局（开局提醒）和新结算的局（战绩推送）。
   *
   * cron 只是「最快多久看一次」，实际每个订阅还要过一道自适应节流：玩家离线时
   * 按 skipTicks 跳过若干轮（详见 pushStore.resolveNextCheck）。营地对请求总量敏感，
   * 而离线的号既不会开局也不会出新战绩，那些轮次纯属白查。
   */
  async checkAll () {
    if (readConfig().onlineReminder === false) return

    // 刷新「群成员索引」—— 影子订阅的补建与退群清理全都依赖它，而它反映的是
    // 适配器当前的群成员表（有人中途进群/退群，索引必须跟着动）。
    // 放在这一轮的最前面：后面的 isIndexReady / membersOfGroup / groupsOfMember
    // 用的就是刚刷出来的这一份。纯内存读，不发任何请求，开销可以忽略。
    // 刷新失败（适配器没连上、成员缓存全空）时索引保持原样，不会把人误判成退群。
    const refresh = refreshGroupIndex()
    if (!refresh.ok && refresh.reason !== 'empty-gl') {
      logger.debug(`[王者推送] 群成员索引本轮未刷新（${refresh.reason}），沿用上一次的`)
    }

    // 只轮询这三个开关沾一个的订阅。日报/周报共用同一张 pushList，但它们自己有 cron、
    // 读的是归档库，不需要这个轮询——只开了日报的订阅进来会白发一次 mergeSubState
    // 再干等 800ms，订阅多了就是纯浪费。
    // 被拉黑的人整条跳过（订阅不删，移出黑名单就自动恢复）——推送是插件主动发的，
    // 不经过指令那条闸门，得在这里挡
    //
    // ⚠️ 从这一行到下面第 570 行那个 `savePushList(list)` 是一整块**同步**的
    // read-modify-write：中间一个 await 都没有，对事件循环而言是原子的，所以
    // 两次重叠的 checkAll 不会互相覆盖写盘。**不要往这段里加任何 await**
    // （包括把 getCurrentId 换成共享库那个异步版）——一旦让出 microtask，
    // 而重入保护（下面的 `running`）又在这段之后才生效，整表覆盖丢写就成现实了。
    const list = loadPushList()
    const entries = Object.entries(list)
      .filter(([qq, sub]) => !isBlackUser(qq) &&
        (isFlagOn(sub, 'battle') || isFlagOn(sub, 'online') || isFlagOn(sub, 'onlineStatus')))

    // 把「绑了营地号但没开任何推送」的人补成影子订阅——#谁在打游戏 要能看到他们。
    //
    // 范围严格限定成「**当前某个群里**的绑定者」（群成员索引，见 utils/groupIndex.js）：
    // 退群的人不在任何群的成员表里，于是不会被补出来；已经存在的老影子订阅
    // 由下面的清理步骤删掉。这样「谁在打游戏」列出的人必然是本群的人。
    //
    // 索引不可用时（冷启动适配器没连上）整段跳过：宁可这一轮不补，
    // 也不能因为「索引是空的」就把所有人判成退群、把订阅删光。
    const known = new Set(entries.map(([qq]) => qq))
    const shadows = new Set()
    const removed = new Set()

    if (isIndexReady()) {
      // 当前在群里、且绑了营地号的 QQ -> 他要被采集的营地号
      const inGroup = new Map()
      for (const gid of listAllGroupIds()) {
        for (const qq of membersOfGroup(gid)) {
          if (inGroup.has(qq)) continue
          const campId = getCurrentId(qq)
          if (campId && /^\d+$/.test(String(campId))) inGroup.set(qq, String(campId))
        }
      }

      for (const [qq, campId] of inGroup) {
        if (known.has(qq)) continue
        // 被拉黑的人不补影子订阅。这不是可选优化：entries 的过滤里有 isBlackUser，
        // 补进去的订阅下一轮就会被过滤掉、再下一轮又补 —— 每轮一建一弃死循环，
        // 白写盘还刷日志（实测全局黑名单里的 2561472184 就这样反复「新建」了几十轮）。
        if (isBlackUser(qq)) continue
        // 用户主动关过在线状态展示的，别自动补回来 —— 补了就是「发了关闭指令也关不掉」。
        // 见 toggleStatus 关闭分支：那种记录是 onlineStatus:false + optedOut:true，
        // 它还在 list 里（所以 known 已经含它），这里再挡一道是防它被别的路径清掉。
        if (list[qq]?.optedOut === true) continue
        known.add(qq)
        shadows.add(qq)
        // battle/online 显式写 false：isFlagOn 对 battle 是「缺字段算开着」，
        // 不写就会把影子订阅当成开了战绩推送
        list[qq] = {
          campId,
          battle: false,
          online: false,
          onlineStatus: true,
          enabledAt: Date.now()
        }
      }

      // 清理纯影子订阅（只采集、不推任何群、也不上图）。两种都清：
      //   ① 已不在任何群 —— 退群了，留着白发请求、还在别人的名单里挂着
      //   ② 被拉黑 —— entries 已经把他挡在轮询外，他既不会上图也不会攒新快照，
      //      留着就是一条永不更新的僵尸记录
      //
      // 三条保护，缺一条就会误删：
      //   ① 只删「纯采集」的订阅 —— 用户自己开过 battle/online/daily 的，
      //      那是他明确要的推送，退群了/被拉黑时也该留着（移出黑名单即恢复）
      //   ② 只删能在索引里确认真不在任何群、或确认被拉黑的
      //   ③ 索引不可用时整段不跑（上面 if 已经保证）
      //
      // 删黑名单那条不是「可选优化」：黑名单的人仍在群里，groupsOfMember 非空，
      // 只按「退群」判永远清不掉他（实测 2561472184/1750168371 这样赖了几十小时）。
      for (const [qq, sub] of Object.entries(list)) {
        if (!isPureShadow(sub)) continue
        const outOfGroups = !groupsOfMember(qq).length
        const banned = isBlackUser(qq)
        if (!outOfGroups && !banned) continue
        delete list[qq]
        known.delete(qq)
        removed.add(qq)
        logger.info(`[王者推送] 清理影子订阅 ${qq}：${banned ? '已被拉黑' : '已不在任何群'}`)
      }
    }

    // 只要这一轮动过 list（补过影子或清过订阅）就得落盘。
    // 早先这里只判 shadows.size：清理删掉的项只改内存、不写盘，下一轮 loadPushList()
    // 又从磁盘把死人读回来 —— 退群清理形同虚设。
    if (shadows.size || removed.size) {
      savePushList(list)
      if (shadows.size) logger.info(`[王者推送] 新建 ${shadows.size} 条影子订阅（群里的绑定者，只采集不播报）: ${[...shadows].join(',')}`)
    }
    for (const qq of shadows) entries.push([qq, list[qq]])

    if (!entries.length) return

    if (running) {
      logger.warn(`[王者推送] 上一轮还在跑，本轮跳过（${entries.length} 个订阅，间隔可能设得太短）`)
      return
    }

    running = true
    const heroMap = await getHeroNameMap()

    try {
      for (const [qq, sub] of entries) {
        // 退避中：递减计数就走，注意**不能 sleep**——跳过的订阅没发请求，没必要错峰
        const skip = Number(sub?.skipTicks) || 0
        if (skip > 0) {
          mergeSubState(qq, { skipTicks: skip - 1 })
          continue
        }

        try {
          await this.checkOne(qq, sub, heroMap)
        } catch (error) {
          logger.error(`[王者推送] 检查 ${qq} 出错: ${error.message}`)
        }
        await sleep(REQUEST_INTERVAL)
      }
    } finally {
      running = false
    }
  }

  /**
   * 检查单个订阅。
   *
   * 请求顺序是**先 profile 后战绩列表**，不是反过来：profile 的返回体比 morebattlelist
   * 小一个量级，先拿到 gameOnline 就能判断这一轮值不值得再花一次战绩列表请求。
   * 离线的号既不会开局也不会出新战绩，省下的那次请求不影响任何提醒的及时性。
   * @param {string} qq 订阅者
   * @param {object} sub 订阅项
   * @param {Record<string,string>} heroMap heroId -> 英雄名
   */
  async checkOne (qq, sub, heroMap) {
    // 没有推送目标群就不用轮询 —— 这条对「要播报」的两路成立，但**影子订阅例外**：
    // 它只给 #谁在打游戏 采集在线状态，一个群都不推，也没写 groups。
    // 所以判据要放成「有群要推 或者 只是采集」，否则影子订阅永远进不来。
    const hasSnapshotOnly = isFlagOn(sub, 'onlineStatus') && sub.online !== true && sub.battle === false
    if (!subGroups(sub).length && !hasSnapshotOnly) return

    // 营地ID 动态取，不锁死在订阅时那个：用户 #切换营地 后应该跟着换。
    const campId = getCurrentId(qq)
    if (!campId) {
      logger.debug(`[王者推送] ${qq} 已解绑营地ID，跳过`)
      return
    }

    // 老订阅没有 battle 字段，按开着算（向后兼容首个版本写下的订阅）
    const battleOn = sub.battle !== false
    const onlineOn = sub.online === true
    // 只采集不播报：给 #谁在打游戏 攒在线状态快照用。三种来源都算——
    //   ① 显式开了在线状态展示（onlineStatus）
    //   ② 开了上下线提醒（online）—— 它本来就要拉 profile，顺手记一份不额外发请求
    //   ③ 没订阅的绑定号（影子订阅，只带 onlineStatus）
    const snapshotOn = onlineOn || isFlagOn(sub, 'onlineStatus')

    let state = null
    let onlineSignalMissing = false
    // 本轮 profile 拿到的游戏昵称，独立于 state 存活：营地可能不给在线状态，
    // 但昵称照样给（见下面的分支），所以不能挂在 state 上一起被丢弃
    let roleNameFromState = ''
    if (snapshotOn) {
      state = await fetchOnlineState(campId, qq)
      if (state === FETCH_HIDDEN) state = null
      // 营地只关了「在线状态」授权的号，三个字段全给 0（判据见 pushStore.hasOnlineSignal）。
      // 这不是离线而是「没告诉你」，当成没拿到，后面 checkOnline 就不会拿它报上下线、
      // observeSnapshot 也不会把 lastOnlineState 记成 0；战绩那一路照旧走（两个隐私开关是独立的）。
      //
      // 注意 roleName 要**先捞出来**再置 null：同一次 profile 返回里，在线状态和昵称是
      // 两个独立的字段，营地关掉前者不代表不给后者（实测这几个号都拿得到昵称）。
      // 早先直接把 state 整个置 null，昵称就跟着被扔了，出图上全是空名字。
      if (state && !hasOnlineSignal(state)) {
        logger.debug(`[王者推送] ${qq} 营地未返回在线状态（三字段全 0），本轮只按战绩列表处理`)
        roleNameFromState = state.roleName ? String(state.roleName) : ''
        state = null
        onlineSignalMissing = true
      } else if (state?.roleName) {
        roleNameFromState = String(state.roleName)
      }
    }

    // 战绩列表这一轮拉不拉，判据见 pushStore.needBattleList
    // 注意传的是 battleOn 而不是 snapshotOn：只采集（onlineStatus）时不拉战绩列表，
    // profile 里的 gameOnline 已经够填快照了，省下的请求量正好抵掉扩量的开销
    let data = null
    if (needBattleList({ battleOn, onlineOn: snapshotOn, state, sub })) {
      // profile 刚打过，两个端点的请求别贴在一起
      if (snapshotOn) await sleep(REQUEST_INTERVAL)
      data = await fetchLatest(campId, qq)
      if (data === FETCH_HIDDEN) data = null
    }

    if (battleOn && data) {
      const handled = await this.checkBattle(qq, sub, campId, data, heroMap)
      // 换号时 checkBattle 已经重置过游标，本轮不再往下做上下线判断，等下一轮拿新号的基准
      if (handled === 'switched') return
    }

    // 播报只在真的开了上下线提醒时做：只开着 onlineStatus 的号是「只采集不播报」，
    // 拉 profile 只是为了填快照，不能顺手把他的上下线播出来（那是另一件事，得用户自己开）
    if (onlineOn) {
      await this.checkOnline(qq, sub, data, state)
    }

    // 收尾：按这一轮的活跃度定接下来跳过几轮，顺带留一份本轮观测快照
    const nowMs = Date.now()
    mergeSubState(qq, {
      ...resolveNextCheck(sub, {
        active: isSubActive(state, data, Math.floor(nowMs / 1000)),
        nowMs,
        maxMultiplier: readConfig().idleBackoffMax
      }),
      // 给 #谁在打游戏 用：那条指令一次营地请求都不发，只读这几个字段。
      // lastSeenAt 是本轮的观测时刻（判数据够不够新），lastGaming 是「此刻在不在对局中」。
      // 判据只认战绩列表的 isGaming —— 影子订阅在「游戏中」时也会补拉一次战绩列表
      // （见 needBattleList），所以这条快照对每个人都拿得到英雄。gameOnline===2 单用
      // 会推出没有英雄的「假对局」，已在 observeSnapshot 里弃用。
      ...observeSnapshot(state, data, nowMs, sub),
      // 游戏昵称单独并进来，理由见 roleNameFromState 的声明：它不从 state 走，
      // 因为 state 可能被判成「没在线信号」而整个丢掉
      ...(roleNameFromState ? { roleName: roleNameFromState } : {}),
      // 营地这轮没给在线状态：把可能留着的旧值清成空串，让 #谁在打游戏 归到
      // 「还没采集到状态」而不是谎报离线（空串和真的 '0' 语义不同）
      ...(onlineSignalMissing ? { lastOnlineState: '' } : {})
    })
  }

  /**
   * 战绩推送 + 开局提醒。
   * @returns {Promise<'switched'|void>} 检测到换号时返回 'switched'
   */
  async checkBattle (qq, sub, campId, data, heroMap) {
    const latest = (data.list || [])[0] || {}

    // 换号了：两个号的战绩时间线互不相干，直接把游标挪到新号的最新一场，本轮不推。
    // 不重置的话，新号的历史战绩会因为「时间比旧号游标新」被整批当成新战绩推出来。
    if (String(sub.campId || '') !== String(campId)) {
      logger.mark(`[王者推送] ${qq} 营地ID 变更 ${sub.campId} -> ${campId}，重置推送游标`)
      mergeSubState(qq, {
        campId: String(campId),
        lastGameSeq: String(latest.gameSeq || ''),
        lastGameTime: String(latest.dtEventTime || ''),
        lastGamingStart: String(data.gaming?.dtEventTime || ''),
        // 在线状态也一起重置，新号的在线状态和旧号无关
        lastOnlineState: '',
        onlineSince: '',
        // 退避档位也归零：换号等于一条全新的时间线，别让旧号攒下的退避拖着新号
        skipTicks: 0,
        idleSince: ''
      })
      return 'switched'
    }

    // 开局提醒。用 gaming.dtEventTime（开局时间戳，一局之内恒定）做去重键，
    // 比 isGaming 布尔值可靠：连着开两局时布尔值可能一直是 true，时间戳会变。
    const gamingStart = String(data.gaming?.dtEventTime || '')
    const needGaming = data.isGaming && gamingStart && gamingStart !== String(sub.lastGamingStart || '')

    // 新结算的战绩
    const fresh = pickNewBattles(data.list, sub)

    if (!needGaming && !fresh.length) return

    const newest = fresh[fresh.length - 1]

    // 最新那局出详情图。要多拉一次 battledetail 并走 puppeteer，所以只给最新一局出图：
    // 一轮补推多局是异常情况（重启 / 频控 / cron 被调长），不该在异常时把成本放大到 N 倍。
    let detailImage = null
    if (newest) {
      detailImage = await this.renderDetail(qq, campId, newest, sub)
    }

    // 三条播报（打完、开局、上下线）现在都不 @ 本人，一律把玩家名写进文案。
    // @ 会给订阅者刷一条红点提醒，而他自己刚打完那局最清楚，真正需要认人的是群里其他人。
    const name = await this.resolveDisplayName(qq, sub)

    // 两件事凑在同一轮时合并成一条消息发。
    // 连着打排位时「上一局结算」和「下一局开局」几乎总是同一轮被读到，
    // 分两条发就是一轮刷两条，合并后阅读顺序也更顺（先说打完什么，再说又开了一局）。
    // 合并后名字已经写在战绩那段的开头，开局那段就不再重复。
    const blocks = []
    if (fresh.length) {
      // 出了图就用精简文案：KDA / 评分 / 时长图里都有，文字只留图上没有的巅峰分与段位变化
      blocks.push(this.buildBattleMessage(fresh, data.list, heroMap, !!detailImage, name))
    }
    if (needGaming) {
      blocks.push(`${fresh.length ? '—— 又开了一局 ——\n' : ''}${formatGamingText(data.gaming, heroMap, fresh.length ? '' : name)}`)
    }

    // 连胜/连败里程碑。只有真出了新战绩才算——纯开局那轮的连胜数和上一轮完全一样，
    // 在那里播一次就是同一件事说两遍。算出的 key 无论播不播都要写回订阅项（见下面的 patch）
    const milestone = fresh.length
      ? streakMilestone(calcStreak(data.list), sub.lastStreakKey, name)
      : null
    if (milestone?.text) blocks.push(milestone.text)

    // 有详情图时就不再附英雄头像了，两张图挤在一条消息里没必要。
    // 开局提醒（纯开局那轮没有 fresh，newest 为 undefined）也因此不带头像——
    // 群友反馈开局连头像图太多，只发文字；详情图没出来的战绩推送仍回退到头像。
    const iconUrl = detailImage
      ? ''
      : (newest?.heroIcon || '')

    const sent = await this.send(qq, sub, blocks.join('\n'), { iconUrl, image: detailImage })
    if (!sent) return

    // 发送失败时一个游标都不动，下一轮整条消息重试
    const patch = {}
    if (needGaming) patch.lastGamingStart = gamingStart
    if (newest) {
      patch.lastGameSeq = String(newest.gameSeq || '')
      patch.lastGameTime = String(newest.dtEventTime || '')
    }
    // 里程碑去重键：3 连起每场都是新键（win:4、win:5……），连胜断了会写空串，
    // 下次重新从 3 连开始播
    if (milestone) patch.lastStreakKey = milestone.key
    mergeSubState(qq, patch)
  }

  /**
   * 上下线提醒。
   *
   * 只在「离线 <-> 非离线」跨越时发，1(在线) <-> 2(游戏中) 的抖动不发 —— 实测账号
   * 1832804263 就在两轮之间从 1 跳到 2（打开了游戏但还没开局），这种每次都提醒就是刷屏。
   *
   * @param {string} qq 订阅者
   * @param {object} sub 订阅项
   * @param {object|null} data 战绩列表数据，有的话用来做下线时的战绩总结（不额外请求）
   * @param {object|null} state 本轮的在线状态。由 checkOne 查好传进来——它要先拿 gameOnline
   *   才能决定战绩列表拉不拉，这里再查一次就是同一轮打两次 profile
   */
  async checkOnline (qq, sub, data, state) {
    if (!state) return

    const kind = diffOnlineState(state.gameOnline, sub.lastOnlineState)
    const nowSec = Math.floor(Date.now() / 1000)
    // 主页接口每轮都给玩家名，顺手缓存下来：战绩列表和 gaming 里没有这个字段，
    // 而「进入比赛」那条也不 @ 本人、同样要靠名字认人
    const roleName = state.roleName ? String(state.roleName) : ''

    if (!kind) {
      // 状态没跨越，只把当前值记下来。
      // 首轮（lastOnlineState 为空）也走这里，等于「只登记不提醒」。
      const patch = { lastOnlineState: String(state.gameOnline) }
      if (roleName && roleName !== sub.roleName) patch.roleName = roleName
      // 已经在线但没有上线时刻（比如订阅时就在线、或换号后重置过），补一个基准
      if (state.gameOnline !== 0 && !sub.onlineSince) {
        patch.onlineSince = String(resolveOnlineSince(state.onlineTime, nowSec))
      }
      mergeSubState(qq, patch)
      return
    }

    // 上下线都是给群友看的，不 @ 本人，名字写进文案
    const name = roleName || await this.resolveDisplayName(qq, sub)

    let text
    if (kind === 'online') {
      text = formatOnlineText('online', { name, gameOnline: state.gameOnline })
    } else {
      // 本次在线时长用自己记的上线时刻算：营地的 offlineTime 刚下线时不会立刻更新，
      // 拿它相减会得负数（实测 1557825900：gameOnline 已是 0，offlineTime 仍早于 onlineTime）
      const since = Number(sub.onlineSince) || 0
      text = formatOnlineText('offline', {
        name,
        durationSec: since > 0 ? nowSec - since : 0,
        // 收工总结复用本轮已经拉到的战绩列表，没拉到（只开了上下线提醒且列表请求失败）就不带
        session: since > 0 && data ? summarizeSession(data.list, since) : null
      })
    }

    const sent = await this.send(qq, sub, text)
    if (!sent) return

    mergeSubState(qq, {
      lastOnlineState: String(state.gameOnline),
      ...(roleName ? { roleName } : {}),
      // 上线时记下时刻供下次下线算时长；下线时清空。
      // observed=true：这是我们亲眼看到的 0 -> 非0 跨越，此刻就是上线时刻，
      // 比营地的 onlineTime 可靠（那个字段实测会是几个月前的陈旧值）
      onlineSince: kind === 'online' ? String(resolveOnlineSince(state.onlineTime, nowSec, true)) : ''
    })
  }

  /**
   * 出单场详情图。全过程失败都只记日志、返回 null，让调用方回退到纯文字——
   * 定时任务里不能因为出图失败就把整条推送吞掉。
   * @returns {Promise<object|null>} puppeteer 的图片消息段
   */
  async renderDetail (qq, campId, battle, sub) {
    try {
      // waitComplete：推送是在对局刚结束时触发的，此时详情里的 roles 常常还没落全，
      // 出图就缺一两个玩家的卡片。给它两次机会等数据齐（判据见 isRolesComplete），
      // 等不到就按现有数据出图 —— 宁可图上少个人，也不能把整条推送拖死或吞掉
      const detail = await fetchBattleDetail(campId, battle, qq, { waitComplete: 2 })
      if (!detail) {
        logger.debug(`[王者推送] ${qq} 取不到 ${battle.gameSeq} 的战绩详情，回退纯文字`)
        return null
      }

      // 详情里带玩家名，顺手缓存给「不 @ 的那几条」文案用（战绩列表和 gaming 里都没有）
      const roleName = detail.head?.roleName
      if (roleName && roleName !== sub?.roleName) {
        mergeSubState(qq, { roleName: String(roleName) })
      }

      return await renderBattleDetail(detail)
    } catch (error) {
      logger.error(`[王者推送] ${qq} 生成战绩详情图失败，回退纯文字: ${error.message}`)
      return null
    }
  }

  /**
   * 拼多场战绩的消息体。
   * @param {Array<object>} fresh 新场次，从旧到新
   * @param {Array<object>} fullList 完整列表（倒序），用来取「更早一场」比段位星数、算连胜
   * @param {Record<string,string>} heroMap
   * @param {boolean} [hasImage=false] 最新一局是否已经出了详情图，决定最后一条用不用精简文案
   * @param {string} [name] 玩家名。这条也不 @ 本人了，名字得写进文案里，
   *   否则群里看不出是谁打完的（详情图上有名字，但纯文字回退时就没有了）
   */
  buildBattleMessage (fresh, fullList, heroMap, hasImage = false, name = '') {
    // 只详细展示最近几场，更早的漏推场次折叠成一行，避免刷屏
    const shown = fresh.slice(-MAX_DETAIL_BATTLES)
    const omitted = fresh.length - shown.length

    const blocks = shown.map((item, idx) => {
      // 段位星数要和时间上更早的那场比，列表是倒序的，所以是 index + 1
      const index = fullList.findIndex(x => String(x.gameSeq || '') === String(item.gameSeq || ''))
      const prev = index >= 0 ? fullList[index + 1] : undefined
      // 只有最新那局（数组最后一项）配了详情图，它才用精简文案；补推的旧局仍是完整文字
      const brief = hasImage && idx === shown.length - 1
      return formatBattleText(item, prev, heroMap, { brief })
    })

    // 昵称里的私有区图标和不可见字符要洗掉，否则群里显示成豆腐块（和开局/上下线同一套规则）
    const who = name ? `${normalizeName(name)} · ` : ''
    const head = fresh.length > 1
      ? `${who}打完 ${fresh.length} 局${omitted > 0 ? `（较早 ${omitted} 局略过）` : ''}`
      : `${who}打完一局${shown[0]?.mapName ? ` · ${shown[0].mapName}` : ''}`

    const lines = [head, ...blocks]

    const streak = calcStreak(fullList)
    if (streak.count >= 2) {
      lines.push(`${streak.type === 'win' ? '🔥' : '🧊'} 当前 ${streak.count} 连${streak.type === 'win' ? '胜' : '败'}`)
    }

    return lines.join('\n')
  }

  /**
   * 往订阅的每个群发一条推送。
   *
   * 一条都不 @ 本人：打完、开局、上下线全是群里看的播报，而订阅者自己刚打完那局最清楚，
   * @ 只是给他多刷一条红点。要认人靠文案里的玩家名，每条都带。
   *
   * 多群时**只要有一个群发成功就算成功**：游标由调用方按返回值推进，
   * 一个群发失败（被踢、群解散）不该让整条消息在其它群反复重推。
   * 图片只下载一次，多个群复用同一个消息段。
   *
   * @param {string} qq 订阅者，只用于日志
   * @param {string|string[]|object} target 群号、群号数组，或订阅项本身
   * @param {string} text 文案
   * @param {object} [opts]
   * @param {string} [opts.iconUrl] 英雄头像 URL，没有详情图时才用
   * @param {object} [opts.image] 已渲染好的图片消息段（战绩详情图）
   * @returns {Promise<boolean>} 是否至少发成功一个群。全失败时不推进游标，下一轮会重试
   */
  async send (qq, target, text, { iconUrl = '', image = null } = {}) {
    const groups = Array.isArray(target)
      ? target.map(String)
      : (typeof target === 'object' && target !== null ? subGroups(target) : subGroups({ group: target }))

    if (!groups.length) {
      logger.debug(`[王者推送] ${qq} 没有推送群，跳过`)
      return false
    }

    const message = [text]

    if (image) {
      message.push(image)
    } else if (iconUrl) {
      // getLocalImage 带 md5 缓存与占位图识别，同一个英雄头像只会真正下载一次
      const icon = await getLocalImage(iconUrl)
      if (icon) message.push(segment.image(icon))
    }

    let ok = 0
    for (const groupId of groups) {
      try {
        const group = pickGroupSafe(groupId)
        if (!group?.sendMsg) {
          logger.warn(`[王者推送] 取不到群 ${groupId}，跳过 ${qq}`)
          continue
        }

        await group.sendMsg(message)
        ok += 1
        logger.mark(`[王者推送] 已推送给 ${qq}@群${groupId}${image ? '（含详情图）' : ''}`)
      } catch (error) {
        logger.error(`[王者推送] 发送失败 ${qq}@群${groupId}: ${error.message}`)
      }
    }

    return ok > 0
  }

  /**
   * 拿玩家名写进文案。每条播报都不 @ 本人，所以名字是群里认人的唯一线索。
   *
   * 战绩列表和 data.gaming 里都没有玩家名，只有主页接口和战绩详情里有，
   * 所以订阅项里缓存一份（checkOnline 每轮、出详情图时顺手更新）。
   * 一次都没拿到过时退回 QQ 的群名片 / 昵称，最后退到 QQ 号。
   */
  async resolveDisplayName (qq, sub) {
    if (sub?.roleName) return String(sub.roleName)

    // pickGroupSafe / resolveMemberName 负责跨适配器的 ID 形态：
    // 官bot 的群号是 openid、user_id 是 appid:openid，Number() 一律 NaN
    // 多群订阅取第一个群问名字就够——群名片可能各群不同，但这只是拿不到营地昵称时的兜底
    return resolveMemberName(pickGroupSafe(subGroups(sub)[0]), qq)
  }
}

/** 读配置，读不到时按「开启」处理，和 shouldQuote 的兜底思路一致 */
function readConfig () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/**
 * 本轮观测快照，写进订阅项供 #谁在打游戏 直接读，不额外发请求。
 *
 * 两个数据源都可能缺：只开战绩推送时没有 state，退避轮或 needBattleList 判否时没有 data。
 * 缺的字段就不写（保留上一轮的值），只有真观测到才更新 lastSeenAt —— 否则「数据新鲜度」
 * 会被一个什么都没拿到的轮次刷新成当前时间，指令那头就看不出数据其实是旧的了。
 *
 * @param {object|null} state fetchOnlineState 的返回
 * @param {object|null} data fetchLatest 的返回
 * @param {number} nowMs 观测时刻
 * @param {object} prev 上一轮的订阅项，用来判「刚打完」和「是不是还在打同一局」
 */
function observeSnapshot (state, data, nowMs, prev = {}) {
  if (!state && !data) return {}

  const patch = { lastSeenAt: String(nowMs) }

  if (state) patch.lastOnlineState = String(state.gameOnline)

  // 游戏昵称（营地 roleName）不在这里写，由调用方单独并进来 —— 原因见 checkOne 里
  // roleNameFromState 的声明：state 可能因为「营地问不出在线状态」被判成无效整个丢弃，
  // 而昵称是同一份响应里另一个独立字段，不该跟着一起没。

  // 在对局中：**只信战绩列表的 isGaming**。
  //
  // 早先用 `state.gameOnline===2` 兜底（那轮没拉战绩列表时），后果是
  // 「正在对局」被标出来、英雄却永远为空 —— 因为英雄只在 data.gaming.heroId 里，
  // 而 gameOnline===2 只代表「客户端开着」（大厅、匹配中、翻战绩都算 2，见
  // pushStore.fetchOnlineState 的三态注释）。两路判据必须同源，否则图上出现空行。
  // 影子订阅现在会在「游戏中」时也拉一次战绩列表（见 needBattleList），英雄才有来源。
  const gaming = data ? Boolean(data.isGaming) : false
  const prevGaming = String(prev?.lastGaming || '') === '1'

  patch.lastGaming = gaming ? '1' : ''
  patch.lastGamingHero = gaming ? String(data?.gaming?.heroId || '') : ''
  // 营地给了 isGaming 却没给 heroId：没见过的组合，留一条痕迹方便回查，但不影响出图
  if (gaming && !data?.gaming?.heroId) {
    logger.debug(`[王者推送] ${prev.campId || ''} isGaming=true 但没给 heroId，本轮英雄留空`)
  }

  // 「刚打完」：#谁在打游戏 要显示「X 分钟前刚结束」。
  // 只在 1 -> 0 的那一轮记时刻，之后每轮不再更新，相对时间才会往前走。
  // 反过来 0 -> 1 时清掉，否则上一局的结束时刻会一直挂着。
  //
  // 判 1 -> 0 必须要求**这一轮真的拉到了战绩列表**（data 非空）：没拉到 data 时
  // gaming 恒为 false（上面已收窄），不设防的话一次请求失败/频控就会被当成
  // 「刚打完」，凭空冒出一条「刚刚结束」。存量里那些 lastGaming='1' 的老快照
  // 也会在第一次读到时误入「刚打完」组，这条守卫把过渡期这一下挡掉。
  if (data && prevGaming && !gaming) patch.lastGameEndAt = String(nowMs)
  else if (!prevGaming && gaming) patch.lastGameEndAt = ''
  else if (gaming) patch.lastGameEndAt = ''

  // 同一局的开始时刻：dtEventTime 一局之内恒定，是「一局」的唯一标识。
  // 只在开局那一轮（或换了局的轮次）写，避免退避轮拿旧时间戳反复刷新。
  const start = gaming ? String(data?.gaming?.dtEventTime || '') : ''
  if (startingNewGame(start, prev)) {
    patch.lastGamingStart = start
    // 换局就把「已经打了多久」的起点也一起换掉，否则会显示成上一局的时长
    patch.lastGameSeq = String(data?.list?.[0]?.gameSeq || '')
  }

  // 段位顺手记一份：#谁在打游戏 要显示段位徽章，而它自己不发请求。
  // 战绩列表第一场带 roleJobName/stars；只有 profile 时没有这两个字段，保留旧值。
  if (data) {
    const latest = (data.list || [])[0] || {}
    if (latest.roleJobName) patch.roleJobName = String(latest.roleJobName)
    // stars 是「这局之后的星数」，0 是真实值（1 星再输一局），不能用 || 兜底
    if (latest.stars !== undefined && latest.stars !== null && latest.stars !== '') {
      patch.stars = String(latest.stars)
    }
  }

  return patch
}

/**
 * 这一轮是不是「开了一局新的」。
 *
 * `dtEventTime` 一局之内恒定，所以它变了就是新的一局；从没记过（历史订阅没这个字段）
 * 也算新的一局，好让第一轮就把起点写上。
 *
 * @param {string} start 本轮拿到的一局开始时刻（不在对局时是空串）
 * @param {object} prev 上一轮的订阅项
 * @returns {boolean}
 */
function startingNewGame (start, prev) {
  if (!start) return false
  // prev.lastGamingStart 可能是数字（早期写法）或字符串，统一成字符串比
  return String(prev?.lastGamingStart ?? '') !== start
}

/**
 * 这条订阅是不是「纯采集的影子订阅」——没给任何群推任何东西，只攒在线状态快照。
 *
 * 退群清理只认这一类。判据是「三个播报开关全关」，而不是「有没有 groups」：
 * 用户开着 battle 但还没发过任何真实战绩轮次时 groups 也可能是空的，
 * 那种订阅是他明确要的，退群了也不该被我们删掉。
 *
 * daily / weekly / monthly 也要一起看：那三路推送同样共用这条订阅，
 * 只看 battle/online 会把「只开了日报」的人误判成影子。
 *
 * @param {object} sub 订阅项
 * @returns {boolean}
 */
function isPureShadow (sub) {
  if (!sub) return false
  if (sub.battle === true || sub.online === true) return false
  if (sub.daily === true || sub.weekly === true || sub.monthly === true) return false
  return isFlagOn(sub, 'onlineStatus')
}

/** 索引里所有群号。影子订阅要扫「群里有哪些人」，得先有群的全集 */
function listAllGroupIds () {
  return Object.keys(getGroupIndex().groups || {})
}
