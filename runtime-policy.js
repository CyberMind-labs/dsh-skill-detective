import { lstatSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

// Verified against the installed @deepseek-ai/dsh-tools 0.2.1-rc.5 runtime.
// These are end-capability tools, not run_code / terminal presentation wrappers.
const FILE_TOOLS = Object.freeze({
  read: { access: 'read', fields: ['file_path', 'offset', 'limit'] },
  read_image: { access: 'read', fields: ['file_path'] },
  write: { access: 'write', fields: ['file_path', 'content'] },
  edit: { access: 'write', fields: ['file_path', 'old_string', 'new_string', 'replace_all'] },
})
const MODES = new Set(['read-only', 'workspace-write'])
const GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g
const PREFIX = '技能侦探运行保护：'
const SENSITIVE_DIRECTORY = /^(?:\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.git|\.dsh|\.codex|\.agents|\.config|\.npm|\.docker|\.vscode|\.idea|credentials?|secrets?|tokens?)$/i
const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|authorized_keys|known_hosts|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?)$|\.(?:pem|key|p12|pfx|kdbx)$/i
const CREDENTIAL_CONFIGS = new Set(['.git-credentials', '.gitconfig', '.curlrc', '.wgetrc', '.boto', '.s3cfg', '.pgpass', '.my.cnf', 'kubeconfig'])
const isSensitiveFile = name => SENSITIVE_FILE.test(name) || CREDENTIAL_CONFIGS.has(name.toLowerCase())
const CREDENTIAL_DIRECTORY = /^(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.gnupg|credentials?|secrets?|tokens?)$/i

function failure(code, message) {
  const reason = String(message)
  return Object.assign(new Error(reason.startsWith(PREFIX) ? reason : `${PREFIX}${reason}`), { code })
}
function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right }
function under(root, path) {
  const remainder = relative(root, path)
  return remainder === '' || (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder))
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function synchronous(callback, ...args) {
  const result = callback(...args)
  if (!plain(result) || typeof result.then === 'function') throw failure('runtime-evidence-unavailable', '复审证据接口必须同步返回明确结果')
  if (result.reason) throw failure('runtime-evidence-invalid', String(result.reason))
  return result
}

/** Reject ambiguous/device paths before platform normalization can hide them. */
function checkedSpelling(input) {
  if (typeof input !== 'string' || input.trim() === '' || input !== input.trim()
    || /[\u0000-\u001f]/.test(input) || /^[\\/]{2}/.test(input)
    || input.startsWith('~') || /^[a-z]:[^\\/]/i.test(input)) throw failure('runtime-path-denied', '文件路径为空、含设备/UNC路径或有歧义')
  const rest = /^[a-z]:[\\/]/i.test(input) ? input.slice(2) : input
  if (rest.includes(':')) throw failure('runtime-path-denied', '拒绝 URL、设备路径和 NTFS 数据流')
  for (const part of rest.split(/[\\/]/)) {
    if (part === '..' || /[. ]$/.test(part) && part !== '.'
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw failure('runtime-path-denied', '拒绝父目录跳转或保留设备名称')
    }
  }
  return input
}

/** Canonicalize existing ancestors, refusing links/junctions and special files. */
function canonicalPath(input, { cwd, missing = false, directory = false } = {}) {
  checkedSpelling(input)
  const target = resolve(cwd || '.', input)
  const chain = []
  for (let path = target; ; path = resolve(path, '..')) {
    chain.push(path)
    if (samePath(resolve(path, '..'), path)) break
  }
  let nearest = '', suffix = []
  for (const path of chain.reverse()) {
    let info
    try { info = lstatSync(path) }
    catch (error) {
      if (error.code !== 'ENOENT') throw failure('runtime-path-denied', '无法核验文件路径')
      suffix.push(path.slice(path.lastIndexOf(sep) + 1))
      continue
    }
    if (info.isSymbolicLink()) throw failure('runtime-path-denied', '路径含符号链接或 junction')
    if (suffix.length) throw failure('runtime-path-denied', '路径在核验期间发生变化')
    if (!info.isDirectory() && path !== target) throw failure('runtime-path-denied', '父路径不是目录')
    if (path === target) {
      if (directory ? !info.isDirectory() : !info.isFile()) throw failure('runtime-path-denied', directory ? '工作区不是目录' : '目标不是普通文件')
      if (!directory && info.nlink !== 1) throw failure('runtime-path-denied', '文件有硬链接，拒绝越过文件身份边界')
    }
    nearest = realpathSync.native(path)
  }
  if (suffix.length && !missing) throw failure('runtime-path-denied', '目标文件不存在')
  if (!nearest) throw failure('runtime-path-denied', '无法解析文件身份')
  return suffix.length ? resolve(nearest, ...suffix) : nearest
}

function sensitive(root, target) {
  const parts = relative(root, target).split(/[\\/]/).filter(Boolean)
  return parts.some((part, index) => SENSITIVE_DIRECTORY.test(part)
    || index === parts.length - 1 && isSensitiveFile(part))
}

function invokedNames(messages) {
  const names = new Set()
  for (const message of messages || []) {
    if (message?.source?.kind === 'skill-invocation' && typeof message.source.name === 'string') names.add(message.source.name)
    if (message?.source?.kind !== 'user') continue
    for (const block of message.content || []) if (block.type === 'text' && typeof block.text === 'string') {
      for (const match of block.text.matchAll(GESTURE)) names.add(match[2])
    }
  }
  return [...names]
}

/** Old instructions cannot be reconstructed from current disk approval alone. */
function assertFreshSkillHistory(session) {
  // DSH Session.seq is the next contiguous event offset (= private log.length),
  // and eventAt(seq) is its public history reader. Older adapter mocks expose
  // length instead; never fall back from a present but invalid native seq.
  const count = session && 'seq' in session ? session.seq : session?.length
  if (typeof session?.eventAt !== 'function' || !Number.isSafeInteger(count)
    || count < 0 || count > 100_000) throw failure('runtime-history-unavailable', '无法完整核验会话历史，请使用新会话开启保护')
  for (let index = 0; index < count; index++) {
    const event = session.eventAt(index)
    if (!event || typeof event.type !== 'string') throw failure('runtime-history-unavailable', '会话历史不完整，请使用新会话开启保护')
    const data = event.data
    const source = data?.source ?? data?.message?.source
    if (source?.kind === 'skill-invocation'
      || event.type === 'tool/call' && ['skill', 'run_code'].includes(data?.name)
      || ['tool/ptc-dispatch', 'tool/ptc-dispatch-start'].includes(event.type) && data?.name === 'skill') {
      throw failure('runtime-history-unverified', '会话历史已有技能或任意代码调用，无法证明旧指令仍对应当前复审内容；请使用新会话')
    }
  }
}

/**
 * Explicit, per-session execution protection. Does not change host sandbox or
 * approval settings. getPolicy returns null/undefined for unprotected sessions,
 * otherwise {enabled:true, mode:'read-only'|'workspace-write', revision?}.
 * Workspace identity always comes from the live session header, never tool args.
 * Until isReady() is exactly true, ALL tool dispatch (including unprotected and
 * agent-less calls) and agent steps are paused: persisted opt-ins are unknown.
 * A failed initialization intentionally keeps that temporary global stop until
 * the user repairs the state; after readiness, only explicit opt-ins are gated.
 * All authorization callbacks are synchronous and must return an object. A
 * reason denies; readFiles grants exact audited manifest files, never a root.
 * validateActiveSkills(exec, records, context) rechecks every recorded grant.
 * The host registry and already-installed plugin code are trusted: its public
 * API has no package-owner attestation. Current agent-visible definitions are
 * pinned by identity and schema; later shadow/reload changes fail closed.
 * This guards DSH tool dispatch, not arbitrary trusted plugin Node.js code, and
 * is not kernel isolation against a concurrent external filesystem attacker.
 */
export function attachRuntimePolicy(ctx, options = {}) {
  const { getPolicy, authorizeSkill, validateActiveSkills, prepareSkill, isReady = () => true } = options
  const sessions = new Map(), lastDenied = new Map(), disposers = []
  const preparedSkills = new WeakMap()
  let disposed = false, available = false, unavailableReason = ''
  const toolService = ctx.tools || ctx.get?.('tools')
  const service = name => ctx.get?.(name) || ctx[name]
  const controlRoots = [], writeDenyRoots = []
  const ready = () => isReady() === true
  const policyFor = id => {
    const policy = getPolicy(id)
    if (policy == null) return null
    if (!plain(policy) || typeof policy.then === 'function' || typeof policy.enabled !== 'boolean') throw failure('runtime-policy-invalid', '会话保护配置尚未同步或格式不合法')
    return policy
  }
  const deny = (id, message) => {
    const reason = message.startsWith(PREFIX) ? message : `${PREFIX}${message}`
    if (id) lastDenied.set(id, reason)
    return reason
  }
  const contextFor = (id, suppliedAgent) => {
    const agent = service('agents')?.get?.(id)
    if (!agent?.session || agent.session.id !== id || suppliedAgent && suppliedAgent !== agent) throw failure('runtime-session-unavailable', '当前会话或工具路由已失效')
    const rawRoot = agent.session.header?.cwd
    if (typeof rawRoot !== 'string' || !isAbsolute(rawRoot)) throw failure('runtime-workspace-unavailable', '会话没有固定的绝对工作区')
    const workspaceRoot = canonicalPath(rawRoot, { directory: true })
    if (samePath(workspaceRoot, parse(workspaceRoot).root) || samePath(workspaceRoot, realpathSync.native(homedir()))) throw failure('runtime-workspace-unavailable', '不能把整个磁盘或用户主目录作为保护范围')
    const workingDirectory = service('workingDirectory')
    if (typeof workingDirectory?.get !== 'function') throw failure('runtime-policy-unavailable', '宿主缺少可核验的当前工作目录接口')
    const cwd = canonicalPath(workingDirectory.get(agent.session), { directory: true })
    if (!under(workspaceRoot, cwd)) throw failure('runtime-workspace-changed', '当前目录已越出固定工作区，请重新选择会话')
    const stat = statSync(workspaceRoot)
    return { sessionId: id, agent, workspaceRoot, cwd, identity: `${stat.dev}:${stat.ino}` }
  }
  function stateFor(id, agent) {
    if (disposed || !available) throw failure('runtime-policy-unavailable', unavailableReason || '执行拦截接口不可用')
    const policy = policyFor(id)
    if (!policy?.enabled) { sessions.delete(id); return null }
    if (policy.invalid === true) throw failure('runtime-policy-invalid', '保护策略与当前会话工作区不一致，请重新确认')
    if (!MODES.has(policy.mode)) throw failure('runtime-policy-invalid', '保护模式配置不合法')
    const context = contextFor(id, agent)
    if (toolService.modeFor(context.agent) !== 'native') throw failure('runtime-policy-unavailable', '当前工具采用 PTC 任意代码通道，严格保护暂不支持；请由用户切换原生工具模式')
    let state = sessions.get(id)
    if (state && (!samePath(state.context.workspaceRoot, context.workspaceRoot) || state.context.identity !== context.identity)) throw failure('runtime-workspace-changed', '保护工作区身份已变化，请关闭后重新确认')
    const generation = `${policy.mode}:${String(policy.revision ?? policy.updatedAt ?? '')}`
    if (!state || state.generation !== generation) {
      if (!state) assertFreshSkillHistory(context.agent.session)
      const definitions = new Map()
      for (const name of [...Object.keys(FILE_TOOLS), 'skill']) {
        const definition = toolService.get(name, context.agent)
        const field = name === 'skill' ? 'name' : 'file_path'
        if (definition?.name === name && definition.parameters?.type === 'object'
          && definition.parameters.properties?.[field]?.type === 'string'
          && definition.parameters.required?.includes(field)) definitions.set(name, definition)
      }
      if (!definitions.has('read') || !definitions.has('skill')) throw failure('runtime-policy-unavailable', '宿主缺少已核实的 read/skill 工具接口')
      state = { generation, context, mode: policy.mode, definitions, active: state?.active || new Map() }
      sessions.set(id, state)
    }
    if (!samePath(state.context.workspaceRoot, context.workspaceRoot) || state.context.identity !== context.identity) throw failure('runtime-workspace-changed', '保护工作区身份已变化，请关闭后重新确认')
    state.context = context
    return state
  }
  function validate(exec, state) {
    const result = synchronous(validateActiveSkills, exec, [...state.active.values()], state.context)
    return result
  }
  function authorize(exec, state, source, prepared) {
    if (typeof exec.arguments?.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(exec.arguments.name)) throw failure('runtime-skill-denied', '技能名不合法')
    if (prepareSkill && !plain(prepared)) throw failure('runtime-skill-denied', '宿主实际技能身份尚未核验')
    const result = synchronous(authorizeSkill, exec, { ...state.context, source, prepared })
    if (result.readRoots && !result.readFiles) throw failure('runtime-skill-denied', '技能资源必须按复审文件清单授权，不能授权整个目录')
    const readFiles = []
    if (result.readFiles !== undefined && !Array.isArray(result.readFiles)) throw failure('runtime-skill-denied', '资源清单不是文件数组')
    for (const path of result.readFiles || []) {
      if (typeof path !== 'string' || !isAbsolute(path)) throw failure('runtime-skill-denied', '技能清单路径必须为绝对路径')
      const file = canonicalPath(path)
      const components = file.split(/[\\/]/)
      if (isSensitiveFile(components.at(-1)) || components.some(part => CREDENTIAL_DIRECTORY.test(part))) throw failure('runtime-skill-denied', '技能资源不能授权敏感文件')
      readFiles.push(file)
    }
    const readonlyRoots = [...new Set(readFiles.map(file => dirname(file)))]
    const record = Object.freeze({ ...result, name: exec.arguments.name, readFiles: Object.freeze(readFiles), readonlyRoots: Object.freeze(readonlyRoots) })
    state.active.set(exec.arguments.name, record)
  }
  function guard(exec) {
    const id = exec.agent?.session?.id
    try {
      // This must precede session lookup: a pending/corrupt store cannot safely
      // distinguish protected, unprotected or agent-less callers yet.
      if (!ready()) throw failure('runtime-policy-initializing', '正在恢复会话保护状态，暂不执行工具')
      if (!id) return undefined // Agent-less host operations are outside this session policy.
      const policy = policyFor(id)
      if (!policy?.enabled) { sessions.delete(id); return undefined }
      const state = stateFor(id, exec.agent)
      validate(exec, state)
      if (exec.parent) throw failure('runtime-tool-denied', '保护会话拒绝任意代码或间接工具通道')
      const args = exec.arguments
      if (!plain(args)) throw failure('runtime-tool-denied', '工具参数不是可核验对象')
      if (Object.hasOwn(args, 'sandbox_permissions') || Object.hasOwn(args, 'justification')) throw failure('runtime-escalation-denied', '保护会话禁止沙箱提权')
      const definition = state.definitions.get(exec.name)
      if (!definition || toolService.get(exec.name, exec.agent) !== definition) throw failure('runtime-tool-denied', '工具未列入白名单或被作用域覆盖')
      if (exec.name === 'skill') {
        if (Object.keys(args).some(key => key !== 'name')) throw failure('runtime-skill-denied', '技能加载参数无法核验')
        authorize(exec, state, 'tool', preparedSkills.get(exec))
        return undefined
      }
      const spec = FILE_TOOLS[exec.name]
      if (!spec || Object.keys(args).some(key => !spec.fields.includes(key))) throw failure('runtime-tool-denied', '保护会话只允许已核实的文件工具')
      const target = canonicalPath(args.file_path, { cwd: state.context.cwd, missing: exec.name === 'write' })
      const resources = [...state.active.values()].flatMap(record => record.readFiles)
      const resourceRoots = [...state.active.values()].flatMap(record => record.readonlyRoots)
      const resource = resources.some(file => samePath(file, target))
      const inside = under(state.context.workspaceRoot, target)
      if (spec.access === 'write') {
        if (state.mode !== 'workspace-write') throw failure('runtime-write-denied', '当前会话只读')
        if (!inside || resource || [...controlRoots, ...writeDenyRoots, ...resourceRoots].some(root => under(root, target))) throw failure('runtime-write-denied', '拒绝写入工作区外、技能资源或控制面文件')
      } else if (!inside && !resource || controlRoots.some(root => under(root, target)) && !resource) throw failure('runtime-read-denied', '读取目标不在工作区或已复审技能文件清单中')
      if (inside && sensitive(state.context.workspaceRoot, target) && !resource || isSensitiveFile(target.split(/[\\/]/).at(-1))) throw failure('runtime-sensitive-path', '拒绝访问敏感目录或凭据文件')
      return undefined
    } catch (error) { return deny(id, error.message || String(error)) }
  }
  async function prepare(exec, next) {
    const id = exec.agent?.session?.id
    try {
      if (!ready()) throw failure('runtime-policy-initializing', '正在恢复会话保护状态')
      if (!id || !policyFor(id)?.enabled || exec.name !== 'skill') return next()
      const state = stateFor(id, exec.agent)
      validate(exec, state)
      const result = await prepareSkill(exec, state.context)
      if (!plain(result) || result.reason) throw failure('runtime-skill-denied', result?.reason || '无法确认宿主实际技能身份')
      preparedSkills.set(exec, result)
      return next()
    } catch (error) { return { kind: 'deny', reason: deny(id, error.message || String(error)) } }
  }
  async function authorizeInvocation(exec, state, source) {
    let prepared
    if (prepareSkill) {
      prepared = await prepareSkill(exec, { ...state.context, source })
      if (!plain(prepared) || prepared.reason) throw failure('runtime-skill-denied', prepared?.reason || '无法确认直接调用的技能身份')
    }
    authorize(exec, state, source, prepared)
  }
  async function preStep(payload, next) {
    const id = payload.agent?.session?.id
    try {
      if (!ready()) throw failure('runtime-policy-initializing', '正在恢复会话保护状态')
      if (!id || !policyFor(id)?.enabled) { if (id) sessions.delete(id); return next() }
      const state = stateFor(id, payload.agent)
      const exec = { agent: payload.agent, name: 'skill', arguments: {}, signal: payload.signal }
      validate(exec, state)
      for (const name of invokedNames(payload.messages)) await authorizeInvocation({ ...exec, arguments: { name } }, state, 'user-invocation')
      const decision = await next()
      if (decision.kind === 'reject') return decision
      for (const name of invokedNames(decision.messages)) await authorizeInvocation({ ...exec, arguments: { name } }, state, 'injected-invocation')
      validate(exec, state)
      return decision
    } catch (error) { return { kind: 'reject', reason: deny(id, error.message || String(error)) } }
  }
  try {
    if (typeof getPolicy !== 'function' || typeof authorizeSkill !== 'function' || typeof validateActiveSkills !== 'function'
      || typeof toolService?.guard !== 'function' || typeof toolService?.get !== 'function' || typeof toolService?.modeFor !== 'function' || typeof ctx.on !== 'function') throw new Error('宿主缺少执行 guard、工具身份/模式查询、pre-step 或复审证据接口')
    for (const path of options.controlRoots || []) controlRoots.push(canonicalPath(path, { directory: true, missing: true }))
    for (const path of options.writeDenyRoots || []) writeDenyRoots.push(canonicalPath(path, { directory: true, missing: true }))
    const guardDispose = toolService.guard(guard)
    if (typeof guardDispose !== 'function') throw new Error('执行 guard 没有返回可管理的注册句柄')
    disposers.push(guardDispose)
    if (prepareSkill !== undefined) {
      if (typeof prepareSkill !== 'function') throw new Error('prepareSkill 必须是函数')
      const prepareDispose = ctx.on('tools/pre-execute', prepare, { prepend: true })
      if (typeof prepareDispose !== 'function') throw new Error('技能准备接口没有返回可管理句柄')
      disposers.push(prepareDispose)
    }
    const stepDispose = ctx.on('agent/pre-step', preStep, { prepend: true })
    if (typeof stepDispose !== 'function') throw new Error('pre-step 没有返回可管理的注册句柄')
    disposers.push(stepDispose)
    available = true
  } catch (error) {
    // Keep a successfully installed guard fail-closed for enabled sessions even
    // when a later hook registration fails. Unprotected sessions stay unchanged.
    unavailableReason = error.message
  }

  function status(sessionId) {
    try {
      if (!ready()) throw failure('runtime-policy-initializing', '正在恢复会话保护状态')
      const enabled = Boolean(policyFor(sessionId)?.enabled)
      if (!enabled) return { available, enabled: false, protected: false, reason: '当前会话未开启运行保护', lastDenied: lastDenied.get(sessionId) }
      const state = stateFor(sessionId)
      return { available, enabled: true, protected: true, mode: state.mode, workspaceRoot: state.context.workspaceRoot, lastDenied: lastDenied.get(sessionId), allowedTools: [...state.definitions.keys()] }
    } catch (error) { return { available: false, enabled: true, protected: false, reason: error.message, lastDenied: lastDenied.get(sessionId) } }
  }
  return {
    status,
    requireProtected(sessionId) {
      const current = status(sessionId)
      if (!current.protected) throw failure(current.available ? 'runtime-protection-required' : 'runtime-policy-unavailable', current.reason)
      return current
    },
    clearSession(sessionId) { sessions.delete(sessionId); lastDenied.delete(sessionId) },
    dispose() {
      if (disposed) return
      disposed = true; available = false
      for (const dispose of disposers.reverse()) dispose()
      sessions.clear()
    },
  }
}

export const __test = { canonicalPath, checkedSpelling, invokedNames, assertFreshSkillHistory }
