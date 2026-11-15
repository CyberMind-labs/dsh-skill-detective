import { readFileSync, realpathSync } from 'node:fs'
import { resolve, join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { readSkillSnapshotSync, assessAuditEvidence } from './audit-evidence.js'
import { attachRuntimePolicy } from './runtime-policy.js'

const MODES = new Set(['read-only', 'workspace-write'])
const identity = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const bodyOf = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
const error = (code, message) => Object.assign(new Error(message), { code, status: 409 })

/** Bind a host execution guard to explicit, durable Web-user session choices.
 * The model-facing tools expose no operation that edits this store.
 */
export function createProtectionService(service, ctx, options) {
  const { store, promptFile, policyVersion, maxAgeMs, controlRoots = [] } = options
  let controller = null, ready = false, initializationError = '', disposed = false
  const preparations = new WeakMap()

  function policyOptions() {
    const promptHash = createHash('sha256').update(readFileSync(promptFile, 'utf8')).digest('hex')
    return { policyVersion, promptHash, maxAgeMs }
  }

  function sessionRoot(sessionId) {
    const agent = service.ctx.get('agents')?.get?.(sessionId)
    const root = agent?.session?.header?.cwd
    if (typeof root !== 'string' || !isAbsolute(root)) throw error('protection-unavailable', '无法确认所选会话的固定工作区')
    const canonical = realpathSync(root)
    if (identity(root) !== identity(canonical)) throw error('protection-unavailable', '会话工作区包含链接或别名，无法开启保护')
    return root
  }

  function getPolicy(sessionId) {
    const policy = store.data?.protections?.[sessionId]
    if (!policy || policy.enabled !== true || !MODES.has(policy.mode) || typeof policy.workspace !== 'string') return null
    // A policy belongs to this exact workspace, including across host restarts.
    try { if (identity(sessionRoot(sessionId)) !== identity(policy.workspace)) return { ...policy, invalid: true } }
    catch { return { ...policy, invalid: true } }
    return policy
  }

  function inspectSkill(exec, context = {}, prepared) {
    const name = exec.arguments?.name ?? context.skillName
    const sessionId = String(exec.agent?.session?.id ?? exec.agent?.id ?? '')
    const workspace = context.cwd || exec.agent?.session?.header?.cwd
    if (typeof name !== 'string' || !workspace) return { reason: '无法确认待加载技能与会话' }
    let records = Object.values(service.index.data?.skills || {}).filter(record => record.name === name && !record.disabled
      && (record.scope !== 'workspace' || identity(record.workspace || '') === identity(workspace)
        || identity(workspace).startsWith(`${identity(record.workspace || '')}${process.platform === 'win32' ? '\\' : '/'}`))
      && (record.scope !== 'temp' || record.sessionId === sessionId))
    const actual = prepared?.skill ?? prepared
    if (actual?.path) records = records.filter(record => record.file && identity(record.file) === identity(actual.path))
    else if (context.expectedInstanceId) records = records.filter(record => record.instanceId === context.expectedInstanceId)
    if (records.length !== 1) return { reason: '技能不存在或有同名实例，无法确认实际加载内容；请先扫描并消除歧义' }
    const record = records[0]
    if (!record.path || !record.file) return { reason: '内联或无文件技能缺少完整目录审查证据' }
    const snapshot = readSkillSnapshotSync(record.path)
    let policy
    try { policy = policyOptions() } catch { return { reason: '无法读取当前审查策略' } }
    const install = service.state.data?.installs?.[record.instanceId]
    const evidence = install && Object.hasOwn(install, 'auditEvidence') ? install.auditEvidence : record.auditEvidence
    const audit = assessAuditEvidence(evidence, snapshot, policy)
    if (audit.status !== 'current') return { reason: audit.reason || '技能需要重新审查' }
    if (prepared) {
      const main = snapshot.files.find(file => file.path === 'SKILL.md')
      if (!actual.path || identity(actual.path) !== identity(record.file)
        || typeof actual.content !== 'string' || actual.content.trim() !== bodyOf(main.text)
        || actual.resourceBase?.kind === 'url'
        || (actual.resourceBase?.kind === 'directory' && identity(actual.resourceBase.path) !== identity(record.path))) {
        return { reason: '宿主实际加载的技能与审查文件不一致' }
      }
    }
    return { instanceId: record.instanceId, name, fingerprint: snapshot.contentHash,
      readFiles: snapshot.files.map(file => join(record.path, ...file.path.split('/'))),
      path: record.path, evidence }
  }

  async function prepareSkill(exec, context) {
    const name = exec.arguments?.name ?? context?.skillName
    try {
      let registry
      try { registry = exec.agent?.ctx?.get?.('skills') } catch { /* legacy host fallback below */ }
      if (!registry) { try { registry = exec.agent?.ctx?.skills } catch { /* property injections may be denied */ } }
      if (!registry) registry = ctx.get?.('skills')
      if (typeof registry?.get !== 'function') return { reason: '宿主无法提供实际技能身份，已阻止加载' }
      const lookupCwd = context?.cwd
      if (typeof lookupCwd !== 'string' || !isAbsolute(lookupCwd)) return { reason: '无法确认工具实际工作目录' }
      const skill = await registry.get(name, { cwd: lookupCwd, scope: exec.agent, signal: exec.signal })
      if (!skill) return { reason: '宿主无法找到待加载技能' }
      const result = inspectSkill(exec, context, skill)
      if (!result.reason) preparations.set(exec, { skill, ...result, lookupCwd })
      return result
    } catch (cause) { return { reason: `无法核验宿主技能：${cause.message}` } }
  }

  function authorizeSkill(exec, context) {
    const prepared = preparations.get(exec)
    if (!prepared) return { reason: '技能尚未完成宿主身份与内容核验，已阻止加载' }
    if (!context.cwd || identity(context.cwd) !== identity(prepared.lookupCwd)) return { reason: '工具工作目录在技能准备期间发生变化' }
    const current = inspectSkill(exec, context, prepared)
    if (current.fingerprint !== prepared.fingerprint) return { reason: '技能在执行准备期间发生变化' }
    return current
  }

  function validateActiveSkills(exec, records, context) {
    for (const active of records) {
      const current = inspectSkill({ ...exec, arguments: { name: active.name } }, { ...context, expectedInstanceId: active.instanceId })
      if (current.reason || current.instanceId !== active.instanceId || current.fingerprint !== active.fingerprint) {
        return { reason: current.reason || '已加载技能内容或身份已变化，请复审并使用新会话' }
      }
    }
    return {}
  }

  const initialization = Promise.all([store.load(), service.state.load(), service.index.load()]).then(([data]) => {
    if (data.protections !== undefined && (!data.protections || typeof data.protections !== 'object' || Array.isArray(data.protections))) throw new Error('会话保护状态损坏')
    if (data.protections) for (const [id, value] of Object.entries(data.protections)) {
      if (!id || ['__proto__', 'prototype', 'constructor'].includes(id) || !value || value.enabled !== true
        || !MODES.has(value.mode) || typeof value.workspace !== 'string' || !isAbsolute(value.workspace)) throw new Error('会话保护记录损坏')
    }
    ready = true
  }).catch(cause => { initializationError = `保护状态无法恢复，所有工具调用暂缓执行：${cause.message}`; service.log?.(`skill-detective: protection initialization failed: ${cause.message}`) })

  ctx.inject(['tools'], scope => {
    if (disposed) return
    controller = attachRuntimePolicy(scope, { getPolicy, isReady: () => ready && !initializationError,
      prepareSkill, authorizeSkill, validateActiveSkills, controlRoots, writeDenyRoots: controlRoots })
    scope.effect?.(() => () => { controller?.dispose(); controller = null }, 'skill-detective: tool protection')
  })

  function status(sessionId) {
    const current = controller?.status(sessionId)
    if (initializationError || !ready) return { available: false, enabled: false, mode: 'read-only', workspace: '', reason: initializationError || '正在恢复会话保护状态' }
    return current ? { ...current, workspace: current.workspaceRoot || current.workspace || '' }
      : { available: false, enabled: false, mode: 'read-only', workspace: '', reason: '宿主未提供工具执行强制拦截接口' }
  }

  function requireProtected(sessionId) {
    const current = status(sessionId)
    if (!sessionId || !current.available || !current.enabled) throw error('protection-required', current.reason || '请先为所选会话开启受限执行')
    const policy = getPolicy(sessionId)
    if (!policy || policy.invalid) throw error('protection-required', '会话工作区已变化，需要重新确认保护范围')
    try { controller.requireProtected(sessionId) }
    catch (cause) { throw error('protection-required', cause.message) }
    return current
  }

  async function set(sessionId, enabled, mode = 'read-only') {
    await initialization
    if (!service.validSessionId(sessionId)) throw error('session-unavailable', '请选择一个有效会话')
    if (initializationError) throw error('protection-unavailable', initializationError)
    if (typeof enabled !== 'boolean' || !MODES.has(mode)) throw error('invalid-protection', '保护状态或模式不合法')
    if (enabled && !status(sessionId).available) throw error('protection-unavailable', status(sessionId).reason)
    const workspace = enabled ? sessionRoot(sessionId) : ''
    await store.update(data => {
      data.protections ??= {}
      if (enabled) {
        data.protections[sessionId] = { enabled: true, mode, workspace, at: Date.now() }
        try { controller.requireProtected(sessionId) }
        catch (cause) { throw error('protection-unavailable', cause.message) }
      } else delete data.protections[sessionId]
    })
    // Keep loaded-skill evidence when tightening permissions: instructions may
    // remain in history, so their directory must still be checked on each call.
    if (!enabled) controller?.clearSession(sessionId)
    return { ok: true, protection: status(sessionId) }
  }

  return { initialization, status, requireProtected, set, dispose() { disposed = true; controller?.dispose(); controller = null } }
}
