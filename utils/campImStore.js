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
    accounts: (raw.accounts && typeof raw.accounts === 'object') ? { ...raw.accounts } : {}
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

/** 丢弃缓存（锅巴页面改完文件后，让插件重读） */
export function invalidate () {
  cache = null
}
