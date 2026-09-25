/**
 * 服务端代码分发的**客户端**（P3-B）：取密钥 → 解密 → 落二进制。
 *
 * ## 为什么和 utils/deploy.js 分成两个文件
 *
 * `deploy.js` 留下的是和「分发协议」无关的东西（tar 解包、地址规范化、探活）。
 * 这里放的是**协议层**：设备号、`/latest`、`/download`、`/key`、AES-256-GCM 解密、
 * 以及「把 native 包装成可执行二进制」的那套原子流程。
 *
 * ## 三条硬规矩
 *
 * 1. **失败保留旧版**。这是契约 §2.4 / §3 明确点名的坑：一次网络抖动不该把群友
 *    正在用的服务弄没。所以下载、解密、校验、解包、自检全部发生在
 *    `<server>/.staging-*` 里，**最后一步才 rename 覆盖**；任何一步失败只删 staging，
 *    磁盘上的旧二进制和台账一个字节都不动。
 * 2. **台账里的 sha + 二进制自检通过，就不重下**（契约 §2.2 第③步）。主人反复发
 *    部署指令不会把 1.6MB 的密文重打一遍；要强制重下走 `#营地…重装`（`force`）。
 * 3. **令牌只进 Authorization 头**，不进日志、不进 argv。日志里只出现掩码后的地址。
 *
 * ## 为什么不直接用响应头
 *
 * `/download` 的响应头（`X-Gok-Plain-Sha256` 等）只是**方便**，真正信的是
 * `/key` 回的 `sha256Plain`：容器是自包含的，响应头可以被中间层改写，而 GCM 的
 * 认证标签 + 明文摘要是对着字节算的。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { Config, PluginData, PluginName } from '#components'
import { assetName, binaryName, detectTarget, isSupportedTarget } from './platform.js'
import { extractTarGz, normalizeBase } from './deploy.js'

/** 设备号文件。契约 §2.1 定的路径与格式：32 位小写 hex，0600 */
export const DEVICE_FILE = path.join(PluginData, 'device.guid')

/** 原生包的安装台账（和 js 时代的 .gok-pkg.json 分开：两者格式不一样，混着读会认错） */
export const NATIVE_STATE_FILE = '.gok-native.json'

/** 二进制自检超时。正常 `--version` 是毫秒级，5 秒足够，卡住说明这个二进制不对 */
const SELFCHECK_TIMEOUT_MS = 5000

/* ------------------------------------------------------------ 配置 */

function cfg () {
  try {
    return Config.getDefOrConfig('config') || {}
  } catch {
    return {}
  }
}

/**
 * 服务地址 + 令牌（三套服务共用）。
 *
 * ⚠️ 这里**只认新键** `shareApiUrl` / `distToken`，不再 `||` 回退老键。
 * 老键（`distUrl` / `shareToken`）由 `utils/migrateConfig.js` 在插件启动时
 * 一次性搬过来并删掉 —— 见那个文件的头注释，这里不重复理由。
 *
 * 注：契约 §7 原本写的是「回落到老的 distUrl / distToken」。本插件改为
 * **启动时迁移**而不是读时回退，所以这一条不再逐字照做；老机器靠迁移兼容。
 */
export function readDistConfig () {
  const c = cfg()
  return {
    url: normalizeBase(c.shareApiUrl),
    token: String(c.distToken || '').trim()
  }
}

/** 给用户看的简短地址（去掉 token 之类可能藏在 query 里的东西） */
export function safeUrl (url) {
  return String(url || '').split('?')[0]
}

/* ------------------------------------------------------------ 设备号 */

let cachedDevice = null

/**
 * 设备号：既当 `X-Gok-Device` 头，也当 `GOK_DEVICE_GUID` 传给子进程。
 *
 * ⚠️ **必须是同一个值**（契约 §2.1）：否则分发台账里会多出一台幽灵机器，
 * 而且二进制自己心跳用的设备号和 `/key` 记账用的对不上。
 * 所以这里只在这里生成一次、同一份文件、同一个返回值。
 *
 * @returns {string} 32 位小写 hex
 */
export function deviceGuid () {
  if (cachedDevice) return cachedDevice

  try {
    const saved = fs.readFileSync(DEVICE_FILE, 'utf8').trim().toLowerCase()
    if (/^[0-9a-f]{32}$/.test(saved)) {
      cachedDevice = saved
      return cachedDevice
    }
  } catch {
    // 文件不在 / 读坏了 → 下面重新生成
  }

  const made = crypto.randomBytes(16).toString('hex')
  fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true })
  fs.writeFileSync(DEVICE_FILE, made, { mode: 0o600 })
  cachedDevice = made
  return cachedDevice
}

/* ------------------------------------------------------------ 小工具 */

/** 选一个 fetch：测试里可以传假的，运行时用 Node 24 内建的全局 fetch */
function pickFetch (override) {
  return override || customFetch || globalThis.fetch
}

/** 单测注入点。生产代码不要碰 */
export let customFetch = null
export function setFetchForTest (impl) {
  customFetch = impl
}

/** sha256 的 hex。整包进内存（最大几 MB），不用流式 */
export function sha256Hex (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** 读一个可执行文件的自检输出（`gok-watch --version` → `gok-watch 0.2.0 (x86_64-…)`） */
function selfCheck (bin) {
  const r = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: SELFCHECK_TIMEOUT_MS,
    windowsHide: true
  })
  if (r.error) return { ok: false, message: r.error.message }
  if (r.status !== 0) return { ok: false, message: `退出码 ${r.status}` }
  return { ok: true, out: String(r.stdout || '').trim() }
}

/* ------------------------------------------------------------ 网络 */

/**
 * 所有分发请求的统一入口：带令牌和设备号，把失败翻成 `{ok:false, message}`。
 * 契约 §6 的错误码在这里集中翻译一次，别让每个调用点各写一份。
 */
async function request (pathname, { url, token, timeout, headers = {}, fetchImpl } = {}) {
  const base = normalizeBase(url)
  if (!base) return { ok: false, message: '还没配分发服务地址' }
  if (!token) return { ok: false, message: '还没配分发令牌' }

  const doFetch = pickFetch(fetchImpl)
  if (!doFetch) return { ok: false, message: '当前 Node 没有 fetch（需要 Node 18+）' }

  let res
  try {
    res = await doFetch(base + pathname, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Gok-Device': deviceGuid(),
        ...headers
      },
      signal: AbortSignal.timeout(timeout)
    })
  } catch (error) {
    const timeoutish = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return { ok: false, message: timeoutish ? '连分发服务超时' : '连不上分发服务（检查地址和网络）' }
  }

  // 304 不带 body，交给调用方处理
  if (res.status === 304) return { ok: true, notModified: true, res }

  if (!res.ok) return { ok: false, status: res.status, message: await describeError(res, pathname) }

  return { ok: true, res }
}

/** 把服务端的错误响应翻译成人能看懂的一句话 */
async function describeError (res, pathname) {
  const body = await res.json().catch(() => null)
  const code = String(body?.error || '')

  switch (res.status) {
    case 400:
      if (code === 'missing_device' || code === 'invalid_device') {
        return `设备号没带上或者格式不对（${code}）—— 删掉 data/device.guid 再试一次`
      }
      if (code === 'invalid_target') {
        return '服务端不认识这台机器的平台标识（invalid_target），多半是插件和服务端版本对不上'
      }
      return `请求不合法（HTTP 400${code ? ` ${code}` : ''}）`
    case 401:
      return '令牌无效，找主人要一个新的'
    case 403:
      return '令牌已被吊销，找主人要一个新的'
    case 404:
      return code === 'no_such_package'
        ? `服务器上没有这个包（${pathname.split('/')[4] || '?'}）`
        : '服务端没有这个接口（版本对不上）'
    case 429:
      return '被服务端限流了，过一会儿再试'
    case 500:
      // 契约 §6：500 是服务端自己的问题，**不是**授权没了，绝不能因此停服
      return '服务端打包失败（详情看服务端日志）'
    default:
      return `分发服务返回 HTTP ${res.status}`
  }
}

/**
 * `GET /api/v1/packages/:name/latest?target=` —— 只问版本，不触发打包。
 *
 * native 包必须带 target（契约 §5）：不带会拿到 400 invalid_target。
 *
 * @returns {Promise<{ok: boolean, sha?: string, kind?: string, asset?: string,
 *   sizePlain?: number|null, sha256?: string|null, keyId?: string, message?: string}>}
 */
export async function fetchLatest (name, target, { url, token, timeout = 15000, fetchImpl } = {}) {
  if (!isSupportedTarget(target)) return { ok: false, message: `不支持的平台标识：${target}` }

  const q = `?target=${encodeURIComponent(target)}`
  const r = await request(`/api/v1/packages/${encodeURIComponent(name)}/latest${q}`, {
    url, token, timeout, fetchImpl
  })
  if (!r.ok) return r

  const data = await r.res.json().catch(() => null)
  if (!data?.sha) return { ok: false, message: '服务端返回的内容看不懂（没有版本号）' }
  if (data.kind !== 'native') {
    return {
      ok: false,
      message: `服务器上的「${name}」不是原生包（kind=${data.kind || '未知'}）—— ` +
        '这套插件现在只认原生二进制，找主人确认服务端的 GOK_PACKAGES'
    }
  }

  const want = assetName(name, target)
  if (data.asset && data.asset !== want) {
    return { ok: false, message: `服务端给的产物名对不上（期望 ${want}，实际 ${data.asset}）` }
  }

  return {
    ok: true,
    sha: String(data.sha),
    kind: data.kind,
    asset: data.asset || want,
    target: data.target || target,
    sizePlain: data.sizePlain ?? null,
    sha256: data.sha256 ?? null,
    keyId: data.enc?.keyId || null
  }
}

/**
 * `GET .../download?sha=&target=` —— 拿密文容器（几 MB，整包进内存）。
 *
 * @param {{etag?: string}} [opts] 带上上次的 ETag，服务端没变化会回 304
 */
export async function downloadBundle (name, sha, target, { url, token, etag, timeout = 180000, fetchImpl } = {}) {
  if (!isSupportedTarget(target)) return { ok: false, message: `不支持的平台标识：${target}` }

  const q = `?sha=${encodeURIComponent(sha)}&target=${encodeURIComponent(target)}`
  const r = await request(`/api/v1/packages/${encodeURIComponent(name)}/download${q}`, {
    url,
    token,
    timeout,
    fetchImpl,
    headers: etag ? { 'If-None-Match': etag } : {}
  })
  if (!r.ok) return r
  if (r.notModified) return { ok: true, notModified: true, etag }

  let buffer
  try {
    buffer = Buffer.from(await r.res.arrayBuffer())
  } catch {
    return { ok: false, message: '下载中断（检查网络）' }
  }
  if (!buffer.length) return { ok: false, message: '下到的文件是空的' }

  return {
    ok: true,
    buffer,
    etag: r.res.headers?.get?.('etag') || null,
    keyId: r.res.headers?.get?.('x-gok-key-id') || null,
    plainSha256: r.res.headers?.get?.('x-gok-plain-sha256') || null
  }
}

/**
 * `GET .../key?sha=&target=` —— 拿解密密钥。**必须带设备号**，否则服务端回 400。
 *
 * @returns {{ok: boolean, key?: string, nonce?: string, aad?: string, keyId?: string,
 *   sha256Plain?: string, sizePlain?: number, message?: string}}
 */
export async function fetchKey (name, sha, target, { url, token, timeout = 15000, fetchImpl } = {}) {
  if (!isSupportedTarget(target)) return { ok: false, message: `不支持的平台标识：${target}` }

  const q = `?sha=${encodeURIComponent(sha)}&target=${encodeURIComponent(target)}`
  const r = await request(`/api/v1/packages/${encodeURIComponent(name)}/key${q}`, {
    url, token, timeout, fetchImpl
  })
  if (!r.ok) return r

  const data = await r.res.json().catch(() => null)
  if (!data?.key || !data?.aad) return { ok: false, message: '服务端没给密钥（响应看不懂）' }

  return {
    ok: true,
    key: String(data.key),
    nonce: String(data.nonce || ''),
    aad: String(data.aad),
    keyId: String(data.keyId || ''),
    sha256Plain: String(data.sha256Plain || ''),
    sizePlain: data.sizePlain ?? null
  }
}

/* ------------------------------------------------------------ 解密 */

/**
 * 解一个密文容器。逐字照契约 §4（容器布局见服务端 `seal.mjs`）：
 *
 *     offset 0     8 字节 magic "GOKENC1\0"
 *     offset 8     1 字节 算法（0x01 = aes-256-gcm）
 *     offset 9    12 字节 nonce
 *     offset 21    N 字节密文
 *     末尾 16 字节  GCM tag
 *
 * ⚠️ `setAAD` 必须在 `update` **之前** —— 顺序错了 Node 会直接抛，而且错误信息
 *    长得像「密钥不对」，很难查。
 * ⚠️ `aad` 必须**原样**用 `/key` 回的那个（它绑了包名/版本/target），别自己拼。
 *
 * @param {Buffer} container 下载回来的整个文件
 * @param {string} keyB64    /key 回的 key（base64，32 字节）
 * @param {string} aad       /key 回的 aad
 * @returns {Buffer} 明文（native 包是「单文件 tar.gz」）
 */
export function decryptBundle (container, keyB64, aad) {
  const MAGIC = Buffer.from('GOKENC1\0', 'latin1')

  if (!Buffer.isBuffer(container) || container.length < 21 + 16) {
    throw new Error('密文容器太短（下载被截断了？）')
  }
  if (!container.subarray(0, 8).equals(MAGIC)) {
    throw new Error('magic 不对：下到的不是密文容器（多半是缓存了旧版明文包）')
  }
  if (container[8] !== 0x01) {
    throw new Error(`不认识的加密算法编号 ${container[8]}`)
  }

  const nonce = container.subarray(9, 21)
  const tag = container.subarray(container.length - 16)
  const body = container.subarray(21, container.length - 16)

  // 密钥长度不对时 createDecipheriv 自己会抛，这里先给一句更贴切的
  const key = Buffer.from(String(keyB64 || ''), 'base64')
  if (key.length !== 32) throw new Error('密钥长度不对（不是 32 字节的 AES-256 密钥）')

  let d
  try {
    d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    d.setAAD(Buffer.from(String(aad || ''), 'utf8'))
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()])
  } catch (error) {
    // 抛出来时 d 已经建好，但绝不能拿这半截数据往下走 —— GCM 的 final() 失败就是
    // 「密文被改过 / 密钥不对 / AAD 不对」，没有「修一下还能用」的余地
    throw new Error(`解密失败（密文被改过或密钥不对）：${error?.message || error}`)
  }
}

/* ------------------------------------------------------------ 安装台账 */

/** 读原生包台账。没有 / 读坏了都返回 null（当第一次装） */
export function readNativeState (destDir) {
  try {
    const raw = fs.readFileSync(path.join(destDir, NATIVE_STATE_FILE), 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

/** 写台账。失败只记日志不抛 —— 装都装完了，台账丢了最多下次多下一遍 */
function writeNativeState (destDir, state, logger) {
  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.writeFileSync(
      path.join(destDir, NATIVE_STATE_FILE),
      JSON.stringify(state, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    )
    return true
  } catch (error) {
    logger?.warn?.(`[${PluginName}] 写安装台账失败（不影响使用）：${error?.message || error}`)
    return false
  }
}

/**
 * 台账说得对、而且磁盘上那个二进制确实还是它 —— 才敢跳过下载。
 * 只比 sha 不够：文件被截断、被杀软改过都会让「版本没变」变成一句谎话。
 */
function localBinOk (destDir, bin, state) {
  const file = path.join(destDir, bin)
  try {
    if (!fs.existsSync(file)) return false
    const buf = fs.readFileSync(file)
    if (state?.size && buf.length !== state.size) return false
    if (state?.sha256 && sha256Hex(buf) !== state.sha256) return false
    // 可执行位也要查：Windows 上 accessSync(X_OK) 恒真，无所谓
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------ 安装 */

/** 备份名字：Windows 上想覆盖正在运行的 exe，必须先把它改名（不能直接 rename 覆盖） */
const OLD_SUFFIX = '.old'

/** 把旧二进制挪开（Windows 替换路径用）。挪不动就算了，后面 rename 会给出真正的错误 */
function moveAside (file) {
  const old = file + OLD_SUFFIX
  try {
    fs.rmSync(old, { force: true })
    fs.renameSync(file, old)
    return true
  } catch {
    return false
  }
}

function cleanup (dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

/**
 * 装 / 更新一个原生包。
 *
 * 流程（契约 §2.2 的 ①②④⑤⑥⑦）：
 *   ①② **先**问版本（`/latest`），再拿远端的 sha 和本地台账比 —— 顺序反了就会把
 *       「本地文件没坏」误报成「已是最新」，于是 `#营地…部署` 永远只重启、不更新
 *   ③  远端 sha 与台账相同 + 二进制自检通过 → 不下载，直接返回 `updated:false`
 *   ④⑤ 下密文、取密钥（keyId 必须和 /latest 的 enc.keyId 一致，否则重来）
 *   ⑥  解密 + sha256 校验 → 不一致整轮重来（最多 2 轮）
 *   ⑦  在 `.staging-*` 里解包、chmod 0755、跑 `--version` 自检，最后才 rename 覆盖
 *
 * **任何一步失败都保留旧二进制**：staging 目录会被清掉，destDir 里的东西不动。
 *
 * @param {object} opts
 * @param {string} opts.name    包名（watch / im）
 * @param {string} opts.destDir 装到哪（`<插件>/server` / `<插件>/server-im`）
 * @param {string} [opts.target] 平台三元组，不传就用本机的
 * @param {boolean} [opts.force] 强制重下（`#营地…重装`）
 * @returns {Promise<{ok: boolean, updated?: boolean, sha?: string, target?: string,
 *   binary?: string, size?: number, version?: string, message?: string}>}
 */
export async function installNative ({
  name, destDir, target, url, token, force = false, logger, fetchImpl
} = {}) {
  let tgt = target
  if (!tgt) {
    try {
      tgt = detectTarget()
    } catch (error) {
      return { ok: false, message: error.message }
    }
  }
  if (!isSupportedTarget(tgt)) return { ok: false, message: `不支持的平台标识：${tgt}` }

  const bin = binaryName(name, tgt)
  const conf = { url, token }
  if (!conf.url || !conf.token) {
    return { ok: false, message: '还没接入分发服务（地址或令牌是空的）' }
  }

  fs.mkdirSync(destDir, { recursive: true })

  // ①② 先问服务端有没有新版。**这一步绝不能省**：台账只说明「本地装的是哪个版本」，
  // 拿它自己和自己比永远是「已是最新」。跳过 /latest 就等于把这个命令退化成「重启」。
  // 连不上上游时直接失败退出（旧服务一个字节不动），不猜、也不谎称最新。
  const latest = await fetchLatest(name, tgt, { ...conf, fetchImpl })
  if (!latest.ok) return { ok: false, message: latest.message }

  // ③ 远端 sha 和台账一致，而且磁盘上那个二进制确实还是它 → 不下载，只重启
  const state = readNativeState(destDir)
  if (!force && state?.sha === latest.sha && state?.target === tgt && localBinOk(destDir, bin, state)) {
    return {
      ok: true,
      updated: false,
      sha: state.sha,
      target: tgt,
      binary: bin,
      size: state.size,
      version: state.version
    }
  }

  // 走到这里有两种情况，都要完整装一遍：
  //   ① 远端 sha 和台账不一样（真·有新版本）
  //   ② sha 没变但 localBinOk 没过（二进制被改坏/截断）—— 不能因为「版本号没变」就跳过

  let lastMessage = '未知原因'
  for (let attempt = 1; attempt <= 2; attempt++) {
    const step = await fetchAndStage({ name, sha: latest.sha, target: tgt, destDir, bin, conf, logger, fetchImpl })
    if (!step.ok) {
      lastMessage = step.message
      continue
    }

    // ⑦ 最后一步：替换。（可执行位在 staging 里已经补过，见 fetchAndStage）
    const target0 = path.join(destDir, bin)
    try {
      if (process.platform === 'win32') {
        // Windows 不允许改名覆盖正在运行的 exe：先把旧的挪成 .old 再放新的
        if (fs.existsSync(target0)) moveAside(target0)
      }
      fs.renameSync(step.file, target0)
    } catch (error) {
      cleanup(step.staging)
      return {
        ok: false,
        message: `替换二进制失败（旧版没动）：${error?.message || error}`
      }
    }

    cleanup(step.staging)
    try {
      fs.rmSync(target0 + OLD_SUFFIX, { force: true })
    } catch {}

    writeNativeState(destDir, {
      name,
      kind: 'native',
      sha: latest.sha,
      target: tgt,
      binary: bin,
      asset: latest.asset,
      size: step.size,
      sha256: step.sha256,
      version: step.version,
      installedAt: new Date().toISOString()
    }, logger)

    logger?.mark?.(
      `[${PluginName}] ${name} 原生包已就位：${latest.sha}（${tgt}，${(step.size / 1024 / 1024).toFixed(1)} MB）`
    )

    return {
      ok: true,
      updated: true,
      sha: latest.sha,
      target: tgt,
      binary: bin,
      size: step.size,
      version: step.version
    }
  }

  return { ok: false, message: lastMessage }
}

/**
 * ④⑤⑥⑦ 的前半段：下载 → 取密钥 → 解密 → 校验 → 解到 staging → 自检。
 * 只往 `.staging-*` 里写东西，**不碰 destDir 里已有的文件**。
 */
async function fetchAndStage ({ name, sha, target, destDir, bin, conf, logger, fetchImpl }) {
  const down = await downloadBundle(name, sha, target, { ...conf, fetchImpl })
  if (!down.ok) return { ok: false, message: down.message }

  const key = await fetchKey(name, sha, target, { ...conf, fetchImpl })
  if (!key.ok) return { ok: false, message: key.message }

  // ⑤ 的校验：keyId 不一致说明服务端刚换了主密钥，这一轮下的密文和这把密钥对不上，重来
  if (key.keyId && down.keyId && key.keyId !== down.keyId) {
    return { ok: false, message: '服务端刚换了加密密钥（keyId 不一致），重试中' }
  }

  let plain
  try {
    plain = decryptBundle(down.buffer, key.key, key.aad)
  } catch (error) {
    return { ok: false, message: error.message }
  }

  // ⑥ 明文自检。服务端没给 sha256Plain 时用「明文长度」兜底（冷缓存时它可能是 null）
  const digest = sha256Hex(plain)
  if (key.sha256Plain && digest !== key.sha256Plain) {
    return { ok: false, message: `明文摘要对不上（期望 ${key.sha256Plain.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）` }
  }
  if (key.sizePlain && plain.length !== key.sizePlain) {
    return { ok: false, message: `明文长度对不上（期望 ${key.sizePlain}，实际 ${plain.length}）` }
  }

  // ⑦ 解包。刻意解到 staging：解一半失败也不影响正在跑的那个二进制
  // ⚠️ 从这里开始每个失败分支都必须 cleanup(staging)，否则重试两次就在 server/ 里
  //    留下两个垃圾目录（实测踩过：.staging-* 攒着不删）
  const staging = path.join(destDir, `.staging-${process.pid}-${Date.now()}`)
  try {
    fs.mkdirSync(staging, { recursive: true })
    const extracted = extractTarGz(plain, staging)

    // native 包里**就是单个二进制**，多一个少一个都说明包不对，别猜
    if (extracted.files.length !== 1 || extracted.files[0] !== bin) {
      cleanup(staging)
      return {
        ok: false,
        message: `包内容不对：期望只有 ${bin} 一个文件，实际是 ${extracted.files.join('、') || '（空包）'}`
      }
    }

    const file = path.join(staging, bin)

    // ⚠️ 必须先补上可执行位，再自检 —— `extractTarGz` 是按字节写文件的，
    //    它不会去应用 tar 头里的 mode。少了这一句，自检会以 EACCES 失败，
    //    看起来像「包里的二进制坏了」，实际只是没 chmod（实测踩过）。
    try {
      fs.chmodSync(file, 0o755)
    } catch (error) {
      cleanup(staging)
      return { ok: false, message: `新二进制设可执行位失败：${error?.message || error}` }
    }

    const check = selfCheck(file)
    if (!check.ok) {
      cleanup(staging)
      return { ok: false, message: `新二进制跑不起来（${target}）：${check.message}` }
    }
    // 自检输出里带不带自己的 target 无所谓（服务端将来可能改格式），只记下来当版本号
    logger?.debug?.(`[${PluginName}] ${bin} 自检输出：${check.out}`)

    // 台账里记的是**二进制自己**的大小/摘要（不是整个 tar 的）：下次开机只要重算一遍
    // 就能判断「磁盘上这个文件还是不是当初装的那一个」，不依赖 tar 格式细节
    const binBuf = fs.readFileSync(file)

    return {
      ok: true,
      staging,
      file,
      size: binBuf.length,
      sha256: sha256Hex(binBuf),
      version: check.out
    }
  } catch (error) {
    cleanup(staging)
    return { ok: false, message: `解包失败（包可能损坏）：${error?.message || error}` }
  }
}
