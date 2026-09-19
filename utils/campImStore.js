/**
 * 营地消息的本地状态（游标 + 引用映射 + 开关）。
 *
 * 落盘 `data/campIm.yaml`，结构：
 * ```yaml
 * cursor: 123                      # 已处理到的最大消息 id（全局单调，防重启丢/重）
 * refs:                            # 引用回复映射：私信消息 id -> 营地会话信息
 *   "123456": { selfUserId, toUserId, toRoleId, fromRoleId, at }
 * accounts:                        # 每个账号的 ws 开关（锅巴页面改这里）
 *   "1580886057": true
 * ```
 *
 * ⚠️ 引用映射要带 TTL —— 不清理的话文件会无限涨。
 */
import path from 'node:path'
import { PluginData } from '#components'
import { readYamlFile, writeYamlFile } from './yamlUtils.js'

const FILE = path.join(PluginData, 'campIm.yaml')

/** 引用映射的存活时间（超过就当没引用过） */
const REF_TTL_MS = 24 * 60 * 60 * 1000
/** 引用映射最多留多少条 */
const REF_MAX = 500

let cache = null

function load () {
  if (cache) return cache
  let raw = {}
  try {
    raw = readYamlFile(FILE) || {}
  } catch {
    raw = {}
  }
  cache = {
    cursor: Number(raw.cursor) || 0,
    refs: (raw.refs && typeof raw.refs === 'object') ? { ...raw.refs } : {},
    accounts: (raw.accounts && typeof raw.accounts === 'object') ? { ...raw.accounts } : {},
    friendLists: (raw.friendLists && typeof raw.friendLists === 'object') ? { ...raw.friendLists } : {}
  }
  return cache
}

function save () {
  if (!cache) return
  try {
    writeYamlFile(FILE, cache)
  } catch (e) {
    logger.error(`[营地消息] 写 ${FILE} 失败：${e.message}`)
  }
}

/** 已处理到的消息游标 */
export function getCursor () {
  return load().cursor
}

export function setCursor (id) {
  const n = Number(id) || 0
  const c = load()
  if (n <= c.cursor) return          // 只前进，不回退
  c.cursor = n
  save()
}

/**
 * 把游标退回去（**唯一允许回退的入口**）。
 *
 * 用途只有一个：服务端重启后消息 id 从 1 重新计数，而游标是「只前进」的，
 * 于是游标停在上次那个大值上、**一条新消息都拉不到**（实测 2026-09-20：
 * 游标 28、服务端 lastId 才 12，收发看着全断）。检测到「服务端 lastId 比游标小」
 * 时调它复位。
 *
 * @param {number} [id] 复位到哪，缺省 0（下次从头拉，队列里没推过的会补上）
 */
export function resetCursor (id = 0) {
  const c = load()
  c.cursor = Number(id) || 0
  save()
}

/**
 * 记一条引用映射（推私信时调）。
 * @param {string|number} msgId 发出去的私信消息 id
 * @param {{selfUserId:string,toUserId:string,toRoleId?:string,fromRoleId?:string}} info
 */
export function addRef (msgId, info) {
  const key = String(msgId || '')
  if (!key) return
  const c = load()
  c.refs[key] = { ...info, at: Date.now() }
  // 清理：先删过期的，再按数量截断
  const now = Date.now()
  const entries = Object.entries(c.refs).filter(([, v]) => now - (v?.at || 0) < REF_TTL_MS)
  entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
  c.refs = Object.fromEntries(entries.slice(0, REF_MAX))
  save()
}

/** 查一条引用映射；过期/不存在返回 null */
export function getRef (msgId) {
  const key = String(msgId || '')
  if (!key) return null
  const v = load().refs[key]
  if (!v) return null
  if (Date.now() - (v.at || 0) > REF_TTL_MS) return null
  return v
}

/** 某账号的 ws 开关（默认开） */
export function isAccountEnabled (userId) {
  const v = load().accounts[String(userId)]
  return v !== false          // 没记录过 = 默认开
}

/** 设置某账号的 ws 开关 */
export function setAccountEnabled (userId, enabled) {
  const c = load()
  c.accounts[String(userId)] = Boolean(enabled)
  save()
}

/** 所有账号开关的快照 */
export function getAccountSwitches () {
  return { ...load().accounts }
}

/**
 * 记「某归属人最近收到的那条营地推送」。
 *
 * ⚠️ 为什么要落盘：`sendPrivate` 拿不到发出去那条私信的 id，没法按 reply_id 精确映射，
 *    只能退化成「该归属人最近一条推送」。这个信息必须扛得住重启 ——
 *    不然主人引用一条重启前收到的推送回复，就会认不出来。
 *
 * key 用 `__last__:<归属人QQ>`，按人分开存（多个归属人不能互相覆盖）。
 */
export function setLastPush (owner, info) {
  const o = String(owner || '')
  if (!o) return
  addRef(`__last__:${o}`, info)
}

/** 查「某归属人最近收到的那条推送」；没有/过期返回 null */
export function getLastPush (owner) {
  return getRef(`__last__:${String(owner || '')}`)
}

// ────────────────────────── 好友列表的编号映射 ──────────────────────────

/**
 * 「#营地好友」出的那张列表 → 编号到人的映射。
 *
 * ⚠️ 为什么要落盘：主人看完列表，可能过几分钟才发 `#营地私聊 3 你好` ——
 *    中间插件重启过（或者主人在别的群发的）就找不到了。TTL 见 FRIEND_LIST_TTL_MS。
 *
 * ⚠️ 按**发起人 + 用哪个营地号**分开存：同一个 QQ 换 `#切换营地` 之后，
 *    编号指向的人完全不一样，混在一起会发错人。
 */
const FRIEND_LIST_TTL_MS = 10 * 60 * 1000

/** 存一份「某人某号最近一次的好友列表」 */
export function setFriendList (owner, selfUserId, list) {
  const key = `__friends__:${String(owner || '')}:${String(selfUserId || '')}`
  if (!owner || !selfUserId) return
  const c = load()
  if (!c.friendLists) c.friendLists = {}
  c.friendLists[key] = { at: Date.now(), selfUserId: String(selfUserId), list }
  // 顺手清理过期的（别让文件无限涨）
  const now = Date.now()
  for (const [k, v] of Object.entries(c.friendLists)) {
    if (now - (v?.at || 0) > FRIEND_LIST_TTL_MS) delete c.friendLists[k]
  }
  save()
}

/**
 * 按编号取人。
 * @returns {{userId:string, roleId:string, nick:string, selfUserId:string}|null}
 */
export function getFriendByIndex (owner, selfUserId, idx) {
  const key = `__friends__:${String(owner || '')}:${String(selfUserId || '')}`
  const v = load().friendLists?.[key]
  if (!v) return null
  if (Date.now() - (v.at || 0) > FRIEND_LIST_TTL_MS) return null
  const i = Number(idx) - 1
  if (!Number.isInteger(i) || i < 0 || i >= v.list.length) return null
  const f = v.list[i]
  return f ? { ...f, selfUserId: v.selfUserId } : null
}

/** 丢弃缓存（锅巴页面改完文件后，让插件重读） */
export function invalidate () {
  cache = null
}
