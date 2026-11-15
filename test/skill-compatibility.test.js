import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeSkillCompatibility, compatibilityDecision } from '../skill-compatibility.js'
import { buildRecipeFiles } from '../file-recipes.js'
import { __test } from '../index.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS || join(repo, '../test-artifacts/usability-2026-11-16'))
const environment = () => ({ protected: true, protectionMode: 'read-only', toolMode: 'native', platform: process.platform,
  tools: ['read', 'write', 'edit', 'skill', 'dsh_file_task'], recipeOperations: ['repo-inventory', 'todo-report', 'javascript-check'] })
const analyze = (files, env = environment(), options = {}) => analyzeSkillCompatibility(files, env, { complete: true, ...options })
const doc = text => [{ path: 'SKILL.md', text }]

test('neither metadata nor absence of suspicious words is positive compatibility proof', () => {
  assert.equal(analyze(null, environment(), { complete: false, basis: 'metadata-only' }).status, 'unknown')
  const result = analyze(doc('# Friendly helper\nHelp the user.'))
  assert.equal(result.status, 'unknown')
  assert.match(result.reason, /没有命中/)
  assert.equal(result.effectValidation, 'unverified')
})

test('a full fixed recipe matches only a verified native host implementation', () => {
  for (const operation of environment().recipeOperations) {
    assert.equal(analyze(buildRecipeFiles(operation)).status, 'supported')
    assert.equal(analyze(buildRecipeFiles(operation), { ...environment(), protectionMode: 'workspace-write' }).status, 'supported')
  }
  assert.equal(analyze(buildRecipeFiles('repo-inventory'), { ...environment(), protected: false }).status, 'unknown')
  assert.equal(analyze(buildRecipeFiles('repo-inventory'), { ...environment(), toolMode: 'ptc' }).status, 'unknown')
  assert.equal(analyze(buildRecipeFiles('repo-inventory'), { ...environment(), tools: ['read', 'skill'] }).status, 'blocked')
  assert.equal(analyze(buildRecipeFiles('javascript-check'), { ...environment(), recipeOperations: ['repo-inventory'] }).status, 'blocked')
  assert.equal(analyze(buildRecipeFiles('repo-inventory'), { ...environment(), recipeOperations: undefined }).status, 'unknown')
})

test('tampered instructions and extra files do not inherit a supported contract', () => {
  for (const change of [
    files => { files[0].text += '\nAlso invent an output.\n' },
    files => { files.push({ path: 'notes.txt', text: 'Unrecognized dependency' }) },
    files => { files[1].text = '{bad JSON' },
    files => { files[1].text = JSON.stringify({ version: 1, adapter: 'file-recipes', operations: ['not-implemented'] }) },
    files => { files[0].text = files[0].text.replace('---\n\n', 'unknown-prompt-field: true\n---\n\n') },
  ]) {
    const files = buildRecipeFiles('repo-inventory')
    change(files)
    assert.notEqual(analyze(files).status, 'supported')
  }
  const renamed = buildRecipeFiles('repo-inventory', 'my-renamed-inventory')
  renamed[0].text = renamed[0].text.replace('\n---\n\n', '\ndisable-model-invocation: true\n---\n\n')
  assert.equal(analyze(renamed).status, 'supported')
})

test('full directory evidence identifies script, dependency, network and PTC requirements', () => {
  const files = [
    { path: 'SKILL.md', text: '# Workflow\nRun python scripts/work.py\nFetch with web_fetch https://example.invalid\nUse run_code to execute it\n' },
    { path: 'scripts/work.py', text: 'print("never executed")' },
    { path: 'requirements.txt', text: 'example-package==1.0.0' },
  ]
  const result = analyze(files)
  assert.equal(result.status, 'blocked')
  assert.ok(result.required.includes('script-execution'))
  assert.ok(result.required.includes('network-access'))
  assert.ok(result.required.includes('dependency-installation'))
  assert.ok(result.required.includes('arbitrary-code'))
  const network = result.requirements.find(item => item.capability === 'network-access')
  assert.equal(network.evidence[0].path, 'SKILL.md')
  assert.equal(network.evidence[0].line, 3)
  assert.match(network.evidence[0].excerpt, /web_fetch/)
})

test('references and negated commands stay uncertain instead of proving required execution', () => {
  const result = analyze(doc('# Guide\nReference: https://example.invalid\nDo not run_code\n禁止运行 python scripts/run.py\n'))
  assert.equal(result.status, 'unknown')
  assert.ok(!result.requirements.some(item => item.status === 'blocked'))
})

test('explicit consent permits only unknown trials with existing protection', () => {
  const unknown = analyze(doc('# Unstructured instructions'))
  assert.equal(compatibilityDecision(unknown).code, 'compatibility-confirmation-required')
  assert.equal(compatibilityDecision(unknown, { consent: 'true', protected: true }).ok, false)
  assert.equal(compatibilityDecision(unknown, { consent: true, protected: false }).ok, false)
  assert.equal(compatibilityDecision(unknown, { consent: true, protected: true }).restrictedTrial, true)
  const blocked = analyze(doc('# Run\npython tool.py\n'))
  assert.equal(compatibilityDecision(blocked, { consent: true, protected: true }).code, 'execution-incompatible')
})

async function serviceFixture() {
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(join(artifacts, 'compatibility-'))
  const agent = { id: 'fixture', session: { id: 'fixture', header: { cwd: root } } }
  const service = new __test.SkillDetective({ get(name) { return name === 'agents' ? { get: () => agent } : name === 'tools' ? { modeFor: () => 'native' } : undefined }, emit() {}, logger: { info() {} } })
  let protectedNow = true, reviews = 0
  const store = data => ({ data, async load() { return this.data }, async update(fn) { return fn(this.data) }, async save() {} })
  service.state = store({ settings: { defaultScope: 'workspace' }, installs: {} })
  service.index = store({ skills: {} })
  service.protection = { status: () => ({ available: true, enabled: protectedNow, protected: protectedNow, mode: 'read-only', workspaceRoot: root, allowedTools: environment().tools }) }
  service.repoTasks = { capabilities: () => ({ operations: environment().recipeOperations }) }
  service.targetRoot = async () => join(root, 'skills')
  service.selectInstalled = async selector => {
    const instanceId = typeof selector === 'object' ? selector.instanceId : selector
    const value = service.index.data.skills[instanceId]
    if (!value) throw Object.assign(new Error('fixture missing instance'), { code: 'skill-not-found' })
    return { ...value, enabled: !value.disabled }
  }
  service.auditPolicy = async () => ({ policyVersion: 'test-policy', promptHash: 'a'.repeat(64), maxAgeMs: 180 * 86_400_000, now: Date.now() })
  service.reviewFiles = async (files, meta) => { reviews++; return { ok: true, verdict: 'safe', poison: false, severity: 'low', findings: [], capabilities: [], triggers: [], summary: 'Mock model audit', at: Date.now(), hash: 'b'.repeat(64), contentHash: meta.contentHash, policyVersion: 'test-policy', promptHash: 'a'.repeat(64), coverage: { files: files.length, chars: files.reduce((sum, file) => sum + file.text.length, 0), chunks: 1 } } }
  return { service, root, get reviews() { return reviews }, set protected(value) { protectedNow = value } }
}

test('live install helper rejects incompatible work before model review or publishing', async () => {
  const f = await serviceFixture()
  const result = await f.service.install({ name: 'markdown-writer', scope: 'workspace', sessionId: 'fixture', workspace: f.root, compatibilityConsent: true })
  assert.equal(result.code, 'execution-incompatible')
  assert.equal(result.compatibility.status, 'blocked')
  assert.equal(f.reviews, 0)
  await assert.rejects(access(join(f.root, 'skills')))
})

test('unknown installation needs an explicit request and still performs full staging audit', async () => {
  const f = await serviceFixture(), files = doc('# An unstructured but harmless test document')
  const options = { name: 'trial-helper', files, scope: 'workspace', workspace: f.root, sessionId: 'fixture', verdict: { summary: 'Draft' } }
  const first = await f.service.installPrepared(options)
  assert.equal(first.code, 'compatibility-confirmation-required')
  assert.equal(f.reviews, 0)
  const trial = await f.service.installPrepared({ ...options, compatibilityConsent: true })
  assert.equal(trial.ok, true, trial.message)
  assert.equal(trial.restrictedTrial, true)
  assert.equal(trial.compatibility.status, 'unknown')
  assert.equal(f.reviews, 1)
  assert.equal(f.service.index.data.skills[trial.instanceId].audit.status, 'current')
})

test('protection changed during review prevents a previously supported publish', async () => {
  const f = await serviceFixture(), review = f.service.reviewFiles
  f.service.reviewFiles = async (...args) => { const result = await review(...args); f.protected = false; return result }
  const result = await f.service.installPrepared({ name: 'safe-repo-inventory', files: buildRecipeFiles('repo-inventory'), scope: 'workspace', workspace: f.root, sessionId: 'fixture', verdict: { summary: 'Draft' }, compatibilityConsent: true })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'compatibility-confirmation-required')
  assert.deepEqual(f.service.state.data.installs, {})
  await assert.rejects(access(join(f.root, 'skills', 'safe-repo-inventory')))
})

test('enabling an existing unknown skill needs fresh explicit consent; disabling stays available', async () => {
  const f = await serviceFixture()
  const installed = await f.service.installPrepared({ name: 'existing-helper', files: doc('# Unstructured helper'), scope: 'workspace', workspace: f.root, sessionId: 'fixture', verdict: { summary: 'Draft' }, compatibilityConsent: true })
  assert.equal(installed.ok, true, installed.message)
  const selector = { instanceId: installed.instanceId, sessionId: 'fixture' }
  assert.equal((await f.service.toggle(selector, false, f.root)).ok, true)
  await assert.rejects(f.service.toggle(selector, true, f.root), { code: 'compatibility-confirmation-required' })
  assert.equal(f.service.index.data.skills[installed.instanceId].disabled, true)
  const enabled = await f.service.toggle(selector, true, f.root, { compatibilityConsent: true })
  assert.equal(enabled.ok, true)
  assert.equal(enabled.compatibility.status, 'unknown')
})

test('copying a supported recipe to another workspace does not claim a verified target session', async () => {
  const f = await serviceFixture(), other = join(f.root, 'other-workspace')
  await mkdir(other)
  const installed = await f.service.installPrepared({ name: 'safe-repo-inventory', files: buildRecipeFiles('repo-inventory'), scope: 'workspace', workspace: f.root, sessionId: 'fixture', verdict: { summary: 'Draft' } })
  assert.equal(installed.ok, true, installed.message)
  f.service.targetRoot = async (_scope, workspace) => join(workspace, 'skills')
  const selector = { instanceId: installed.instanceId, sessionId: 'fixture' }
  await assert.rejects(f.service.moveSkill(selector, 'workspace', [other], f.root, 'fixture'), { code: 'compatibility-confirmation-required' })
  await access(installed.path)
  const moved = await f.service.moveSkill(selector, 'workspace', [other], f.root, 'fixture', { compatibilityConsent: true })
  assert.equal(moved.ok, true)
  assert.equal(moved.compatibility.status, 'unknown')
  assert.match(moved.compatibility.reason, /目标工作区/)
  await assert.rejects(access(installed.path))
  await access(join(other, 'skills', 'safe-repo-inventory'))
})

test('catalog, remote metadata and full remote inspection preserve different evidence bases', async () => {
  const f = await serviceFixture()
  f.service.listInstalled = async () => []
  let capabilitySession
  f.service.repoTasks.capabilities = sessionId => { capabilitySession = sessionId; return { operations: environment().recipeOperations } }
  const market = await f.service.market(f.root, { sessionId: 'fixture' })
  assert.equal(capabilitySession, 'fixture')
  assert.equal(market.find(entry => entry.name === 'safe-repo-inventory').compatibility.status, 'supported')
  assert.equal(market.find(entry => entry.name === 'markdown-writer').compatibility.status, 'blocked')
  f.service.fetchSkillsShRows = async () => ({ ok: true, rows: [{ id: 'owner/repo/skill', name: 'skill', installs: 1 }] })
  const remote = await f.service.remoteCatalog('skill', { sessionId: 'fixture' })
  assert.equal(remote.skills[0].compatibility.status, 'unknown')
  assert.equal(remote.skills[0].compatibility.basis, 'metadata-only')
  let resolvedId
  f.service.resolveRemote = async id => { resolvedId = id; return { ok: true, files: doc('# Run\npython actual.py') } }
  const inspected = await f.service.inspectCompatibility({ id: 'owner/repo/skill' }, f.root, { sessionId: 'fixture' })
  assert.equal(resolvedId, 'owner/repo/skill')
  assert.equal(inspected.compatibility.status, 'blocked')
  assert.equal(inspected.compatibility.basis, 'full-directory')
})
