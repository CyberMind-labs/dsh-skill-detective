import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const identity = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const action = (type, label, extra = {}) => ({ type, label, ...extra })

/** Read-only prerequisites. A configured model is never described as tested. */
export function createOnboardingService(service, { sessionChoices }) {
  return {
    async preflight(input = {}) {
      const checks = [], add = (id, status, message, next, required = true) => checks.push({ id, status, message, ...(next ? { action: next } : {}), required })
      let workspace = '', state = {}, sessionId = '', agent = null
      try {
        workspace = service.normalizeWorkspace(input.workspace || '')
        const info = await stat(workspace)
        if (!info.isDirectory()) throw new Error('目录不可用')
        add('workspace', 'pass', `工作区：${workspace}`)
      } catch (cause) { add('workspace', 'action', `请选择可用的工作区：${cause.message}`, action('select-workspace', '选择工作区')) }
      try { state = await service.state.load() } catch { /* recovery diagnostics below remain available */ }
      const sessions = sessionChoices(service, state, input.sessionId || '')
      sessionId = service.validSessionId(input.sessionId || '')
      if (sessionId) {
        try { agent = service.ctx.get('agents')?.get?.(sessionId) } catch { /* handled below */ }
      }
      if (!sessionId || !agent) add('session', 'action', '先在 dsh 中打开一个会话，再在此选择；无需开启自动推荐。', action('choose-session', '选择会话'))
      else {
        add('session', 'pass', '已找到可用会话')
        try {
          if (identity(await realpath(agent.session.header.cwd)) !== identity(await realpath(workspace))) {
            add('session-workspace', 'action', '所选会话与面板工作区不同；请选择该会话的固定工作区。', action('select-workspace', '选择会话工作区'))
          } else add('session-workspace', 'pass', '会话与工作区一致')
        } catch { add('session-workspace', 'blocked', '无法核实会话的固定工作区', action('choose-session', '重新选择会话')) }
      }
      let route = null, timer
      try {
        route = await Promise.race([service.judge.route(), new Promise(fulfill => { timer = setTimeout(() => fulfill(null), 2500) })])
      } catch { /* this is configuration discovery only */ }
      finally { clearTimeout(timer) }
      const model = { configured: Boolean(route?.provider && route?.model), provider: route?.provider || '', model: route?.model || '', tested: false }
      if (model.configured) add('model', 'pass', `已配置 ${model.provider} / ${model.model}；尚未验证连通性或任务效果。`)
      else add('model', 'action', '未找到可用的默认模型配置，请在 dsh 设置中选择提供商和模型后重试。', action('configure-model', '配置模型'))
      let mode = ''
      if (agent) {
        try { mode = (agent.ctx?.get?.('tools') || service.ctx.get('tools'))?.modeFor?.(agent) || '' } catch { /* unknown */ }
        if (mode === 'native') add('tool-mode', 'pass', '当前会话使用原生工具模式')
        else add('tool-mode', mode === 'ptc' ? 'action' : 'blocked', mode === 'ptc' ? '严格保护需要原生工具模式，请在会话工具设置中切换后重试。' : '宿主未提供可核验的工具模式。', action('choose-native-mode', '切换原生工具模式'))
      }
      const protection = service.protection.status(sessionId)
      if (sessionId) {
        if (protection.available && protection.enabled && protection.protected !== false) add('protection', 'pass', `运行保护已开启：${protection.mode === 'workspace-write' ? '工作区写入' : '只读'}`)
        else if (protection.available && !protection.enabled) add('protection', 'action', '为此会话开启只读保护后，可以审查和安装技能；保存报告或修改代码时再切换工作区写入。', action('enable-read-only-protection', '开启只读保护'))
        else add('protection', 'blocked', protection.reason || '运行保护不可用', action('open-protection', '查看运行保护'))
      }
      const capabilities = service.repoTasks?.capabilities(sessionId) || { operations: [], toolAvailable: false }
      if (sessionId) add('repo-tools', capabilities.toolAvailable && capabilities.operations.length === 3 ? 'pass' : 'blocked', capabilities.reason || (capabilities.operations.length === 3 ? '三个受控仓库操作均可用' : '受控仓库操作尚未全部就绪'), action('retry-check', '重新检查'))
      let recovery = { files: [] }
      try { recovery = await service.recovery.describe() }
      catch (cause) { add('storage', 'blocked', `状态文件无法核验：${cause.message}`, action('retry-check', '重新检查')) }
      for (const file of recovery.files) {
        if (file.state === 'corrupt') add(`storage-${file.id}`, 'blocked', `${file.label}需要恢复：${file.reason || '文件损坏'}`, file.backupAvailable ? action('preview-recovery', '预览备份恢复', { target: file.id }) : action('retry-check', '重新检查'))
        else if (file.state === 'busy') add(`storage-${file.id}`, 'unknown', `${file.label}正在更新，请重新检查；无需恢复备份。`, action('retry-check', '重新检查'))
      }
      const selector = input.instanceId || input.path
      if (selector && workspace && sessionId) {
        try {
          const target = await service.selectInstalled(input, workspace, { sessionId, freshAudit: true })
          if (target.audit?.status !== 'current') add('skill-review', 'action', target.audit?.reason || '所选技能需要完整目录复审', action('review-skill', '打开技能复审'))
          else add('skill-review', 'pass', '所选技能审查证据当前有效')
          if (target.compatibility?.status === 'supported') add('skill-compatibility', 'pass', target.compatibility.summary)
          else add('skill-compatibility', target.compatibility?.status === 'blocked' ? 'blocked' : 'unknown', target.compatibility?.summary || '需要检查所选技能的执行兼容性', action('check-compatibility', '检查执行兼容性'))
        } catch (cause) { add('skill', 'action', `所选技能暂不可用：${cause.message}`, action('review-skill', '查看技能详情')) }
      } else if ((input.name || input.id || input.remoteId) && workspace && sessionId) {
        // A marketplace candidate is not an installed instance. Keep its
        // next step at compatibility inspection rather than a phantom detail.
        try {
          const result = await service.inspectCompatibility(input, workspace, { sessionId })
          const compatibility = result.compatibility
          add('skill-compatibility', compatibility?.status === 'supported' ? 'pass' : compatibility?.status === 'blocked' ? 'blocked' : 'unknown',
            compatibility?.summary || result.message || '请检查候选完整目录', action('check-compatibility', '检查执行兼容性'))
        } catch (cause) { add('skill-compatibility', 'unknown', `候选兼容性尚未确认：${cause.message}`, action('check-compatibility', '检查执行兼容性')) }
      }
      return { ok: true, ready: checks.filter(check => check.required).every(check => check.status === 'pass'), workspace, sessions,
        workspaces: service.workspaceList(), session: { id: sessionId, title: sessions.find(item => item.id === sessionId)?.title || '', available: Boolean(agent) },
        checks, model, protection, capabilities, recovery }
    },
  }
}
