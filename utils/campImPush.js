/**
 * 营地消息 → QQ 私信推送。
 *
 * ## 推给谁
 * **只推给该营地账号的归属人**（`AuthPool.json` 的 `ownerBotUserId`）。
 * 没有归属人的号一律不推 —— 那批是 2026-09-17 之前扫的老号，主人明确说过不管。
 *
 * ## 长什么样
 * ```
 * [头像图]                        ← 游戏头像 fromRoleIcon；没有就回落 QQ 头像
 * 📩 我就只会补兵                 ← 只留游戏角色名
 * 你干嘛呢
 * （微信安卓 荣耀王者）
 *
 * 回复：引用这条消息，或发 #营地回复 1580886057 <内容>
 * ```
 *
 * ⚠️ **头像发失败要降级成纯文字** —— 不能因为一张图发不出去就把消息丢了。
 */
import { Config } from '#components'
import authStore from './authStore.js'
import { sendPrivate } from './privateMsg.js'
import { addRef, setLastPush, getLastPush as storeGetLastPush } from './campImStore.js'
import { sendMaster } from './masterMsg.js'
import { qlogoUrl } from './avatar.js'

// ⚠️ `segment` 是云崽的全局变量（lib/plugins/loader.js 里 global.segment = segment），
//    不能从 #components import —— 本仓库其他文件（如 apps/heroDetail.js）也是直接用全局的。
/* global segment */

/** 配置读取（现读，改完不用重启） */
function cfg () {
  try { return Config.getDefOrConfig('config') || {} } catch { return {} }
}

/** 推送带不带头像图 */
function pushImageEnabled () {
  return cfg().campImPushImage !== false
}

/** 拿某营地账号的归属人 QQ；没有就返回 '' */
export function ownerOf (campUserId) {
  try {
    const acc = authStore.getAccount(String(campUserId))
    return String(acc?.ownerBotUserId || '')
  } catch {
    return ''
  }
}

/** 昵称/角色名截断，防刷屏 */
function clip (s, n = 20) {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 组装私信内容。
 *
 * 头像优先级：**游戏头像（`fromRoleIcon`）优先，取不到回落 QQ 头像**。
 *   · 游戏头像只有「在游戏客户端里发」的消息才带；用 HTTP 发的裸文本没有
 *   · 回落用 `qlogoUrl`（`utils/avatar.js`），只在对方是 QQ 号时拼得出来
 *     （微信区的营地号拼不出 QQ 头像，那就干脆不带图）
 *
 * @returns {{text: string, image: string}}
 */
function buildContent (msg) {
  // ⭐ 只留角色名（游戏里的名字），不带营地账号昵称 —— 两个名字摆一起反而看不清谁是谁
  const title = clip(msg.fromRoleName, 16) || clip(msg.fromUserId, 12)

  const lines = [
    `📩 ${title}`,
    msg.text || '（空消息）'
  ]
  if (msg.fromRoleDesc) lines.push(`（${clip(msg.fromRoleDesc, 24)}）`)
  lines.push('', `回复：引用这条消息，或发 #营地回复 ${msg.selfUserId} <内容>`)

  // 游戏头像优先；没有就用发信人的 QQ 头像兜底
  let image = msg.fromRoleIcon || ''
  if (!image) {
    try {
      image = qlogoUrl(msg.fromUserId, 100) || ''
    } catch {
      image = ''
    }
  }

  return { text: lines.join('\n'), image }
}

/**
 * 推一条营地消息给归属人。
 *
 * @param {object} msg 服务端返回的消息对象
 * @param {object} [opts]
 * @param {object} [opts.bot] 多账号下传 e.bot
 * @returns {Promise<{ok:boolean, reason?:string, to?:string}>}
 */
export async function pushToOwner (msg, { bot } = {}) {
  const owner = ownerOf(msg.selfUserId)
  if (!owner) return { ok: false, reason: 'no_owner' }   // 无归属 → 按约定不管

  const { text, image } = buildContent(msg)
  const withImage = pushImageEnabled() && Boolean(image)

  // ① 带头像图发（图是营地 CDN 的 URL，直接给 segment.image 就行）
  let sent = { ok: false, reason: 'skip_image' }
  if (withImage) {
    try {
      const message = [segment.image(image), '\n' + text]
      sent = await sendPrivate(owner, message, { bot })
    } catch (e) {
      sent = { ok: false, reason: e?.message || 'image_failed' }
    }
  }

  // ② 图挂了就降级纯文字（不因为一张图把消息丢了）
  if (!sent.ok) {
    if (withImage) logger.debug?.(`[营地消息] 头像发送失败（${sent.reason}），降级纯文字`)
    sent = await sendPrivate(owner, text, { bot })
  }

  if (!sent.ok) {
    // ③ 私信彻底发不出去（多半没加好友/关了临时会话）→ 转告主人，别静默丢
    logger.warn(`[营地消息] 推给 ${owner} 失败：${sent.reason}`)
    const fallback = await sendMaster(
      `营地号 ${msg.selfUserId} 收到一条消息，但推给归属人 ${owner} 失败了（TA 多半没加机器人好友）。\n`
      + `发信人：${msg.fromRoleName || msg.fromUserId}\n内容：${msg.text}`
    )
    return { ok: false, reason: sent.reason, to: owner, fallbackToMaster: fallback }
  }

  // ⭐ 精确映射：拿得到「发出去那条消息的 id」时，主人引用**任意一条**推送都能对回正确的人。
  //    ⚠️ 拿不到就只能靠下面的 __last__ 兜底，而那条路在「连着收到两条推送、引用较旧那条」
  //    时会回错人（2026-09-20 实测：引用 Cchanlan 的推送，回给了更晚推来的缨）。
  if (sent.messageId) rememberRef(sent.messageId, msg)

  // ⭐ 记下「主人最近收到的这条推送是谁发的」—— 引用回复要靠它反查。
  //    ⚠️ `sendPrivate` 只返回 {ok}，拿不到发出去那条消息的 id（各适配器行为不一），
  //    所以走「最近一条」而不是「精确 id 映射」：主人引用那条私信时，
  //    云崽给的 reply_id 我们匹配不上，就退化成「按最近一条推送回复」。
  rememberLastPush(owner, msg)

  return { ok: true, to: owner }
}

// ────────────────────────── 引用回复的映射 ──────────────────────────

/**
 * 「某归属人最近一条推送」的映射。
 *
 * ⚠️ 为什么不按消息 id 精确映射：`sendPrivate` 拿不到发出消息的 id。
 *    所以这里按**归属人**记「最近一条」，主人引用那条私信回复时，
 *    我们从 reply_id 匹配不上就退化成按最近一条处理。
 *
 * 代价：主人连着收到两条推送、引用**较旧**那条回复时，会回错人。
 * 缓解：`campImStore` 里也按 reply_id 存一份（有些适配器能拿到 id），
 *      两条路都走，优先精确匹配。
 *
 * ⚠️ 走 `campImStore` 落盘（按归属人分开存），不只用内存 Map ——
 *    不然重启后主人引用一条旧推送就认不出来，会被别的插件的
 *    `^#?回复` 之类规则抢走。
 */
function rememberLastPush (owner, msg) {
  const info = {
    selfUserId: String(msg.selfUserId),
    toUserId: String(msg.fromUserId),
    toRoleId: String(msg.fromRoleId || ''),
    fromRoleId: String(msg.raw?.toRoleId || ''),
    // ⚠️ 名字一定要存：退路取到的可能是**别人的**推送（同一个营地号下不同好友，
    //    或者两个号互相串），光靠 id 认不出来，得拿被引用原文里的发信人名核对。
    nick: String(msg.fromRoleName || ''),
    at: Date.now()
  }
  setLastPush(owner, info)
}

/**
 * 查「某归属人最近收到的那条推送」。
 * @param {string} owner
 * @returns {object|null}
 */
export function getLastPush (owner) {
  return storeGetLastPush(owner)
}

/**
 * 记一条引用映射 —— 推私信时调（见上）。
 * 保留导出是为了将来适配器能给出消息 id 时，可以精确映射。
 */
export function rememberRef (msgId, msg) {
  if (!msgId) return
  addRef(msgId, {
    selfUserId: String(msg.selfUserId),
    toUserId: String(msg.fromUserId),
    toRoleId: String(msg.fromRoleId || ''),
    fromRoleId: String(msg.raw?.toRoleId || ''),
    nick: String(msg.fromRoleName || '')
  })
}
