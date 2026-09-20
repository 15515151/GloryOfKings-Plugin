/**
 * 本机平台 → 服务端「目标三元组」，以及二进制/资产名的拼法。
 *
 * ## 为什么单独一个文件、且全是纯函数
 *
 * 这三样东西必须和**服务端的白名单**逐字一致（`/opt/gok-share-server/src/native.mjs`
 * 的 `SUPPORTED_TARGETS` / `assetName` / `binaryName`）。对不上的后果不是报错而是
 * 「解出来能跑但跑不起来」或者「拿 x86 的包在 arm 上执行」——所以这里刻意只放
 * 没有副作用的纯函数，好让 `test/platform.test.js` 直接逐个断言字符串。
 *
 * ⚠️ 改这里就要改服务端，反之亦然。原生产物只有三个：
 *    `x86_64-pc-windows-msvc` / `x86_64-unknown-linux-gnu` / `aarch64-unknown-linux-gnu`
 */

/** 服务端支持的全部目标三元组（顺序与服务端 native.mjs 保持一致） */
export const SUPPORTED_TARGETS = [
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu'
]

/**
 * Node 的 platform/arch 组合 → 目标三元组。
 *
 * 只列**真有产物**的三种。macOS / 32 位 / arm32 一律走下面的错误分支：
 * 契约 §7 明确要求「macOS / arm32 明确报不支持」，静默失败会让主人以为是自己配错了。
 */
const TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc'
}

/**
 * 本机的目标三元组。
 * @returns {string}
 * @throws {Error} 平台没有原生产物时抛 —— 错误信息里带清楚是哪个组合、支持哪些
 */
export function detectTarget () {
  const key = `${process.platform}-${process.arch}`
  const target = TARGETS[key]
  if (target) return target

  const readable = {
    darwin: 'macOS',
    win32: 'Windows',
    linux: 'Linux',
    freebsd: 'FreeBSD'
  }[process.platform] || process.platform

  throw new Error(
    `不支持这台机器：${readable}/${process.arch}。` +
    '观战 / 营地消息的原生版本只有 Linux(x86_64、arm64) 和 Windows(x86_64) 三种，' +
    'macOS、32 位系统和 arm32 暂时没有产物'
  )
}

/** 这个三元组在不在支持列表里（别人传进来的值不要信） */
export function isSupportedTarget (target) {
  return SUPPORTED_TARGETS.includes(String(target || ''))
}

/** 目标三元组 → 可执行文件后缀。Windows 产物才有 .exe */
export function exeSuffix (target) {
  return String(target || '').includes('windows') ? '.exe' : ''
}

/**
 * 包内二进制名 —— 也就是解出来落在 `<插件>/server(-im)/` 下的那个文件名。
 * watch → `gok-watch`，im → `gok-im` / `gok-im.exe`
 *
 * ⚠️ 服务端 `native.mjs` 的 `binaryName` 用的是**包名**（watch / im），
 *    所以传进来的 kind 就是包名，不要额外加前缀。
 */
export function binaryName (kind, target) {
  return `gok-${kind}${exeSuffix(target)}`
}

/**
 * GitHub Release 资产名，也是 `/latest` 响应里的 `asset` 字段。
 * 插件拿它和 `/latest` 回的 `asset` 比对：对不上说明服务端那个 tag 的产物不对，
 * 早点报错比下回来一个「别人的平台」的二进制强。
 */
export function assetName (kind, target) {
  return `gok-${kind}-${target}${exeSuffix(target)}`
}

/**
 * 拼 AAD。**仅供单测断言**，运行时一律用 `/key` 回的 `aad` 原样喂给 setAAD。
 *
 * 服务端 `seal.mjs` 的 `bundleAad` 是 `${AAD_CONTEXT}${name}:${sha}:${pathsKey}`，
 * 而 native 包的 `pathsKey` 就是 target（`packages.mjs` 的 `variantFor`）。
 * 这里放一份同样的算法，是为了让「服务端发过来的 aad 长得对不对」有个可断言的参照 ——
 * **不要**用它去替换响应里的值。
 */
export function bundleAad (name, sha, target) {
  return `gokenc:v1:${name}:${sha}:${target}`
}
