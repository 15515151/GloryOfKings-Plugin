/**
 * 配置迁移的回归测试：老字段的值必须被**搬到新字段**，老键必须被删掉。
 *
 * 为什么这个文件重要：迁移是「一次性、静默、改用户文件」的动作。它要是搬错或搬丢，
 * 用户手上的令牌就没了 —— 而令牌是观战/消息服务启动的硬前提（换不到租约不启动）。
 * 所以三条都要钉死：**值不丢、老键删掉、幂等不重复写**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { cleanup, makeSandbox, run, PLUGIN_DIR } from './helpers/sandbox.mjs'

/** 造一份「老版本留下来的」配置，摆进沙箱的 config/config/config.yaml */
const LEGACY = {
  onlineReminder: true,
  battleResultCron: '0 */5 * * * *',
  shareEnabled: true,
  // 老键（要被搬走 / 删掉）
  distUrl: 'https://legacy.example.com:6868',
  shareToken: 'gok_legacy_token_value_should_move',
  distAdminSecret: 'dead_beef_secret',
  distRepoUrl: 'https://github.com/someone/private-repo',
  onlineReminderCron: '*/10 * * * * *',
  // 新键留空，好验证「搬过来」
  shareApiUrl: '',
  distToken: ''
}

/** 手写的「老版本配置」：带注释、带老键、带值 */
const LEGACY_YAML = [
  '# 这行用户注释不能被吃掉',
  'onlineReminder: true',
  "battleResultCron: '0 */5 * * * *'",
  'shareEnabled: true',
  '# 下面这行是服务地址（老键）',
  'distUrl: https://legacy.example.com:6868',
  '# 这行是令牌（老键）',
  "shareToken: gok_legacy_token_value_should_move",
  "distAdminSecret: dead_beef_secret",
  'distRepoUrl: https://github.com/someone/private-repo',
  "onlineReminderCron: '*/10 * * * * *'",
  "shareApiUrl: ''",
  "distToken: ''"
].join('\n') + '\n'

function setup (configObject = null) {
  const root = makeSandbox()
  const file = path.join(root, 'config', 'config', 'config.yaml')
  // ⚠️ 手写 YAML 才能带注释：YAML.stringify 不输出注释，而「迁移不能吃掉注释」
  //    正是这个文件要钉的坑之一（第一版迁移用 stringify，把 92 行注释抹平了）。
  //    传了对象就用对象（顶部补一条注释），没传才用手写的那份。
  const yaml = configObject
    ? '# 顶部注释（迁移不许动它）\n' + YAML.stringify(configObject)
    : LEGACY_YAML
  fs.writeFileSync(file, yaml, 'utf8')

  // 让迁移模块在沙箱里跑：把 PluginPath 指到沙箱
  const mf = path.join(root, 'utils', 'migrateConfig.js')
  const src = fs.readFileSync(path.join(PLUGIN_DIR, 'utils', 'migrateConfig.js'), 'utf8')
    .replace(/const CONFIG_DIR = .*/, `const CONFIG_DIR = ${JSON.stringify(path.join(root, 'config', 'config'))}`)
  fs.writeFileSync(mf, src)
  // 模板键序用得上，拷一份真的进去
  fs.copyFileSync(
    path.join(PLUGIN_DIR, 'config', 'default_config', 'config.yaml'),
    path.join(root, 'config', 'default_config', 'config.yaml')
  )
  return { root, file }
}

function readConfig (file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'))
}

test('迁移：老键的值搬到新键，老键全删掉', () => {
  const { root, file } = setup(LEGACY)
  try {
    const out = run(root, `
import { migrateConfigFile } from './utils/migrateConfig.js'
const r = migrateConfigFile()
console.log(JSON.stringify(r))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    const res = JSON.parse(out.stdout)
    assert.equal(res.changed, true, '迁移没生效')

    const after = readConfig(file)
    // ⭐ 值必须搬过来（令牌丢了用户就跑不起来）
    assert.equal(after.shareApiUrl, 'https://legacy.example.com:6868')
    assert.equal(after.distToken, 'gok_legacy_token_value_should_move')
    // 老键必须删掉（代码里已经没有回退了）
    for (const k of ['distUrl', 'shareToken', 'distAdminSecret', 'distRepoUrl', 'onlineReminderCron']) {
      assert.equal(k in after, false, `老键 ${k} 没删掉`)
    }
    // 别的用户设置一个都不能动
    assert.equal(after.onlineReminder, true)
    assert.equal(after.battleResultCron, '0 */5 * * * *')
    assert.equal(after.shareEnabled, true)
  } finally {
    cleanup(root)
  }
})

test('迁移：**不能吃掉注释**（第一版用 YAML.stringify 把注释全抹平了）', () => {
  const { root, file } = setup()
  try {
    const out = run(root, `
import { migrateConfigFile } from './utils/migrateConfig.js'
console.log(JSON.stringify(migrateConfigFile()))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    assert.equal(JSON.parse(out.stdout).changed, true)

    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('# 这行用户注释不能被吃掉'), '顶部注释被迁移吃掉了')
    // ⚠️ 预期行为：注释挂在键节点上，删键时它自己的注释一起走；被保留的键的注释必须留下。
    //    第一版用 `YAML.stringify` 时是**所有**注释都没了（包括顶部这段），那才是要防的。
    const parsed = YAML.parse(after)
    assert.equal(parsed.distToken, 'gok_legacy_token_value_should_move')
    assert.equal('shareToken' in parsed, false)
    assert.equal('distUrl' in parsed, false)
    assert.ok(after.split('\n').length > 5, '文件被压成一行了')
  } finally {
    cleanup(root)
  }
})

test('迁移：幂等（第二次跑不写文件、不再报改动）', () => {
  const { root, file } = setup(LEGACY)
  try {
    const out = run(root, `
import fs from 'node:fs'
import { migrateConfigFile } from './utils/migrateConfig.js'
const first = migrateConfigFile()
const before = fs.statSync('config/config/config.yaml').mtimeMs
const second = migrateConfigFile()
const after = fs.statSync('config/config/config.yaml').mtimeMs
console.log(JSON.stringify({ first, second, mtimeChanged: before !== after }))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.first.changed, true)
    assert.equal(r.second.changed, false, '第二次还报改动 = 不幂等')
    assert.equal(r.mtimeChanged, false, '第二次还写了文件')
    // 值仍然在
    assert.equal(readConfig(file).distToken, 'gok_legacy_token_value_should_move')
  } finally {
    cleanup(root)
  }
})

test('迁移：新键已经有值时以新键为准（不被老键顶掉）', () => {
  const { root, file } = setup({
    ...LEGACY,
    shareApiUrl: 'https://new.example.com:442',
    distToken: 'gok_new_token_wins'
  })
  try {
    const out = run(root, `
import { migrateConfigFile } from './utils/migrateConfig.js'
console.log(JSON.stringify(migrateConfigFile()))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    const after = readConfig(file)
    assert.equal(after.shareApiUrl, 'https://new.example.com:442')
    assert.equal(after.distToken, 'gok_new_token_wins')
    assert.equal('distUrl' in after, false)
    assert.equal('shareToken' in after, false)
  } finally {
    cleanup(root)
  }
})

test('迁移：没有老键时什么都不做（不碰文件）', () => {
  const { root, file } = setup({ onlineReminder: true, shareApiUrl: 'https://x.example.com' })
  try {
    const out = run(root, `
import fs from 'node:fs'
import { migrateConfigFile } from './utils/migrateConfig.js'
const before = fs.statSync('config/config/config.yaml').mtimeMs
const r = migrateConfigFile()
console.log(JSON.stringify({ r, mtimeChanged: before !== fs.statSync('config/config/config.yaml').mtimeMs }))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.r.changed, false)
    assert.equal(r.mtimeChanged, false)
  } finally {
    cleanup(root)
  }
})

test('迁移：用户配置还不存在时不炸（首次启动由 Config 自己建）', () => {
  const root = makeSandbox()
  try {
    fs.rmSync(path.join(root, 'config', 'config', 'config.yaml'), { force: true })
    const mf = path.join(root, 'utils', 'migrateConfig.js')
    const src = fs.readFileSync(path.join(PLUGIN_DIR, 'utils', 'migrateConfig.js'), 'utf8')
      .replace(/const CONFIG_DIR = .*/, `const CONFIG_DIR = ${JSON.stringify(path.join(root, 'config', 'config'))}`)
    fs.writeFileSync(mf, src)
    const out = run(root, `
import { migrateConfigFile } from './utils/migrateConfig.js'
console.log(JSON.stringify(migrateConfigFile()))
`, { timeoutMs: 30000 })
    assert.ok(out.ok, out.stderr)
    const r = JSON.parse(out.stdout)
    assert.equal(r.changed, false)
    assert.equal(r.reason, 'no-user-config')
  } finally {
    cleanup(root)
  }
})
