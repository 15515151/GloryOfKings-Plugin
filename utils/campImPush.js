/**
 * 营地消息 → QQ 私信推送。
 *
 * ## 推给谁
 * **只推给该营地账号的归属人**（`AuthPool.json` 的 `ownerBotUserId`）。
 * 没有归属人的号一律不推 —— 那批是 2026-09-17 之前扫的老号，主人明确说过不管。
 *
 * ## 长什么样
 * ```
 * [游戏头像图]                    ← fromRoleIcon（不是营地账号头像！）
 * 📩 ccxhan · 我就只会补兵
 * 你干嘛呢
 * ─────────────
 * 回复：引用这条消息，或发 #营地回复 1580886057 <内容>
 * ```
 *
 * ⚠️ **头像发失败要降级成纯文字** —— 不能因为一张图发不出去就把消息丢了。
 */
import { Config } from '#components'
import authStore from './authStore.js'
import { sendPrivate } from './privateMsg.js'
import { addRef } from './campImStore.js'
import { sendMaster } from './masterMsg.js'

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
 * @returns {{text: string, image: string}}
 */
function buildContent (msg, selfNick) {
  const who = []
  if (selfNick) who.push(clip(selfNick, 12))
  if (msg.fromRoleName) who.push(clip(msg.fromRoleName, 16))
  const title = who.length ? who.join(' · ') : clip(msg.fromUserId, 12)

  const lines = [
    `📩 ${title}`,
    msg.text || '（空消息）'
  ]
  if (msg.fromRoleDesc) lines.push(`（${clip(msg.fromRoleDesc, 24)}）`)
  lines.push('', `回复：引用这条消息，或发 #营地回复 ${msg.selfUserId} <内容>`)

  return {
    text: lines.join('\n'),
    image: msg.fromRoleIcon || ''
  }
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

  // 自己号的名字（用于「谁的号收到了」）
  let selfNick = ''
  try {
    const acc = authStore.getAccount(String(msg.selfUserId))
    selfNick = acc?.nickname || acc?.userName || ''
  } catch {}

  const { text, image } = buildContent(msg, selfNick)
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

  // ⭐ 记下「主人最近收到的这条推送是谁发的」—— 引用回复要靠它反查。
  //    ⚠️ `sendPrivate` 只返回 {ok}，拿不到发出去那条消息的 id（各适配器行为不一），
  //    所以走「最近一条」而不是「精确 id 映射」：主人引用那条私信时，
  //    云崽给的 reply_id 我们匹配不上，就退化成「按最近一条推送回复」。
  rememberLastPush(owner, msg)

  return { ok: true, to: owner }
}

// ────────────────────────── 引用回复的映射 ──────────────────────────

/**
 * 「主人最近一条推送」的映射（内存 + 落盘）。
 *
 * ⚠️ 为什么不按消息 id 精确映射：`sendPrivate` 拿不到发出消息的 id。
 *    所以这里按**归属人**记「最近一条」，主人引用那条私信回复时，
 *    我们从 reply_id 匹配不上就退化成按最近一条处理。
 *
 * 代价：主人连着收到两条推送、引用**较旧**那条回复时，会回错人。
 * 缓解：`campImStore` 里也按 reply_id 存一份（有些适配器能拿到 id），
 *      两条路都走，优先精确匹配。
 */
const lastPushByOwner = new Map()

function rememberLastPush (owner, msg) {
  const info = {
    selfUserId: String(msg.selfUserId),
    toUserId: String(msg.fromUserId),
    toRoleId: String(msg.fromRoleId || ''),
    fromRoleId: String(msg.raw?.toRoleId || ''),
    at: Date.now()
  }
  lastPushByOwner.set(String(owner), info)
  // 顺便按「最近」这个伪 id 落盘一份，重启也能用
  addRef('__last__', info)
}

/**
 * 查「某归属人最近收到的那条推送」。
 * @param {string} owner
 * @returns {object|null}
 */
export function getLastPush (owner) {
  const v = lastPushByOwner.get(String(owner))
  if (!v) return null
  // 超过 10 分钟就当过期（引用一条很久以前的私信，多半不是想回复）
  if (Date.now() - (v.at || 0) > 10 * 60 * 1000) return null
  return v
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
    fromRoleId: String(msg.raw?.toRoleId || '')
  })
}
