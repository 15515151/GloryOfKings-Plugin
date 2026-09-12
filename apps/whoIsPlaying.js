/**
 * #谁在打游戏 —— 列出本群谁正在对局、谁在线。
 *
 * **这条指令一次营地请求都不发。** 数据全部来自战绩推送轮询顺手留下的观测快照
 * （apps/gameRecordPush.js 的 observeSnapshot 写进 GameRecordPush.yaml）：
 *   lastGaming      本轮观测到在不在对局中（'1' / ''）
 *   lastGamingHero  在对局时用的英雄 heroId
 *   lastOnlineState 营地的 gameOnline 三态（0 离线 / 1 在线 / 2 游戏中）
 *   lastSeenAt      这份快照的观测时刻，用来判数据够不够新
 *
 * 所以它只覆盖「开过战绩推送或上下线提醒的人」——这正是想被看到的那批人，
 * 而且不给营地增加任何负载。反过来说，快照的新鲜度受推送的自适应退避影响：
 * 长时间离线的号会退到十分钟一轮，所以离线那组的时间戳可能偏旧，文案里标出来。
 *
 * 英雄名走官网 herolist.json（getHeroNameMap，6 小时内存缓存），也不碰营地接口。
 *
 * 出图走 WhoIsPlaying.html（视觉与战报同源），渲染失败时回落到纯文字名单。
 */
import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { loadPushList, subGroups, getHeroNameMap, normalizeName, ONLINE_LABEL } from '../utils/pushStore.js'
import { membersOfGroup, isIndexReady, refreshGroupIndex } from '../utils/groupIndex.js'
import { Button, shouldQuote, getUserAvatar, getGroupAvatar, isBlackUser } from '#utils'
import { heroIconUrl } from '../utils/reportStore.js'

/** 快照超过这个时长就在文案里标「数据较旧」，单位毫秒 */
const STALE_MS = 15 * 60 * 1000

/**
 * 「刚打完」的展示窗口：对局结束后这么久之内还单独列一组。
 *
 * 别看太久——一轮轮询最多间隔十分钟（退避封顶），窗口开太大就会出现
 * 「明明已经打下一局了，上一条还挂在刚打完里」。
 */
const ENDED_WINDOW = 30 * 60 * 1000

export class WhoIsPlaying extends plugin {
  constructor () {
    super({
      name: '王者谁在打游戏',
      dsc: '看本群谁在对局、谁在线，零营地请求',
      event: 'message',
      // 同 gameRecordPush：完整锚定的短指令要抢在 queryGameStats 的宽匹配前面
      priority: 0,
      rule: [
        {
          reg: '^#(谁在(打游戏|玩王者|上号|排位)|王者在线(列表|状态)?|在线列表)$',
          fnc: 'list'
        }
      ]
    })
  }

  async list (e) {
    // 谁属于本群：**以群成员索引为准**（群成员表 ∩ 已绑定营地ID，见 utils/groupIndex.js）。
    //
    // 这是这份名单唯一的归属判据，早先那套「订阅项的 group 字段 + onlineStatus 兜底」
    // 有两个致命问题，都实测发生过：
    //   ① 一个人只有单个 `group` 字段，在 A 群开的在线状态会漏到 B 群（R 群里曾列出
    //      19 个压根不在 R 群的号）；
    //   ② 退群的人绑着营地ID 就一直赖在名单里，谁也弄不出去。
    // 换成索引后，退群的人不在成员表里 → 自然出表，不需要任何额外清理逻辑。
    //
    // 索引拿不到时（冷启动适配器还没连上）回落到旧判据，宁可多列几个也不能把
    // 本群的人判成不在群 —— 那种「名单突然空了」比多列更误导人。
    //
    // 先刷一次索引：它反映适配器当前的群成员表，有人刚进群/刚退群都要算数。
    // 刷新失败时保留上一次的，所以不会把整群的人判成退群。
    refreshGroupIndex()

    const here = String(e.group_id || '')
    const self = String(e.user_id)

    // 被拉黑的人不列出来：他那份快照已经不再更新了（推送轮询会跳过他），
    // 留在名单里只会永远显示「数据较旧」。
    const list = loadPushList()
    const ready = isIndexReady()
    const members = ready ? new Set(membersOfGroup(here)) : null

    const subs = Object.entries(list).filter(([qq, sub]) => {
      if (isBlackUser(qq)) return false
      // 私聊没有群成员表，退化成「只看自己」
      if (!here) return qq === self
      if (members) return members.has(qq)
      // 索引不可用时的兜底：仍按推送目标群判，但不放行 onlineStatus，
      // 免得又回到「谁的在线状态都往本群灌」的老毛病
      return subGroups(sub).includes(here)
    })

    if (!subs.length) {
      await e.reply([
        here
          ? `本群还没有人能显示在线状态\n发送 #绑定营地 [营地ID] 就会被列进来`
          : '你还没有绑定营地ID\n发送 #绑定营地 [营地ID] 后就能看到自己的在线状态',
        Button.push(false)
      ], shouldQuote())
      return
    }

    const heroMap = await getHeroNameMap()
    const now = Date.now()

    const playing = []
    const justEnded = []
    const online = []
    const offline = []
    // 只开了战绩推送、还没攒到过快照的订阅：既不算在线也不算离线，单独说一句
    const unknown = []

    // 头像是各适配器本地拼地址（官方机器人才会真去问 pickMember），并发取不会卡
    const rows = await Promise.all(subs.map(async ([qq, sub]) => {
      const row = buildRow(qq, sub, heroMap, now)
      row.avatar = await this.avatarOf(e, qq)
      return row
    }))

    for (const row of rows) {
      if (!row.seenAt) unknown.push(row)
      else if (row.gaming) playing.push(row)
      // 刚打完的排在在线前面：它比「只是在线」更能说明刚才在干嘛
      else if (row.justEnded) justEnded.push(row)
      else if (row.state !== 0) online.push(row)
      // 营地不给这个号的在线状态（快照里 lastOnlineState 是空串，不是 '0'）：
      // 报「离线」是假的，归到「还没采集到状态」里
      else if (!row.hasState) unknown.push(row)
      else offline.push(row)
    }

    // 最近观测到的排前面：同一组里时间戳越新越可信
    for (const list of [playing, justEnded, online, offline, unknown]) list.sort((a, b) => b.seenAt - a.seenAt)

    const groups = { playing, justEnded, online, offline, unknown }
    const img = await this.shot(e, groups, here, now)

    await e.reply([
      img || renderText({ ...groups, now }),
      Button.online()
    ], shouldQuote())
  }

  /** 出图。失败返回 null，由调用方回落到文字名单 */
  async shot (e, { playing, justEnded, online, offline, unknown }, here, now) {
    const total = playing.length + justEnded.length + online.length + offline.length + unknown.length
    // 最新一份快照的时刻 —— 整张图的新鲜度就看它
    const newest = Math.max(0, ...[...playing, ...justEnded, ...online, ...offline].map(row => row.seenAt))

    try {
      return await puppeteer.screenshot('WhoIsPlaying', {
        imgType: 'webp',
        tplFile: 'plugins/GloryOfKings-Plugin/resources/html/WhoIsPlaying.html',
        // 模板的 CSS / 字体都靠 {{_res_path}} 拼相对路径，漏了这项样式表 404，出的是纯文字图
        _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
        title: '谁在打游戏',
        subText: here ? '本群在线名单' : '仅你自己',
        scopeName: here ? (e.group_name || e.group?.name || `群 ${here}`) : '我的在线状态',
        avatar: here ? await getGroupAvatar(here, e.group, 100) : await this.avatarOf(e, e.user_id),
        total,
        updateText: newest ? `${agoText(newest, now)}更新` : '',
        playing,
        justEnded,
        online,
        offline,
        unknown,
        footText: '数据来自推送轮询的快照，不额外请求营地 · 离线时检查间隔会自动拉长'
      })
    } catch (error) {
      logger.error(`[王者谁在打游戏] 渲染失败: ${error.message}`)
      return null
    }
  }

  async avatarOf (e, userId) {
    try {
      return await getUserAvatar(e, String(userId), 100)
    } catch {
      return ''
    }
  }
}

/** 把一条订阅整成展示用的行 */
function buildRow (qq, sub, heroMap, now) {
  const seenAt = Number(sub?.lastSeenAt) || 0
  const heroId = String(sub?.lastGamingHero || '')
  const state = Number(sub?.lastOnlineState) || 0
  // 空串 = 这轮没有在线信号（只开战绩推送，或营地关了在线状态授权），跟真的 '0' 要分开
  const hasState = String(sub?.lastOnlineState ?? '') !== ''
  const gaming = String(sub?.lastGaming || '') === '1'

  // 对局时长：dtEventTime 是一局的开始时刻，一局内恒定。用它算「已经打了多久」。
  // 服务端时间戳，跟本地时间可能有偏差，负值/离谱值就不显示（见 durationText）
  const gamingFor = gaming ? durationText(Number(sub?.lastGamingStart) || 0, now) : ''

  // 在线时长：onlineSince 是观察到的上线时刻（订阅时已在线会回退到营地 onlineTime）
  const onlineFor = state !== 0 ? durationText(Number(sub?.onlineSince) || 0, now) : ''

  // 段位：推送轮询从战绩列表顺手记的（只开在线状态的号没有，保留上一轮的值）
  const rankJobName = String(sub?.roleJobName || '')
  const stars = String(sub?.stars ?? '')
  const rankText = rankJobName ? (stars !== '' ? `${rankJobName} ${stars}星` : rankJobName) : ''

  // 刚打完：1 -> 0 的那一轮记的结束时刻，超过 ENDED_WINDOW 就不再算「刚打完」
  const endedAt = Number(sub?.lastGameEndAt) || 0
  const justEnded = !gaming && endedAt > 0 && now - endedAt <= ENDED_WINDOW

  return {
    qq: String(qq),
    // 游戏昵称（营地 roleName）：图上必须有名字，不允许退回画 QQ 号。
    //
    // 拿不到时用一个中性的占位名，而不是 String(qq) —— 主人的要求是这张图上
    // 「必须有昵称」，一串数字既不像昵称，又把 QQ 号公示到群里。
    // 名字的实际来源见 gameRecordPush 的 observeSnapshot：profile 每轮都返回 roleName，
    // 早先那一版把它扔掉了，才会出现成片空名字。
    name: sub?.roleName ? normalizeName(sub.roleName) : '召唤师',
    gaming,
    hero: heroId ? (heroMap[heroId] || `英雄${heroId}`) : '',
    // 模板用的三个字段：英雄头像 / 状态文字 / 相对时间
    heroName: heroId ? (heroMap[heroId] || `英雄${heroId}`) : '',
    heroIcon: heroIconUrl(heroId),
    stateText: ONLINE_LABEL[state] || '在线',
    state,
    hasState,
    seenAt,
    agoText: seenAt ? agoText(seenAt, now) : '',
    stale: seenAt > 0 && now - seenAt > STALE_MS,
    // 新增展示字段：对局/在线时长、段位、刚打完
    gamingFor,
    onlineFor,
    rankText,
    justEnded,
    endedAgoText: endedAt > 0 ? agoText(endedAt, now) : ''
  }
}

/**
 * 时长文案，「打了 12 分钟」这种。
 *
 * 起点是服务端时间戳，和本地时钟可能有偏差；算出来是负数（时钟不同步）或者超过一天
 * （异常大的值，多半是脏数据）就返回空串，宁可不显示也不能给出离谱的时长。
 *
 * @param {number} since 起点时间戳（毫秒），0 表示没有
 * @param {number} now 当前时间戳（毫秒）
 * @returns {string} 空串表示算不出来
 */
function durationText (since, now) {
  if (!since) return ''
  const ms = now - since
  if (ms < 0 || ms > 24 * 3600 * 1000) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚开始'
  if (min < 60) return `${min} 分钟`
  const hour = Math.floor(min / 60)
  const rest = min % 60
  return rest ? `${hour} 小时 ${rest} 分` : `${hour} 小时`
}

/** 相对时间，「3 分钟前」这种 */
function agoText (seenAt, now) {
  const sec = Math.max(0, Math.floor((now - seenAt) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/** 拼最终文案 */
function renderText ({ playing, justEnded, online, offline, unknown, now }) {
  const lines = ['🎮 谁在打游戏']

  if (playing.length) {
    lines.push('', `⚔️ 正在对局（${playing.length}）`)
    for (const row of playing) {
      // 时长 / 段位挂在名字后面，缺就不显示（拿不到时间戳、或者只开了在线状态）
      const extra = [row.gamingFor ? `打了 ${row.gamingFor}` : '', row.rankText].filter(Boolean).join(' · ')
      lines.push(`· ${row.name}${row.hero ? ` —— ${row.hero}` : ''}${extra ? `（${extra}）` : ''}${row.stale ? `（${agoText(row.seenAt, now)}的数据）` : ''}`)
    }
  }

  if (justEnded.length) {
    lines.push('', `✅ 刚打完（${justEnded.length}）`)
    for (const row of justEnded) {
      const extra = [row.hero ? `${row.hero}` : '', row.rankText].filter(Boolean).join(' · ')
      lines.push(`· ${row.name}${extra ? ` —— ${extra}` : ''}（${row.endedAgoText}结束）`)
    }
  }

  if (online.length) {
    lines.push('', `🟢 在线（${online.length}）`)
    for (const row of online) {
      const extra = [row.onlineFor ? `在线 ${row.onlineFor}` : '', row.rankText].filter(Boolean).join(' · ')
      lines.push(`· ${row.name} —— ${ONLINE_LABEL[row.state] || '在线'}${extra ? `（${extra}）` : ''}${row.stale ? `（${agoText(row.seenAt, now)}）` : ''}`)
    }
  }

  if (!playing.length && !online.length) {
    lines.push('', '暂时没人在线，都在摸鱼呢')
  }

  if (offline.length) {
    // 离线的人不逐个列状态：他们的快照因为自适应退避普遍偏旧，逐行写时间戳只是噪音
    lines.push('', `⚫ 离线（${offline.length}）：${offline.map(row => row.name).join('、')}`)
  }

  if (unknown.length) {
    lines.push('', `❔ 还没采集到状态（${unknown.length}）：${unknown.map(row => row.name).join('、')}`)
    lines.push('（刚轮询到、还没攒到快照，或者营地没给这个号的在线状态）')
  }

  lines.push('', '数据来自战绩推送的轮询快照，不会额外请求营地；离线时检查间隔会自动拉长')

  return lines.join('\n')
}
