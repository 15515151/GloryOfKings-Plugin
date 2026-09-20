/**
 * 营地消息 —— 锅巴扩展页面（可视化管理）。
 *
 * ## 为什么单独做一个页面
 * 锅巴的静态 schema（`guoba.support.js`）只能渲染「固定结构 + 动态数据」，
 * 没法做「每账号一行、带头像/在线状态/独立开关」这种运行时形状的列表。
 *
 * ## 两套锅巴约定共用这一份 init
 * 本文件是页面/接口注册的**唯一实现**：
 *   · 新锅巴（1.4.x）扫 `plugins/<插件名>/webadapter/` —— 就是本文件；
 *   · 旧锅巴（CustomPageService 的 `PAGE_DIRS`）扫 `plugins/<插件名>/guoba/` ——
 *     由 `guoba/index.js` 转出本文件的 `init`。
 *
 * ⚠️ 实现放在 webadapter/ 这一侧（而不是 guoba/）是有意的：锅巴「重新扫描」时用
 *    `import('...?t=时间戳')` 重载的是**入口文件本身**，把它放这儿改完重扫即生效；
 *    若实现留在 guoba/ 再由入口转出，重扫读到的仍是被缓存的老模块，得重启进程。
 *
 * `init` 里的 `src: 'page.html'` / `style: 'page.css'` 由锅巴按**加载它的目录**
 * 解析，所以 `guoba/` 与 `webadapter/` 各放一份页面资源。
 *
 * ## 接口挂在哪
 * `ctx.registerApi` 注册的接口由锅巴统一挂载并套登录鉴权 —— 别绕过它去裸挂
 * express（那样没有鉴权）。实际地址随锅巴版本不同：
 *   · 新锅巴：`<__webBase>/web-page/api/<插件名>/<route>`；
 *   · 旧锅巴：`/api/custom/<插件名>/<route>`。
 * 页面按 `<__webBase>/api/<route>`（旧锅巴则是 `<__apiBase>/<route>`）拼即可，
 * 新锅巴的引导脚本会按注册过的路由自动改写地址并补 token。
 *
 * ## ctx.logger 各家不一样
 * 锅巴的扩展 ctx 只给 `error / warn / info / debug`，**没有 `mark`**；直接调
 * `ctx.logger.mark` 会抛 TypeError（见下面的 `logMark`）。日志统一走 `logMark`。
 */
import authStore from '../utils/authStore.js'
import * as store from '../utils/campImStore.js'
import { ownerOf } from '../utils/campImPush.js'

/**
 * 锅巴面板用的账号快照。
 *
 * ⚠️⚠️ 列的**只是「收消息名单」里的号** —— 这份名单跟「轮询用的全局账号池」
 *    （`AuthPool.json`）是两回事：账号池扫进来是给查询/推送轮询用的，
 *    **不代表它要挂 ws 收消息**。早先这里是把池子里的号全列出来、默认开，
 *    账号一多就没法管（2026-09-20 主人指出「谁说扫了全局账号就一定要做收消息」）。
 *
 * 没进名单的号放在 `available` 里，页面上用「＋ 添加」挑。
 */
function snapshot () {
  const switches = store.getAccountSwitches()          // { userId: true }
  const all = authStore.listAccounts().filter(a => a?.userId && a?.userSig)
  const infoOf = new Map(all.map(a => [String(a.userId), a]))

  const build = (userId, enable) => {
    const a = infoOf.get(String(userId)) || {}
    return {
      userId: String(userId),
      nickname: a.nickname || a.userName || '',
      avatar: a.avatar || a.icon || '',
      // 归属人：没有就是空串（那批 2026-09-17 之前扫的老号，不推消息）
      owner: ownerOf(userId),
      ownerMasked: mask(ownerOf(userId)),
      enable
    }
  }

  const accounts = Object.keys(switches).map(uid => build(uid, true))

  // 登录过、但还没进收消息名单的号（给「＋ 添加」用）
  const available = all
    .filter(a => !switches[String(a.userId)])
    .map(a => ({
      userId: String(a.userId),
      nickname: a.nickname || a.userName || '',
      owner: ownerOf(a.userId),
      ownerMasked: mask(ownerOf(a.userId))
    }))

  // 没归属人的排后面，其余按昵称
  accounts.sort((x, y) => {
    if (Boolean(x.owner) !== Boolean(y.owner)) return x.owner ? -1 : 1
    return String(x.nickname).localeCompare(String(y.nickname), 'zh')
  })

  return {
    accounts,
    available,
    total: accounts.length,
    enabled: accounts.length,
    ownered: accounts.filter(a => a.owner).length
  }
}

/** QQ 号打码（页面上只给主人看，不用全露） */
function mask (id) {
  const s = String(id || '')
  if (s.length <= 4) return s
  return s.slice(0, 2) + '*'.repeat(Math.max(0, s.length - 4)) + s.slice(-2)
}

/**
 * 打一条 `mark` 级日志，但**永不抛异常**。
 *
 * ⚠️⚠️ 各家的扩展 `ctx.logger` 不是同一套：
 *   · QQBot-Web-Adapter：有 `mark`（就是云崽那套 logger）—— 所以那边一直正常；
 *   · 锅巴：只有 `error / warn / info / debug`（见 Guoba 的 `normalizeLogger`），
 *     **没有 `mark`**。直接 `ctx.logger.mark(...)` 抛 TypeError，被下面的 catch
 *     接住返回 400 `{ok:false}` —— 而写盘早在抛之前就做完了，于是页面报
 *     「保存失败」、实际却已经保存（2026-09-20 主人实测）。
 * 这里按 `mark → info → log` 取第一个存在的，保证日志本身不会再把请求带崩。
 */
function logMark (logger, ...args) {
  for (const level of ['mark', 'info', 'log']) {
    const fn = logger?.[level]
    if (typeof fn === 'function') return fn.apply(logger, args)
  }
}

export function init (ctx) {
  // ⚠️⚠️ `style` 字段**必须写**：锅巴的 `resolveAsset()` 按白名单放行静态资源，
  //    没在描述符里声明的文件会被 403（页面里自己写 `<link href="page.css">` 也拿不到）。
  //
  // ⚠️⚠️ **但这也意味着 CSS 会被注入到【面板主文档】的 `<head>`**（见锅巴前端
  //    `views/custom/index.vue` 的 `injectAssets()`）—— 是**全局**的，不是 iframe 内。
  //    所以类名**必须加前缀**，否则会和别的插件的自定义页面互相覆盖
  //    （实测 `.card` / `.toggle` / `.list` 撞上了 Gscore-Adapter，把人家页面搞花了）。
  //    本页统一用 `gki-` 前缀（GloryOfKings IM）。
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

  // 写：保存收消息名单
  //
  // ⚠️⚠️ **以提交上来的列表为准**（不在列表里的 = 从名单里移出）。
  //    早先是「只逐个 set」，于是「删掉一行」永远不生效 —— 因为删掉的行根本不在提交里。
  //    前端是**全量提交**当前名单的，所以这里必须做差集。
  ctx.registerApi('post', '/gok-camp-im/accounts', async (req, res) => {
    try {
      // body 没解析出来时**直接报错**，别当成「清空名单」把人家全删了
      if (!req.body || !Array.isArray(req.body.accounts)) {
        return res.status(400).json({ ok: false, error: '没收到名单数据' })
      }
      const wanted = new Set(
        req.body.accounts
          .filter(i => i?.enable === true)
          .map(i => String(i.userId || '').trim())
          .filter(Boolean)
      )
      // 先移出：名单里有、但这次没提交的
      for (const uid of Object.keys(store.getAccountSwitches())) {
        if (!wanted.has(uid)) store.setAccountEnabled(uid, false)
      }
      // 再加入
      for (const uid of wanted) store.setAccountEnabled(uid, true)
      // 让插件重读（否则它内存里的缓存还是旧的）
      store.invalidate()
      const after = snapshot()
      logMark(ctx.logger, `[营地消息] 收消息名单已更新：${after.total} 个号（${[...wanted].join(',') || '空'}）`)
      res.json({ ok: true, ...after, message: '已保存' })
    } catch (error) {
      ctx.logger.warn('[营地消息] 保存名单失败', error)
      res.status(400).json({ ok: false, error: error.message || '保存失败' })
    }
  })
}
