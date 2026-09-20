/**
 * 服务端分发相关的**无协议工具箱**：地址规范化、tar.gz 解包、探活。
 *
 * ## 这个文件现在是什么
 *
 * P3-B 之后，分发协议（设备号 / `/latest` / `/download` / `/key` / AES 解密 /
 * 原子落二进制）都搬到了 `utils/dist.js`；子进程生命周期在 `utils/service.js`。
 * 剩在这里的是两者都要用、而且和「下的是什么」无关的东西。
 *
 * 早先这里还负责「下明文 tar.gz → 解到 server/ → 写台账」，那条路已经删了：
 * 现在云端只发 `kind=native` 的密文包，明文包也不会再出现。
 *
 * ## 解压为什么自己写
 *
 * 插件不能随便加依赖（别人装插件时不会 `npm install`）。好在 Node 内置的 `zlib`
 * 能解 gzip，而 tar 的格式简单到能手写：每个条目一个 512 字节头 + 数据（按 512 对齐）。
 *
 * ⚠️⚠️ **服务端封装原生包用的是手写的 ustar 头**（`src/native.mjs` 的 `tarHeader`），
 * 但 `git archive` 打出来的 JS 包是 pax 格式，第一个条目是 `typeflag='g'` 的
 * `pax_global_header`。不跳过它的话，那 52 字节会被当成下一个条目的头，整个包解出来
 * 全是垃圾。`typeflag='x'`（pax 扩展头，真实路径在数据段里）和 `'L'`（GNU 长文件名）
 * 同理 —— 现在两个包都用不到，但兜底必须留着，不然将来加个深目录就静默解错。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 默认排除的路径首段：数据、凭证、依赖、旧 git 目录，一律不写 */
export const DEFAULT_EXCLUDE = ['data', '.env', 'node_modules', '.git', 'config/config']

/* ------------------------------------------------------------ 小工具 */

/** 从 512 字节头里读一段字符串，`\0` 截断。⚠️ 按 utf8 读，分支里有中文文件名 */
function readStr (buf, start, len) {
  return buf.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '')
}

/** 全是 0 的块 = tar 的结束标记 */
function isZeroBlock (block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false
  return true
}

/** 解析 pax 扩展头的数据段，抠出 `path=` 那一行（其余如 `mtime=` 不管） */
function parsePaxPath (data) {
  const text = data.toString('utf8')
  for (const line of text.split('\n')) {
    // 每行格式：`<长度> <key>=<value>`
    const m = line.match(/^\d+ path=(.*)$/)
    if (m) return m[1]
  }
  return null
}

/** 这个相对路径该不该跳过（首段命中 exclude，或含 `..` 想往上跑） */
function shouldSkip (rel, exclude) {
  if (!rel || rel === '.') return true
  const segs = rel.split('/')
  if (segs.some(s => s === '..')) return true
  return exclude.some(e => rel === e || rel.startsWith(e + '/'))
}

/* ------------------------------------------------------------ 解压 */

/**
 * 解一个 tar.gz 到 destDir。
 *
 * @param {Buffer} buffer  tar.gz 的完整字节
 * @param {string} destDir 目标目录（不存在会建）
 * @param {{exclude?: string[]}} [opts] 要跳过的路径首段，默认见 DEFAULT_EXCLUDE
 * @returns {{files: string[], bytes: number, skipped: string[]}}
 *   files   解出来的文件相对路径（目录不算）
 *   bytes   解出来的总字节
 *   skipped 被跳过的路径（排查「为什么这个文件没更新」用）
 */
export function extractTarGz (buffer, destDir, { exclude = DEFAULT_EXCLUDE } = {}) {
  const tar = zlib.gunzipSync(buffer)
  const root = path.resolve(destDir)
  const out = { files: [], bytes: 0, skipped: [] }

  let off = 0
  let pendingName = null // 来自 `x` / `L` 头的覆盖路径

  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512)
    if (isZeroBlock(header)) break

    let name = readStr(header, 0, 100)
    const size = parseInt(readStr(header, 124, 12).trim(), 8) || 0
    const typeflag = String.fromCharCode(header[156])
    const dataStart = off + 512
    const dataEnd = dataStart + size
    // 下一个头的位置：数据段按 512 对齐
    off = dataStart + Math.ceil(size / 512) * 512

    // ① pax 全局头（git archive 每条都会带）—— 直接跳过，**不能少这一条**
    if (typeflag === 'g') continue

    // ② pax 扩展头 / GNU 长文件名 —— 真实路径在数据段里，存起来给下一个条目用
    if (typeflag === 'x') {
      pendingName = parsePaxPath(tar.subarray(dataStart, dataEnd))
      continue
    }
    if (typeflag === 'L') {
      pendingName = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/, '')
      continue
    }

    if (pendingName) {
      name = pendingName
      pendingName = null
    }

    const rel = name.replace(/^\.\//, '')
    if (shouldSkip(rel, exclude)) {
      if (rel && rel !== '.') out.skipped.push(rel)
      continue
    }

    const dest = path.resolve(root, rel)
    // 双保险：解析完必须还在 destDir 里（防 `..` 和绝对路径）
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      out.skipped.push(rel)
      continue
    }

    if (typeflag === '5') {
      // 目录
      fs.mkdirSync(dest, { recursive: true })
      continue
    }

    if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      // 普通文件（`\0` 是老 tar 的写法，两个都认）
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, tar.subarray(dataStart, dataEnd))
      out.files.push(rel)
      out.bytes += size
      continue
    }

    // 符号链接（'2'）/ 硬链接（'1'）一律不解 —— 防止包被塞了指向外面的链接
    out.skipped.push(rel)
  }

  return out
}

/* ------------------------------------------------------------ 网络 */

/** 分发服务地址规范化：去尾部斜杠，没写协议就补 http:// */
export function normalizeBase (url) {
  let s = String(url || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  return s
}

/* ------------------------------------------------------------ 状态探测 */

/** 探一次服务端状态接口。连不上返回 null（不抛） */
export async function probeStatus (port, statusPath = '/api/status', timeout = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${statusPath}`, {
      signal: AbortSignal.timeout(timeout)
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** 等它起来（进程拉起后到真正监听之间有几百毫秒的空窗） */
export async function waitStatus (port, statusPath = '/api/status', timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = await probeStatus(port, statusPath)
    if (s) return s
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return null
}

/** 毫秒 → 「N 小时 M 分」 */
export function fmtUptime (ms) {
  if (!ms || ms < 0 || Number.isNaN(ms)) return '—'
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
}
