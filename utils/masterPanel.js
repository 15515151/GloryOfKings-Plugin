import puppeteer from '../../../lib/puppeteer/puppeteer.js'
import { Config } from '#components'
import authStore from './authStore.js'

function maskId(value, keepStart = 3, keepEnd = 3) {
  const text = String(value || '')
  if (!text) {
    return '未配置'
  }
  if (text.length <= keepStart + keepEnd) {
    return text
  }
  return `${text.slice(0, keepStart)}***${text.slice(-keepEnd)}`
}

export function buildMasterPanelData() {
  const authConfig = Config.getDefOrConfig('auth') || {}
  const accounts = authStore.listAccounts()
  const globalAccounts = accounts.filter(account => account.isGlobalDefault)
  const sharedAccounts = accounts.filter(account => account.shared && !account.isGlobalDefault)
  const invalidAccounts = accounts.filter(account => account.authInvalid)
  const usableAccounts = accounts.filter(account => !account.authInvalid)
  const usableGlobals = globalAccounts.filter(account => !account.authInvalid)
  // 多个全局账号 = 轮询池，请求在它们之间轮换（见 authStore.getAuthCandidates）
  const globalRotating = usableGlobals.length > 1
  const enableAccountPool = authConfig.enableAccountPool !== false
  const allowPersonalAuthFallback = authConfig.allowPersonalAuthFallback === true

  const candidateOrder = [globalRotating ? `全局账号（${usableGlobals.length} 个轮询）` : '默认全局账号']
  if (enableAccountPool) {
    candidateOrder.push('共享账号')
  }
  if (enableAccountPool && allowPersonalAuthFallback) {
    candidateOrder.push('个人登录态兜底')
  }

  return {
    generatedAt: new Date().toLocaleString(),
    strategyRows: [
      {
        label: '共享账号候选',
        value: enableAccountPool ? '已开启' : '已关闭',
        desc: enableAccountPool ? '开关指令：#王者设置共享账号候选关闭' : '开关指令：#王者设置共享账号候选启用',
        tone: enableAccountPool ? 'on' : 'off'
      },
      {
        label: '个人登录态兜底',
        value: allowPersonalAuthFallback ? '已开启' : '已关闭',
        desc: allowPersonalAuthFallback ? '开关指令：#王者设置个人登录态兜底关闭' : '开关指令：#王者设置个人登录态兜底启用',
        tone: allowPersonalAuthFallback && enableAccountPool ? 'on' : 'off'
      },
      {
        label: '候选及鉴权顺序',
        value: candidateOrder.join(' -> '),
        desc: '实际请求会按此顺序选择鉴权账号',
        tone: 'neutral'
      },
      {
        label: globalRotating ? '全局账号池' : '默认全局账号',
        value: globalAccounts.length
          ? globalAccounts.map(account => `${maskId(account.userId)} / ${account.authInvalid ? '失效' : '正常'}`).join('、')
          : '未配置',
        desc: globalRotating
          ? `共 ${usableGlobals.length} 个可用，请求在其间轮换`
          : '配置指令：#营地wx全局登录 / #营地QQ全局登录 (刷新全局鉴权)',
        tone: usableGlobals.length ? 'on' : (globalAccounts.length ? 'off' : 'warn')
      }
    ],
    summaryRows: [
      { label: '账号总数', value: String(accounts.length), tone: 'neutral' },
      { label: '可用账号', value: String(usableAccounts.length), tone: 'on' },
      { label: '失效账号', value: String(invalidAccounts.length), tone: invalidAccounts.length ? 'off' : 'neutral' },
      { label: '共享账号', value: String(sharedAccounts.length), tone: enableAccountPool ? 'on' : 'neutral' }
    ],
    commandGroups: [
      {
        title: '排查与维护',
        items: [
          { command: '#王者设置', desc: '查看本面板与链路状态' },
          { command: '#王者用户统计', desc: '精简版绑定情况统计' },
          { command: '#清理失效营地账号', desc: '移除无法使用的登录态' }
        ]
      },
      {
        title: '账号与更新',
        items: [
          { command: '#营地wx全局登录', desc: '扫码写入/更新全局账号（可多个，自动轮询）' },
          { command: '#营地QQ全局登录', desc: 'QQ 扫码写入/更新全局账号（可多个，自动轮询）' },
          { command: '#王者设置共享账号候选启用|关闭', desc: '切换共享账号候选' },
          { command: '#王者设置个人登录态兜底启用|关闭', desc: '切换个人登录态兜底' },
          { command: '#共享营地账号 [ID]', desc: '将账号放入共享池' },
          { command: '#取消共享营地账号 [ID]', desc: '从共享池中移除' },
          { command: '#王者更新 / #农药更新', desc: '拉取最新插件代码' },
          { command: '#王者更新记录', desc: '查看近期更新功能' }
        ]
      }
    ]
  }
}

export async function renderMasterPanel(e) {
  const panelImage = await puppeteer.screenshot('helpConfig', {
    imgType: 'webp',
    tplFile: 'plugins/GloryOfKings-Plugin/resources/html/helpConfig.html',
    _res_path: '../../../plugins/GloryOfKings-Plugin/resources/',
    ...buildMasterPanelData()
  })

  await e.reply(panelImage)
}
