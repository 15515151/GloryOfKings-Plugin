/**
 * 启动配置：环境变量的读取与硬校验。
 *
 * 这里刻意不做任何「缺了就自动生成一个」的兜底。GOK_SALT 一旦由程序生成并写回磁盘，
 * 它就和数据库躺在同一个备份里，「加盐哈希」的全部意义当场归零——拿到备份的人
 * 顺手就把盐也拿到了。所以缺了就直接拒绝启动，让部署的人自己生成、自己分开保管。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** node:sqlite 在 24 之前要么不存在、要么要开实验开关、要么 API 还没定型，锁死 24 最省事 */
export const MIN_NODE_MAJOR = 24

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 密钥最短长度。32 个字符对应 openssl rand -hex 32 的输出长度 */
const MIN_SECRET_LENGTH = 32

function fail (message) {
  process.stderr.write(`[gok-share] 启动失败：${message}\n`)
  process.exit(1)
}

/**
 * 版本不对时给人话提示。
 * 不做这一步的话，用户拿到的是一句 `Cannot find module 'node:sqlite'`，
 * 他会去搜「node sqlite 装不上」，然后浪费一晚上。
 */
export function assertRuntime () {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    fail(
      `需要 Node.js ${MIN_NODE_MAJOR} 或更高版本（当前 ${process.versions.node}）。\n` +
      `        共享库用到 Node 内置的 node:sqlite 模块，低版本里没有这个模块。\n` +
      '        用 nvm 的话：nvm install 24 && nvm use 24'
    )
  }
}

function readSecret (env, name) {
  const value = String(env[name] || '').trim()
  if (!value) {
    fail(
      `缺少环境变量 ${name}。\n` +
      `        生成一个：openssl rand -hex 32\n` +
      '        生成后放进 systemd 的 EnvironmentFile（权限设成 600），不要提交进 git、不要放进任何备份'
    )
  }
  if (value.length < MIN_SECRET_LENGTH) {
    fail(`${name} 太短（至少 ${MIN_SECRET_LENGTH} 个字符）。用 openssl rand -hex 32 生成一个。`)
  }
  return value
}

function readPort (env) {
  const raw = String(env.GOK_PORT || '').trim()
  if (!raw) return 8787

  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`GOK_PORT 不是合法端口号：${raw}`)
  }
  return port
}

function readInt (env, name, fallback, min, max) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback

  const value = Number(raw)
  if (!Number.isFinite(value)) fail(`${name} 必须是数字：${raw}`)
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{host: string, port: number, dbPath: string, salt: string, adminSecret: string,
 *            trustProxy: boolean, publicUrl: string}}
 */
export function loadConfig (env = process.env) {
  const salt = readSecret(env, 'GOK_SALT')
  const adminSecret = readSecret(env, 'GOK_ADMIN_SECRET')

  // 两个密钥共用一个值，等于把「签发 token 的钥匙」和「还原 QQ 的钥匙」绑在一起，
  // 泄露一个就同时丢两样
  if (salt === adminSecret) {
    fail('GOK_SALT 和 GOK_ADMIN_SECRET 不能是同一个值，它们必须各自独立生成。')
  }

  const dbPath = String(env.GOK_DB || '').trim() || path.join(SERVER_ROOT, 'data', 'share.db')
  const host = String(env.GOK_HOST || '').trim() || '127.0.0.1'

  // 监听回环 = 前面必然有反代（不然外面连不上），此时所有请求的 remoteAddress 都是
  // 反代自己那个 IP。这种情况下不读 X-Forwarded-For，按 IP 的限流就退化成全局限流——
  // 一个 60 次/分钟的桶会把整个服务卡死，谁都连不上。
  //
  // 反过来，监听 0.0.0.0 时默认**不信**这个头：任何人都能伪造它绕过限流。
  // GOK_TRUST_PROXY 显式设了就以它为准。
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  const trustProxyRaw = String(env.GOK_TRUST_PROXY || '').trim()

  return {
    host,
    port: readPort(env),
    dbPath,
    salt,
    adminSecret,
    trustProxy: trustProxyRaw === '' ? loopback : trustProxyRaw === '1',
    // (client, qq) 的响应冷却。0 = 关掉（压测和脱机测试时用），见 ratelimit.mjs 的 Cooldown
    readCooldownMs: readInt(env, 'GOK_READ_COOLDOWN_MS', 60000, 0, 3600000),
    // 仅供日志与文档展示，服务本身不依赖它
    publicUrl: String(env.GOK_PUBLIC_URL || '').trim()
  }
}

export { SERVER_ROOT }
