/**
 * 配置迁移：把老字段里的值搬到新字段，然后**把老键删掉**。
 *
 * ## 为什么需要它（而不是「读取时回退」）
 *
 * 合并之前是三套服务各有一套配置键，合并之后地址和令牌都只剩一个：
 *
 *   `distUrl`      → `shareApiUrl`   （服务地址，观战/消息/共享库共用）
 *   `shareToken`   → `distToken`      （接入令牌，同一个）
 *   `distAdminSecret` → 删（死键，服务端只认 GOK_ADMIN_SECRET）
 *   `distRepoUrl`     → 删（死键，dist 分支早不存在）
 *   `onlineReminderCron` → 删（已废弃，模板里早就摘了，老机器上还留着）
 *
 * 之前的做法是**读的时候用 `||` 回退**（`shareApiUrl || distUrl`）。那有四个毛病：
 *   · 代码里到处都是 `||`，每加一个消费方就多一处要记得回退 —— 已经漏过一次
 *     （共享库只读 shareApiUrl，老机器误报「还没接入」）
 *   · 锅巴面板要额外做一遍「老键顶到新键」的整形，否则那一栏显示为空
 *   · 令牌有两个键、且**只在老键里有值**时，面板上看不见（真踩过）
 *   · 两套键同时有值就没人说得清以谁为准
 *
 * 所以改成：**启动时一次性搬过去，之后代码只认新键**。
 *
 * ## 三条硬规矩
 *
 * 1. **幂等**：跑一百次和跑一次结果一样；没有要改的就一个字节都不写。
 * 2. **原子写**：走 `data/.*` 那套临时文件 + rename，绝不留半截配置。
 * 3. **不改值**：只搬键和删废弃键，用户设置的值原样保留（尤其令牌）。
 *
 * ⚠️ 不在模块顶层执行：必须由 `index.js` 在「加载 app 之前」显式调用一次，
 *    否则任一 app 的 import 都可能先读到还没迁移的配置。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { PluginPath, PluginName } from '#components'
import { writeFileAtomic } from './safeStore.js'

/** 生效配置所在目录（和 components/Config.js 是同一个路径） */
const CONFIG_DIR = path.join(PluginPath, 'config', 'config')

/**
 * 迁移规则。顺序有意义：先搬值，再删废弃键。
 * 每一项都是「老键 → 新键」；`null` 表示这个键直接删掉。
 */
const MOVE = [
  ['distUrl', 'shareApiUrl'],
  ['shareToken', 'distToken']
]
const DROP = ['distAdminSecret', 'distRepoUrl', 'onlineReminderCron']

/** 空值判定：空串 / 全空白都算没配 */
function blank (v) {
  return String(v ?? '').trim() === ''
}

/**
 * 在**文档**上做迁移，而不是「解析成对象 → 重新序列化」。
 *
 * ⚠️⚠️ 这一点是踩过坑才写下来的：第一版用的是 `YAML.parse` + `YAML.stringify`，
 * 值搬对了，但 `YAML.stringify` **不保留注释** —— 生效配置里那 92 行说明
 * （默认模板的注释）被一次性抹平，文件从 10KB 掉到 891 字节。
 * `YAML.parseDocument` 把注释挂在文档节点上，删键 / 设值都不动它们。
 *
 * @param {import('yaml').Document} doc
 * @returns {string[]} 实际做了哪些事（空数组 = 没变化）
 */
function migrateDocument (doc) {
  const changed = []
  const valueOf = key => doc.get(key)

  for (const [oldKey, newKey] of MOVE) {
    if (!doc.has(oldKey)) continue

    const oldVal = valueOf(oldKey)
    // 老键有值、新键为空 → 搬过去；两边都有值就以新键为准
    if (blank(valueOf(newKey)) && !blank(oldVal)) {
      doc.set(newKey, oldVal)
      changed.push(`${oldKey} → ${newKey}`)
    } else {
      changed.push(`删除空/重复的 ${oldKey}`)
    }
    doc.delete(oldKey)
  }

  for (const key of DROP) {
    if (!doc.has(key)) continue
    // 死键/废弃键里有值也照删 —— 它们没有任何读取点，留着只会让人以为还要配
    changed.push(blank(valueOf(key)) ? `删除废弃键 ${key}` : `删除废弃键 ${key}（有值）`)
    doc.delete(key)
  }

  return changed
}

/**
 * 迁移 `config/config/config.yaml`（只迁配置文件，不动数据文件）。
 *
 * ⚠️ 这里**不打日志**（早期版本在这里打了 `mark`，调用方又打了一条 `info`，
 *    同一条迁移信息在启动日志里出现两遍）。日志、以及「要不要清配置缓存」都交给调用方决定。
 *
 * @returns {{changed: boolean, actions: string[], invalidate?: boolean, reason?: string}}
 */
export function migrateConfigFile () {
  const file = path.join(CONFIG_DIR, 'config.yaml')

  if (!fs.existsSync(file)) {
    // 首次启动 → Config 会自己从模板建一份，这里什么都不用做
    return { changed: false, actions: [], reason: 'no-user-config' }
  }

  let doc
  try {
    doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'), { keepSourceTokens: true })
  } catch (error) {
    // 解析不出来（用户写坏了 YAML）→ 交给 Config 的容错去兜，迁移不动它
    return { changed: false, actions: [], reason: `unreadable: ${error?.message || error}` }
  }
  if (!doc || typeof doc.get !== 'function' || !doc.contents) {
    return { changed: false, actions: [], reason: 'unreadable' }
  }

  const changed = migrateDocument(doc)
  if (!changed.length) return { changed: false, actions: [] }

  try {
    // 一次原子写（不是 YamlReader 那种「每个键写一次文件」）
    writeFileAtomic(file, String(doc))
  } catch (error) {
    // 迁移失败不能拦住插件启动：老键还在，运行时也会报「没配地址」而不是崩
    return { changed: false, actions: [], reason: `write-failed: ${error?.message || error}` }
  }

  // invalidate：迁移是**直接改文件**，而 Config 单例可能已经把老内容读进内存缓存了，
  // 调用方需要把缓存清掉（下一次 getDefOrConfig 重新读盘）
  return { changed: true, actions: changed, invalidate: true }
}

export default { migrateConfigFile }
