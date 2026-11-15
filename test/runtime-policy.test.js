import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachRuntimePolicy } from '../runtime-policy.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS || join(repo, '../test-artifacts/security-2026-11-15'))
await mkdir(artifacts, { recursive: true })

async function fixture(options = {}) {
  const root = await mkdtemp(join(artifacts, 'runtime-policy-'))
  const workspace = join(root, 'workspace'), outside = join(root, 'outside')
  const control = join(workspace, 'plugin-control')
  const resources = options.resourceInside ? join(workspace, 'audited-skill') : join(outside, 'audited-skill')
  for (const path of [workspace, outside, control, resources]) await mkdir(path, { recursive: true })
  const file = join(workspace, 'input.txt'), secret = join(workspace, '.env'), controlFile = join(control, 'runtime-policy.js')
  const skillFile = join(resources, 'SKILL.md'), asset = join(resources, 'template.txt'), unlisted = join(resources, 'unlisted.txt')
  for (const path of [file, secret, controlFile, skillFile, asset, unlisted, join(outside, 'other.txt')]) await writeFile(path, 'fixture only')
  const history = [...options.history || []]
  // Match the shipped Session public API: seq is the next event offset;
  // eventAt reads the immutable event at that offset. There is no length.
  const session = { id: 'protected', header: { cwd: workspace }, get seq() { return history.length }, eventAt: index => history[index] }
  if (options.legacyHistory) {
    delete session.seq
    Object.defineProperty(session, 'length', { get: () => history.length })
  }
  const agent = { id: 'protected', session }
  const other = { id: 'other', session: { id: 'other', header: { cwd: workspace } } }
  const policies = new Map([['protected', { enabled: true, mode: options.mode || 'read-only' }]])
  const definitions = new Map(['read', 'write', 'edit', 'read_image', 'skill'].map(name => {
    const field = name === 'skill' ? 'name' : 'file_path'
    return [name, { name, parameters: { type: 'object', required: [field], properties: { [field]: { type: 'string' } } } }]
  }))
  const shadow = new Map(), events = new Map()
  let registeredGuard, cwd = workspace, valid = true, checks = 0, authorizations = 0, bodyCalls = 0
  const ctx = {
    tools: {
      get: (name, currentAgent) => currentAgent && shadow.has(name) ? shadow.get(name) : options.agentOnly && !currentAgent ? undefined : definitions.get(name),
      modeFor: () => options.toolMode || 'native',
      guard: callback => { registeredGuard = callback; return () => { registeredGuard = undefined } },
    },
    on(name, callback) { events.set(name, callback); return () => events.delete(name) },
    get(name) {
      if (name === 'agents') return { get: id => id === agent.id ? agent : id === other.id ? other : undefined }
      if (name === 'workingDirectory') return { get: () => cwd }
    },
  }
  if (options.missingGuard) delete ctx.tools.guard
  if (options.missingPreStep) delete ctx.on
  if (options.badPreStepHandle) ctx.on = () => undefined
  const adapterOptions = {
    getPolicy: options.getPolicy || (id => policies.get(id)),
    isReady: options.isReady || (() => true),
    authorizeSkill(exec, context) {
      authorizations++
      return options.authorizeSkill ? options.authorizeSkill(exec, context) : { name: exec.arguments.name, fingerprint: 'fixture-hash', readFiles: [skillFile, asset] }
    },
    validateActiveSkills(exec, records, context) {
      checks++
      return options.validate ? options.validate(exec, records, context) : valid ? {} : { reason: 'skill contents changed' }
    },
    controlRoots: [control],
    prepareSkill: options.prepareSkill,
  }
  const adapter = attachRuntimePolicy(ctx, adapterOptions)
  const execution = (name, args = {}, current = agent) => ({ name, arguments: args, agent: current, callId: 'fixture-call', signal: new AbortController().signal })
  const check = (name, args = {}, current = agent) => registeredGuard?.(execution(name, args, current))
  async function dispatch(exec) {
    const prepare = events.get('tools/pre-execute')
    if (prepare) { const decision = await prepare(exec, async () => ({ kind: 'allow' })); if (decision.kind !== 'allow') return { executed: false, reason: decision.reason } }
    const reason = registeredGuard?.(exec)
    if (reason) return { executed: false, reason }
    bodyCalls++; return { executed: true }
  }
  return { adapter, ctx, workspace, outside, root, control, controlFile, resources, file, secret, skillFile, asset, unlisted,
    agent, other, policies, shadow, events, execution, check, dispatch, history, adapterOptions,
    get checks() { return checks }, get authorizations() { return authorizations }, get bodyCalls() { return bodyCalls },
    set cwd(path) { cwd = path }, set valid(value) { valid = value } }
}

test('protection is explicit per session and never authorizes model arguments to enable it', async () => {
  const f = await fixture()
  assert.equal(f.adapter.status('protected').protected, true)
  assert.equal(f.adapter.status('other').protected, false)
  assert.match(f.check('bash', { protection: false }), /白名单/)
  assert.equal(f.check('bash', { protection: true }, f.other), undefined)
})

test('agent-plane inherited tools work without global registrations, then pin their exact identity', async () => {
  const f = await fixture({ agentOnly: true })
  assert.equal(f.ctx.tools.get('read'), undefined)
  assert.equal(f.adapter.status('protected').protected, true)
  assert.equal(f.check('read', { file_path: f.file }), undefined)
  f.shadow.set('read', { ...f.ctx.tools.get('read', f.agent) })
  assert.match(f.check('read', { file_path: f.file }), /覆盖/)
})

test('missing enforcing APIs report unavailable and cannot enable skills', async () => {
  for (const options of [{ missingGuard: true }, { missingPreStep: true }, { badPreStepHandle: true }]) {
    const f = await fixture(options)
    assert.equal(f.adapter.status('protected').protected, false)
    assert.throws(() => f.adapter.requireProtected('protected'), /接口|句柄/)
  }
})

test('PTC code mode is explicitly unavailable instead of promising unusable protection', async () => {
  const f = await fixture({ toolMode: 'ptc' })
  assert.equal(f.adapter.status('protected').protected, false)
  assert.match(f.adapter.status('protected').reason, /PTC/)
  assert.match(f.check('run_code', { code: 'fixture only' }), /PTC/)
})

test('startup restoration blocks tools and pre-step until policy is ready', async () => {
  let ready = false
  const f = await fixture({ isReady: () => ready })
  assert.match(f.check('read', { file_path: f.file }), /恢复/)
  assert.match(f.check('read', { file_path: f.file }, f.other), /恢复/)
  assert.match(f.check('read', { file_path: f.file }, null), /恢复/)
  const rejected = await f.events.get('agent/pre-step')({ agent: f.agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(rejected.kind, 'reject')
  ready = true
  assert.equal(f.check('read', { file_path: f.file }), undefined)
  assert.equal(f.check('bash', {}, f.other), undefined)
  assert.equal(f.check('bash', {}, null), undefined)
})

test('failed policy initialization keeps every dispatch paused instead of treating sessions as unprotected', async () => {
  const f = await fixture({ isReady: () => false, getPolicy: () => null })
  for (const agent of [f.agent, f.other, null]) {
    assert.equal((await f.dispatch(f.execution('read', { file_path: f.file }, agent))).executed, false)
  }
  assert.equal(f.bodyCalls, 0)
  assert.equal(f.adapter.status('other').protected, false)
  assert.match(f.adapter.status('other').reason, /恢复/)
})

test('async or invalid policy callbacks fail closed', async () => {
  const f = await fixture({ getPolicy: async () => ({ enabled: true, mode: 'workspace-write' }) })
  assert.equal(f.adapter.status('protected').protected, false)
  assert.match(f.check('read', { file_path: f.file }), /配置/)
})

test('invalidated workspace policy cannot silently become active', async () => {
  const f = await fixture()
  f.policies.set('protected', { enabled: true, mode: 'read-only', invalid: true })
  assert.equal(f.adapter.status('protected').protected, false)
  assert.match(f.check('read', { file_path: f.file }), /不一致/)
})

test('read-only permits normal workspace reads but blocks all writes', async () => {
  const f = await fixture()
  assert.equal(f.check('read', { file_path: 'input.txt', offset: 1, limit: 20 }), undefined)
  assert.match(f.check('write', { file_path: 'created.txt', content: 'fixture' }), /只读/)
  assert.match(f.check('edit', { file_path: 'input.txt', old_string: 'a', new_string: 'b' }), /只读/)
})

test('workspace-write permits only workspace files and refuses control plane changes', async () => {
  const f = await fixture({ mode: 'workspace-write' })
  assert.equal(f.check('write', { file_path: 'created.txt', content: 'fixture' }), undefined)
  assert.equal(f.check('edit', { file_path: f.file, old_string: 'a', new_string: 'b' }), undefined)
  assert.match(f.check('write', { file_path: f.controlFile, content: 'fixture' }), /控制面/)
  assert.match(f.check('read', { file_path: f.controlFile }), /复审/)
  assert.match(f.check('write', { file_path: join(f.outside, 'created.txt'), content: 'fixture' }), /工作区外/)
})

test('outside reads and known sensitive paths are denied', async () => {
  const f = await fixture()
  assert.match(f.check('read', { file_path: join(f.outside, 'other.txt') }), /工作区/)
  assert.match(f.check('read', { file_path: f.secret }), /敏感/)
  await mkdir(join(f.workspace, '.ssh')); await writeFile(join(f.workspace, '.ssh', 'notes.txt'), 'fixture')
  assert.match(f.check('read', { file_path: join(f.workspace, '.ssh', 'notes.txt') }), /敏感/)
})

test('known credential configuration names are blocked even when copied into workspace', async () => {
  const f = await fixture({ mode: 'workspace-write' })
  for (const name of ['.git-credentials', '.gitconfig', '.curlrc', '.wgetrc', '.boto', '.s3cfg', '.pgpass', '.my.cnf', 'kubeconfig']) {
    const file_path = join(f.workspace, name)
    await writeFile(file_path, 'fixture only, no credentials')
    assert.match(f.check('read', { file_path }), /敏感/, name)
    assert.match(f.check('write', { file_path, content: 'fixture' }), /敏感/, name)
  }
})

test('shell, terminal, arbitrary code, web, subagents and unknown tools never dispatch', async () => {
  const f = await fixture({ mode: 'workspace-write' })
  for (const name of ['bash', 'pwsh', 'terminal', 'run_code', 'web_fetch', 'web_search', 'subagent', 'cordis', 'unknown_future_tool']) {
    const result = await f.dispatch(f.execution(name, { cmd: 'fixture only' }))
    assert.equal(result.executed, false, name)
  }
  assert.equal(f.bodyCalls, 0)
})

test('escalation arguments and same-name scoped shadows are denied', async () => {
  const f = await fixture()
  assert.match(f.check('read', { file_path: f.file, sandbox_permissions: 'danger-full-access', justification: 'fixture' }), /提权/)
  f.shadow.set('read', { name: 'read', execute: () => {} })
  assert.match(f.check('read', { file_path: f.file }), /覆盖/)
})

test('parent/indirect executions cannot use whitelisted tools as an escape', async () => {
  const f = await fixture()
  const exec = f.execution('read', { file_path: f.file }); exec.parent = { name: 'run_code' }
  assert.equal((await f.dispatch(exec)).executed, false)
})

test('cwd cannot redefine the fixed session workspace', async () => {
  const f = await fixture()
  f.cwd = f.outside
  assert.match(f.check('read', { file_path: 'other.txt' }), /越出/)
})

test('UNC, devices, streams, traversal and tilde expansion are refused', async () => {
  const f = await fixture({ mode: 'workspace-write' })
  for (const file_path of ['../outside/other.txt', '\\\\server\\share\\file', '\\\\?\\C:\\file', 'C:relative.txt', 'C:/file.txt:secret', '/dev/null', 'CON', '~/notes.txt', 'input.txt\0tail']) {
    assert.ok(f.check('read', { file_path }), file_path)
  }
})

test('symlink/junction ancestors are not followed', async t => {
  const f = await fixture({ mode: 'workspace-write' }), alias = join(f.workspace, 'alias')
  try { await symlink(f.outside, alias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'ENOSYS'].includes(error.code)) { t.skip('Host cannot create symlinks'); return } throw error }
  assert.match(f.check('read', { file_path: join(alias, 'other.txt') }), /链接|junction/)
  assert.match(f.check('write', { file_path: join(alias, 'new.txt'), content: 'fixture' }), /链接|junction/)
})

test('hard links cannot turn an outside file into a workspace file', async t => {
  const f = await fixture(), alias = join(f.workspace, 'hardlink.txt')
  try { await link(join(f.outside, 'other.txt'), alias) }
  catch (error) { if (['EPERM', 'ENOSYS'].includes(error.code)) { t.skip('Host cannot create hardlinks'); return } throw error }
  assert.match(f.check('read', { file_path: alias }), /硬链接/)
})

test('only audited manifest files receive readonly resource access', async () => {
  const f = await fixture({ mode: 'workspace-write' })
  assert.match(f.check('read', { file_path: f.asset }), /工作区/)
  assert.equal(f.check('skill', { name: 'fixture-skill' }), undefined)
  assert.equal(f.check('read', { file_path: f.asset }), undefined)
  assert.match(f.check('read', { file_path: f.unlisted }), /复审/)
  assert.match(f.check('write', { file_path: f.asset, content: 'fixture' }), /技能资源/)
})

test('audited resources inside workspace cannot be changed or gain unreviewed siblings', async () => {
  const f = await fixture({ mode: 'workspace-write', resourceInside: true })
  assert.equal(f.check('skill', { name: 'fixture-skill' }), undefined)
  assert.match(f.check('write', { file_path: join(f.resources, 'new.txt'), content: 'fixture' }), /技能资源/)
})

test('changed active evidence blocks every next tool and survives mode changes', async () => {
  const f = await fixture()
  assert.equal(f.check('skill', { name: 'fixture-skill' }), undefined)
  f.valid = false
  assert.match(f.check('read', { file_path: f.file }), /contents changed/)
  f.policies.set('protected', { enabled: true, mode: 'workspace-write', revision: 2 })
  assert.match(f.check('write', { file_path: 'created.txt', content: 'fixture' }), /contents changed/)
})

test('missing or asynchronous evidence never authorizes a skill', async () => {
  for (const authorizeSkill of [() => undefined, async () => ({}), () => ({ readRoots: [artifacts] })]) {
    const f = await fixture({ authorizeSkill })
    assert.ok(f.check('skill', { name: 'fixture-skill' }))
  }
})

test('an audited resource grant cannot expose Git credential-bearing metadata', async () => {
  let metadata
  const f = await fixture({ authorizeSkill: () => ({ readFiles: [metadata] }) })
  await mkdir(join(f.workspace, '.git'))
  metadata = join(f.workspace, '.git', 'config')
  await writeFile(metadata, 'fixture only, no credentials')
  assert.match(f.check('skill', { name: 'fixture-skill' }), /敏感/)
})

test('explicit slash invocation rejects before host instruction injection', async () => {
  const f = await fixture({ authorizeSkill: () => ({ reason: 'not audited' }) })
  let called = false
  const result = await f.events.get('agent/pre-step')({ agent: f.agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/fixture-skill do something' }] }] }, async () => { called = true; return { kind: 'enter', messages: [] } })
  assert.equal(result.kind, 'reject')
  assert.equal(called, false)
})

test('post-next skill instruction injection is also authorized and recorded', async () => {
  const f = await fixture()
  const result = await f.events.get('agent/pre-step')({ agent: f.agent, messages: [] }, async () => ({ kind: 'enter', messages: [{ source: { kind: 'skill-invocation', name: 'fixture-skill', form: 'instructions' }, content: [] }] }))
  assert.equal(result.kind, 'enter')
  assert.equal(f.authorizations, 1)
  assert.equal(f.check('read', { file_path: f.asset }), undefined)
})

test('optional async preparation binds host skill identity to the exact execution', async () => {
  let prepared = 0
  const f = await fixture({ prepareSkill: async () => { prepared++; return { provider: 'fixture-provider', path: 'fixture-path' } },
    authorizeSkill: (_exec, context) => context.prepared?.provider === 'fixture-provider' ? {} : { reason: 'wrong provider' } })
  assert.match(f.check('skill', { name: 'fixture-skill' }), /身份尚未/)
  const result = await f.dispatch(f.execution('skill', { name: 'fixture-skill' }))
  assert.equal(result.executed, true)
  assert.equal(prepared, 1)
})

test('async host identity mismatch refuses both tool and slash paths', async () => {
  const f = await fixture({ prepareSkill: async () => ({ reason: 'host identity differs' }) })
  assert.equal((await f.dispatch(f.execution('skill', { name: 'fixture-skill' }))).executed, false)
  const result = await f.events.get('agent/pre-step')({ agent: f.agent, messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/fixture-skill' }] }] }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(result.kind, 'reject')
})

test('user policy disable is the only opt-out and dispose reports unavailable', async () => {
  const f = await fixture()
  f.policies.set('protected', { enabled: false, mode: 'read-only' })
  assert.equal(f.check('bash', {}), undefined)
  assert.equal(f.adapter.status('protected').protected, false)
  f.policies.set('protected', { enabled: true, mode: 'read-only' })
  f.adapter.dispose()
  assert.equal(f.adapter.status('protected').protected, false)
})

test('ordinary existing messages do not prevent enabling a fresh protected session', async () => {
  const f = await fixture({ history: [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Read my note' }] } }] })
  assert.equal(f.agent.session.length, undefined)
  assert.equal(f.agent.session.seq, 1)
  assert.equal(f.adapter.status('protected').protected, true)
})

test('legacy adapter history length remains supported only when native seq is absent', async () => {
  const f = await fixture({ legacyHistory: true })
  assert.equal('seq' in f.agent.session, false)
  assert.equal(f.adapter.status('protected').protected, true)
})

test('native seq takes precedence over a misleading legacy length', async () => {
  const f = await fixture({ history: [{ type: 'tool/call', data: { name: 'skill' } }] })
  Object.defineProperty(f.agent.session, 'length', { value: 0 })
  assert.equal(f.adapter.status('protected').protected, false)
  assert.match(f.adapter.status('protected').reason, /旧指令/)
})

test('invalid native history never falls back to an apparently empty length', async () => {
  const f = await fixture()
  Object.defineProperty(f.agent.session, 'seq', { value: undefined })
  Object.defineProperty(f.agent.session, 'length', { value: 0 })
  assert.equal(f.adapter.status('protected').protected, false)
  assert.match(f.adapter.status('protected').reason, /完整核验/)
  assert.throws(() => f.adapter.requireProtected('protected'), error => {
    assert.equal(error.code, 'runtime-policy-unavailable')
    assert.equal(error.message.split('技能侦探运行保护：').length - 1, 1)
    return true
  })
})

test('previous skill/tool or direct invocation histories require a new session', async () => {
  for (const event of [
    { type: 'tool/call', data: { name: 'skill', arguments: { name: 'fixture-skill' } } },
    { type: 'tool/call', data: { name: 'run_code' } },
    { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'fixture-skill' }, content: [] } },
  ]) {
    const f = await fixture({ history: [event] })
    assert.equal(f.adapter.status('protected').protected, false)
    assert.match(f.adapter.status('protected').reason, /新会话/)
  }
})

test('host reload does not silently forget approved instructions from the prior process', async () => {
  const f = await fixture()
  assert.equal(f.check('skill', { name: 'fixture-skill' }), undefined)
  f.history.push({ type: 'tool/call', data: { name: 'skill', arguments: { name: 'fixture-skill' } } })
  assert.equal(f.check('read', { file_path: f.file }), undefined)
  f.adapter.dispose()
  const reloaded = attachRuntimePolicy(f.ctx, f.adapterOptions)
  assert.equal(reloaded.status('protected').protected, false)
  assert.match(f.check('read', { file_path: f.file }), /新会话/)
})

test('closing and reopening protection cannot discard loaded-skill history', async () => {
  const f = await fixture()
  assert.equal(f.check('skill', { name: 'fixture-skill' }), undefined)
  f.history.push({ type: 'tool/call', data: { name: 'skill' } })
  f.policies.set('protected', { enabled: false, mode: 'read-only' })
  f.adapter.clearSession('protected')
  f.policies.set('protected', { enabled: true, mode: 'read-only' })
  assert.equal(f.adapter.status('protected').protected, false)
})
