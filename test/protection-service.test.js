import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createProtectionService } from '../protection-service.js'
import { readSkillSnapshot, createAuditEvidence } from '../audit-evidence.js'
import { __test } from '../index.js'

const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS || '../test-artifacts/security-2026-11-15')
await mkdir(artifacts, { recursive: true })

async function fixture(t) {
  const root = await mkdtemp(join(artifacts, 'protection-service-'))
  const workspace = join(root, 'workspace'), home = join(root, 'home'), skillRoot = join(home, 'skills', 'fixture')
  await Promise.all([workspace, skillRoot].map(path => mkdir(path, { recursive: true })))
  const promptFile = join(root, 'audit-policy.md'), prompt = 'Fixture review policy'
  await writeFile(promptFile, prompt)
  const markdown = '---\nname: fixture\ndescription: Read local text\n---\n# Fixture\nRead text only.\n'
  const file = join(skillRoot, 'SKILL.md')
  await writeFile(file, markdown)
  await writeFile(join(workspace, 'input.txt'), 'input')
  const snapshot = await readSkillSnapshot(skillRoot)
  const now = Date.now(), policyVersion = 'fixture-v1', maxAgeMs = 60_000
  const policy = { policyVersion, maxAgeMs, promptHash: createHash('sha256').update(prompt).digest('hex') }
  const evidence = createAuditEvidence(snapshot, { ...policy, ok: true, contentHash: snapshot.contentHash, hash: 'a'.repeat(64),
    verdict: 'safe', severity: 'low', poison: false, model: 'test-stub', coverage: { ...snapshot.coverage, chunks: 1 } },
  { ...policy, reviewedAt: now, expiresAt: now + maxAgeMs })
  assert.equal(evidence.status, 'current')
  const record = { name: 'fixture', instanceId: 'fixture-id', path: skillRoot, file, scope: 'global', disabled: false, auditEvidence: evidence }
  let hostContent = '# Fixture\nRead text only.', cwd = workspace
  const lookups = []
  const agent = { id: 'live', session: { id: 'live', header: { cwd: workspace }, seq: 0, eventAt: () => undefined }, ctx: {
    skills: { register() {}, get: async (_name, lookup) => { lookups.push(lookup.cwd); return { name: 'fixture', path: file, content: hostContent, resourceBase: { kind: 'directory', path: skillRoot } } } },
  } }
  const guards = [], hooks = new Map(), definitions = new Map(['read', 'read_image', 'write', 'edit', 'skill'].map(name => {
    const field = name === 'skill' ? 'name' : 'file_path'
    return [name, { name, parameters: { type: 'object', required: [field], properties: { [field]: { type: 'string' } } } }]
  }))
  const tools = { get: name => definitions.get(name), modeFor: () => 'native', guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) } }
  const services = { tools, agents: { get: id => id === 'live' ? agent : undefined }, workingDirectory: { get: () => cwd } }
  const ctx = { tools, get: name => services[name], inject(names, callback) { if (names.includes('tools')) callback(ctx) },
    effect() {}, on(name, fn) { const list = hooks.get(name) || []; hooks.set(name, [...list, fn]); return () => hooks.set(name, (hooks.get(name) || []).filter(item => item !== fn)) } }
  const state = { installs: { [record.instanceId]: { auditEvidence: evidence } } }, index = { skills: { [record.instanceId]: record } }
  const service = { ctx, state: { data: state, load: async () => state }, index: { data: index, load: async () => index },
    validSessionId: id => id === 'live' ? id : '', log() {} }
  const storeFile = join(home, 'runtime-protection.json')
  let protection
  function attach() {
    protection = createProtectionService(service, ctx, { store: new __test.JsonStore(storeFile), promptFile, policyVersion, maxAgeMs, controlRoots: [home] })
    return protection
  }
  attach(); await protection.initialization
  t.after(() => protection.dispose())
  async function call(name, args) {
    const exec = { agent, name, arguments: args, signal: new AbortController().signal }
    for (const hook of hooks.get('tools/pre-execute') || []) {
      const decision = await hook(exec, async () => ({ kind: 'allow' }))
      if (decision.kind === 'deny') return decision.reason
    }
    for (const guard of guards) { const reason = guard(exec); if (reason) return reason }
    return null
  }
  return { root, workspace, file, skillRoot, promptFile, storeFile, service, call, agent,
    get protection() { return protection }, attach, lookups, setCwd: value => { cwd = value }, setHostContent: value => { hostContent = value } }
}

test('protection choices are explicit, durable, workspace-bound and never upgraded on restore', async t => {
  const f = await fixture(t)
  assert.equal(f.protection.status('live').enabled, false)
  assert.throws(() => f.protection.requireProtected('live'), { code: 'protection-required' })
  assert.equal((await f.protection.set('live', true)).protection.mode, 'read-only')
  assert.match(await f.call('write', { file_path: 'result.txt', content: 'result' }), /只读/)
  assert.equal(await f.call('read', { file_path: 'input.txt' }), null)
  f.protection.dispose(); f.attach(); await f.protection.initialization
  assert.equal(f.protection.status('live').mode, 'read-only')
  assert.equal((await f.protection.set('live', true, 'workspace-write')).protection.mode, 'workspace-write')
  assert.equal(await f.call('write', { file_path: 'result.txt', content: 'result' }), null)
  assert.match(await f.call('write', { file_path: f.storeFile, content: '{}' }), /控制面|工作区外/)
  await assert.rejects(f.protection.set('live', true, 'danger-full-access'), { code: 'invalid-protection' })
  assert.equal((await f.protection.set('live', false)).protection.enabled, false)
  assert.deepEqual(JSON.parse(await readFile(f.storeFile, 'utf8')).protections, {})
})

test('actual host skill identity must match reviewed bytes and companion edits revoke active grants', async t => {
  const f = await fixture(t)
  await f.protection.set('live', true)
  // A same-name workspace instance must not replace the host-resolved file.
  const installed = f.service.index.data.skills['fixture-id']
  f.service.index.data.skills['other-instance'] = { ...installed, instanceId: 'other-instance',
    scope: 'workspace', workspace: f.workspace, path: join(f.workspace, 'other'), file: join(f.workspace, 'other', 'SKILL.md') }
  f.setHostContent('Different host instructions')
  assert.match(await f.call('skill', { name: 'fixture' }), /实际加载.*不一致/)
  f.setHostContent('# Fixture\nRead text only.')
  assert.equal(await f.call('skill', { name: 'fixture' }), null)
  assert.equal(await f.call('read', { file_path: f.file }), null, 'only reviewed manifest resources may be read outside workspace')
  await writeFile(join(f.skillRoot, 'helper.js'), 'console.log("changed")')
  assert.match(await f.call('read', { file_path: 'input.txt' }), /变化|重新审查/)
})

test('prompt policy changes revoke loaded skill grants before a further tool body', async t => {
  const f = await fixture(t)
  await f.protection.set('live', true)
  assert.equal(await f.call('skill', { name: 'fixture' }), null)
  await writeFile(f.promptFile, 'Changed review policy')
  assert.match(await f.call('read', { file_path: 'input.txt' }), /策略|过期|重新审查/)
})

test('corrupt persisted choices stay intact and pause tools instead of becoming unprotected', async t => {
  const f = await fixture(t)
  f.protection.dispose()
  const damaged = '{"protections":'
  await writeFile(f.storeFile, damaged)
  f.attach(); await f.protection.initialization
  assert.equal(f.protection.status('live').available, false)
  assert.match(f.protection.status('live').reason, /所有工具调用暂缓/)
  assert.match(await f.call('read', { file_path: 'input.txt' }), /恢复/)
  await assert.rejects(f.protection.set('live', true), { code: 'protection-unavailable' })
  assert.equal(await readFile(f.storeFile, 'utf8'), damaged)
})

test('skill lookup follows the host current cwd inside the fixed session workspace', async t => {
  const f = await fixture(t)
  const nested = join(f.workspace, 'nested-project')
  await mkdir(nested)
  await f.protection.set('live', true)
  f.setCwd(nested)
  assert.equal(await f.call('skill', { name: 'fixture' }), null)
  assert.equal(f.lookups.at(-1), nested)
})

test('actual scoped skills service works when Cordis rejects direct property injections', async t => {
  const f = await fixture(t)
  const skills = f.agent.ctx.skills
  f.agent.ctx.get = name => name === 'skills' ? skills : undefined
  Object.defineProperty(f.agent.ctx, 'skills', { get() { throw new Error('undeclared service injection') } })
  await f.protection.set('live', true)
  assert.equal(await f.call('skill', { name: 'fixture' }), null)
})
