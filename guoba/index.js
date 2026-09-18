/**
 * 营地消息 —— 锅巴扩展页面（可视化管理）。
 *
 * ## 为什么单独做一个页面
 * 锅巴的静态 schema（`guoba.support.js`）只能渲染「固定结构 + 动态数据」，
 * 没法做「每账号一行、带头像/在线状态/独立开关」这种运行时形状的列表。
 * 所以走 `guoba/` 目录的自定义页面路线（锅巴启动时自动扫描，见
 * `Guoba-Plugin/server/service/both/CustomPageService.js` 的 `PAGE_DIRS`）。
 *
 * ## 接口挂在哪
 * `ctx.registerApi` 注册的接口自动挂到 `/api/custom/<插件目录名>/...` 下，
 * 并且**自动带登录鉴权** —— 别绕过它去裸挂 express（那样没有鉴权）。
 *
 * ## 页面怎么拿接口地址
 * 页面从 `location.search` 读 `__apiBase` / `token`，**不要硬编码**
 * （前缀里含锅巴的挂载段，各环境不一样）。
 */
import authStore from '../utils/authStore.js'
import * as store from '../utils/campImStore.js'
import { ownerOf } from '../utils/campImPush.js'

/** 锅巴面板用的账号快照（含运行时开关 + 归属人） */
function snapshot () {
  const switches = store.getAccountSwitches()
  const accounts = authStore.listAccounts()
    .filter(a => a?.userId && a?.userSig)
    .map(a => {
      const userId = String(a.userId)
      return {
        userId,
        nickname: a.nickname || a.userName || '',
        avatar: a.avatar || a.icon || '',
        // 归属人：没有就是空串（那批 2026-09-17 之前扫的老号，不推消息）
        owner: ownerOf(userId),
        ownerMasked: mask(ownerOf(userId)),
        // ⚠️ 默认开 —— 没记录过就按开算（和 store.isAccountEnabled 的语义一致）
        enable: switches[userId] !== false
      }
    })

  // 没归属人的排后面，其余按昵称
  accounts.sort((x, y) => {
    if (Boolean(x.owner) !== Boolean(y.owner)) return x.owner ? -1 : 1
    return String(x.nickname).localeCompare(String(y.nickname), 'zh')
  })

  return {
    accounts,
    total: accounts.length,
    enabled: accounts.filter(a => a.enable).length,
    ownered: accounts.filter(a => a.owner).length
  }
}

/** QQ 号打码（页面上只给主人看，不用全露） */
function mask (id) {
  const s = String(id || '')
  if (s.length <= 4) return s
  return s.slice(0, 2) + '*'.repeat(Math.max(0, s.length - 4)) + s.slice(-2)
}

export function init (ctx) {
  ctx.registerPage({
    id: 'gok-camp-im',
    title: '营地消息',
    icon: '📨',
    priority: 50,
    src: 'page.html',
    style: 'page.css'
  })

  // 读：账号列表 + 开关状态
  ctx.registerApi('get', '/gok-camp-im/accounts', async (_req, res) => {
    try {
      res.json({ ok: true, ...snapshot() })
    } catch (error) {
      ctx.logger.error('[营地消息] 读账号列表失败', error)
      res.status(500).json({ ok: false, error: error.message || '读取失败' })
    }
  })

  // 写：保存开关
  ctx.registerApi('post', '/gok-camp-im/accounts', async (req, res) => {
    try {
      const list = Array.isArray(req.body?.accounts) ? req.body.accounts : []
      for (const item of list) {
        const userId = String(item?.userId || '').trim()
        if (!userId) continue
        store.setAccountEnabled(userId, item.enable === true)
      }
      // 让插件重读（否则它内存里的缓存还是旧的）
      store.invalidate()
      res.json({ ok: true, ...snapshot(), message: '已保存' })
    } catch (error) {
      ctx.logger.warn('[营地消息] 保存开关失败', error)
      res.status(400).json({ ok: false, error: error.message || '保存失败' })
    }
  })
}
