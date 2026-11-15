import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile, symlink, link } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planRepoTask, createRepoTaskService, checkJavaScriptSyntax, __test } from '../repo-task-service.js'
import { executeFileRecipe } from '../file-recipes.js'
import { attachRuntimePolicy } from '../runtime-policy.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS || join(repo, '../test-artifacts/usability-2026-11-16'))
const operations = ['repo-inventory', 'todo-report', 'javascript-check']

async function fixture() {
  await mkdir(artifacts, { recursive: true })
  const root = await mkdtemp(join(artifacts, 'repo-task-')), workspace = join(root, 'workspace'), outside = join(root, 'outside')
  await mkdir(join(workspace, 'src'), { recursive: true }); await mkdir(outside)
  await writeFile(join(workspace, 'README.md'), '# Example\nTODO: docs\n')
  await writeFile(join(workspace, 'src', 'app.js'), '// FIXME: example\nexport const answer = 42\n')
  const context = { workspaceRoot: workspace, cwd: workspace, mode: 'read-only' }, active = [{ operations, readonlyRoots: [] }]
  const plan = (operation, extra = {}) => planRepoTask({ operation, input_path: workspace, ...extra }, active, context)
  return { root, workspace, outside, context, active, plan }
}

test('fixed repository plans require a loaded matching skill and reject arbitrary arguments', async () => {
  const f = await fixture()
  assert.throws(() => planRepoTask({ operation: 'repo-inventory', input_path: f.workspace }, [], f.context), { code: 'recipe-skill-required' })
  assert.throws(() => f.plan('repo-inventory', { command: 'ignored command must still reject' }), { code: 'repo-task-invalid' })
  assert.throws(() => f.plan('shell'), { code: 'repo-task-invalid' })
  assert.throws(() => f.plan('repo-inventory', { input_path: f.outside }), { code: 'runtime-path-denied' })
  assert.throws(() => f.plan('repo-inventory', { input_path: '../outside' }), { code: 'runtime-path-denied' })
  assert.throws(() => f.plan('repo-inventory', { output_path: join(f.workspace, 'report.md') }), { code: 'runtime-write-denied' })
  f.context.mode = 'workspace-write'
  assert.throws(() => f.plan('repo-inventory', { output_path: join(f.workspace, 'payload.js') }), { code: 'repo-task-invalid' })
  assert.equal(f.plan('repo-inventory', { output_path: join(f.workspace, 'report.md') }).output, join(f.workspace, 'report.md'))
})

test('walkers skip secrets, control and dependency directories without reading their contents', async () => {
  const f = await fixture()
  for (const name of ['.git', 'node_modules', 'secrets']) {
    await mkdir(join(f.workspace, name))
    await writeFile(join(f.workspace, name, 'excluded.js'), '// TODO: MUST_NOT_APPEAR\n')
  }
  await writeFile(join(f.workspace, '.env'), 'FIXME=FIXTURE_NOT_A_SECRET\n')
  const input = await __test.repositoryInput(f.plan('todo-report'))
  assert.deepEqual(input.files.map(file => file.path), ['README.md', 'src/app.js'])
  assert.equal(input.directories, 1)
  assert.equal(input.excluded.length, 4)
  const result = executeFileRecipe('todo-report', input)
  assert.equal(result.summary.markerCount, 2)
  assert.ok(!result.text.includes('MUST_NOT_APPEAR'))
})

test('walkers refuse symlinks and hardlinks instead of following out-of-scope files', async t => {
  const f = await fixture(), target = join(f.outside, 'external.js'), alias = join(f.workspace, 'alias.js')
  await writeFile(target, '// TODO: OUTSIDE\n')
  try { await symlink(target, alias) }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) t.diagnostic('OS denies file symlink creation; hardlink case still runs'); else throw error }
  if (await readFile(alias).then(() => true, () => false)) await assert.rejects(__test.repositoryInput(f.plan('todo-report')), { code: 'repo-input-unverifiable' })
  const second = await fixture()
  await link(join(second.workspace, 'src', 'app.js'), join(second.workspace, 'duplicate.js'))
  await assert.rejects(__test.repositoryInput(second.plan('todo-report')), error => ['runtime-path-denied', 'repo-input-unverifiable'].includes(error.code))
})

test('UTF-8 BOM source stays byte-complete for TODO reporting', async () => {
  const f = await fixture()
  await writeFile(join(f.workspace, 'src', 'bom.js'), '\uFEFF// TODO: BOM source\n')
  const input = await __test.repositoryInput(f.plan('todo-report'))
  const source = input.files.find(file => file.path === 'src/bom.js')
  assert.equal(Buffer.byteLength(source.text, 'utf8'), source.bytes)
  assert.equal(executeFileRecipe('todo-report', input).summary.markerCount, 3)
})

test('fixed JavaScript checks parse valid and invalid syntax without executing source', async () => {
  const valid = await checkJavaScriptSyntax('throw new Error("PARSER_ONLY_MUST_NOT_RUN"); export const answer = 42;', 'module')
  assert.equal(valid.passed, true)
  assert.equal(valid.diagnostic, '')
  const bad = await checkJavaScriptSyntax('export const = ;', 'module')
  assert.equal(bad.passed, false)
  assert.match(bad.diagnostic, /SyntaxError/)
  const commonjs = await checkJavaScriptSyntax('export const answer = 42;', 'commonjs')
  assert.equal(commonjs.passed, false)
})

test('syntax subprocess ignores ambient Node preload configuration', async () => {
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--require=NONEXISTENT_REPO_TASK_PRELOAD'
  try { assert.equal((await checkJavaScriptSyntax('const value = 1;', 'commonjs')).passed, true) }
  finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous }
})

test('fixed checks use bounded verified text and actual local module metadata', async () => {
  const f = await fixture(), input = join(f.workspace, 'src', 'app.js')
  await writeFile(join(f.workspace, 'package.json'), '{"type":"module","scripts":{"test":"SHOULD_NEVER_RUN"}}')
  const plan = f.plan('javascript-check', { input_path: input })
  assert.equal(await __test.inputType(plan), 'module')
  await assert.rejects(checkJavaScriptSyntax('x'.repeat(__test.LIMITS.fileBytes + 1), 'module'), { code: 'repo-task-invalid' })
  await writeFile(join(f.workspace, 'invalid.js'), Buffer.from([0xff, 0xfe]))
  await assert.rejects(__test.checkedSource(join(f.workspace, 'invalid.js')), { code: 'repo-input-unverifiable' })
})

test('tool writes reports only to new allowed files and rechecks authorization before output', async () => {
  const f = await fixture(), output = join(f.workspace, 'report.md'), tools = new Map()
  f.context.mode = 'workspace-write'
  let checks = 0, denySecond = false
  const agent = { id: 'fixture', ctx: { get: name => name === 'tools' ? { get: key => tools.get(key), register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } : undefined } }
  const service = { ctx: { get: name => name === 'agents' ? { get: () => agent } : undefined }, protection: { checkFileTask(exec) {
    checks++
    if (denySecond && checks % 2 === 0) throw Object.assign(new Error('Protection changed'), { code: 'runtime-write-denied' })
    return planRepoTask(exec.arguments, f.active, f.context)
  } } }
  const adapter = createRepoTaskService(service)
  await adapter.initialization
  adapter.attach(agent)
  assert.deepEqual(adapter.capabilities('fixture').operations, operations)
  const args = { operation: 'repo-inventory', input_path: f.workspace, output_path: output }, exec = { name: 'dsh_file_task', arguments: args, agent }
  try {
    const result = await adapter.definition.execute(args, exec)
    assert.equal(result.ok, true)
    assert.equal(result.outputPath, output)
    const original = await readFile(output, 'utf8')
    await assert.rejects(adapter.definition.execute(args, exec), { code: 'EEXIST' })
    assert.equal(await readFile(output, 'utf8'), original)
    checks = 0; denySecond = true
    const next = { ...args, output_path: join(f.workspace, 'blocked.md') }
    await assert.rejects(adapter.definition.execute(next, { ...exec, arguments: next }), { code: 'runtime-write-denied' })
    await assert.rejects(readFile(next.output_path), { code: 'ENOENT' })
    tools.set('dsh_file_task', { ...adapter.definition })
    assert.deepEqual(adapter.capabilities('fixture').operations, [])
  } finally { adapter.dispose() }
})

test('runtime accepts only its pinned repository tool and a currently loaded matching operation', async () => {
  const f = await fixture(), history = [], definitions = new Map(), events = new Map()
  const trusted = { name: 'dsh_file_task', parameters: { type: 'object', required: ['operation', 'input_path'], properties: {} } }
  for (const name of ['read', 'write', 'edit', 'read_image', 'skill']) {
    const field = name === 'skill' ? 'name' : 'file_path'
    definitions.set(name, { name, parameters: { type: 'object', required: [field], properties: { [field]: { type: 'string' } } } })
  }
  definitions.set('dsh_file_task', trusted)
  let guard, evidenceCurrent = true, policy = { enabled: true, mode: 'workspace-write' }
  const agent = { id: 'protected', session: { id: 'protected', header: { cwd: f.workspace }, get seq() { return history.length }, eventAt: index => history[index] } }
  const ctx = {
    tools: { get: name => definitions.get(name), modeFor: () => 'native', guard: callback => { guard = callback; return () => { guard = undefined } } },
    on(name, callback) { events.set(name, callback); return () => events.delete(name) },
    get(name) { return name === 'agents' ? { get: id => id === agent.id ? agent : undefined } : name === 'workingDirectory' ? { get: () => f.workspace } : undefined },
  }
  const options = { getPolicy: () => policy, authorizeSkill: () => ({ operations: ['repo-inventory'], readFiles: [] }),
    validateActiveSkills: () => evidenceCurrent ? {} : { reason: 'Audited skill changed' }, fileTaskDefinition: trusted,
    authorizeFileTask: (exec, active, context) => planRepoTask(exec.arguments, active, context) }
  let adapter = attachRuntimePolicy(ctx, options)
  const exec = args => ({ name: 'dsh_file_task', arguments: { operation: 'repo-inventory', input_path: f.workspace, ...args }, agent })
  try {
    assert.match(guard(exec()), /先加载/)
    assert.equal(guard({ name: 'skill', arguments: { name: 'safe-repo-inventory' }, agent }), undefined)
    history.push({ type: 'tool/call', data: { name: 'skill' } })
    assert.equal(guard(exec()), undefined)
    assert.equal(adapter.checkFileTask(exec()).operation, 'repo-inventory')
    assert.match(guard(exec({ operation: 'todo-report' })), /先加载/)
    assert.match(guard({ ...exec(), parent: {} }), /间接工具通道/)
    definitions.set('dsh_file_task', { ...trusted })
    assert.match(guard(exec()), /作用域覆盖/)
    definitions.set('dsh_file_task', trusted)
    evidenceCurrent = false
    assert.match(guard(exec()), /Audited skill changed/)
    evidenceCurrent = true
    policy = { enabled: true, mode: 'read-only' }
    assert.equal(guard(exec()), undefined)
    assert.match(guard(exec({ output_path: join(f.workspace, 'denied.md') })), /保存报告/)
    adapter.dispose()
    adapter = attachRuntimePolicy(ctx, options)
    assert.equal(adapter.status(agent.id).protected, false)
    assert.match(guard(exec()), /新会话/)
  } finally { adapter.dispose() }
})

test('repository tool attachment follows agent identity and cleans up without deleting a replacement', async () => {
  const live = new Map()
  function agent(id) {
    const definitions = new Map(), cleanups = []
    let registrations = 0, disposals = 0
    const value = { id, cleanups,
      get registrations() { return registrations }, get disposals() { return disposals },
      ctx: {
        get(name) { return name === 'tools' ? tools : undefined },
        effect(factory) { const cleanup = factory(); cleanups.push(cleanup); return cleanup },
      },
    }
    const tools = {
      get: name => definitions.get(name),
      register(definition) {
        registrations++
        definitions.set(definition.name, definition)
        return () => { disposals++; definitions.delete(definition.name) }
      },
    }
    return value
  }
  const service = { ctx: { get: name => name === 'agents' ? { get: id => live.get(id) } : undefined } }
  const adapter = createRepoTaskService(service)
  await adapter.initialization
  const first = agent('reused-session'), second = agent('reused-session'), third = agent('reused-session')
  try {
    live.set(first.id, first)
    adapter.attach(first); adapter.attach(first)
    assert.equal(first.registrations, 1, 'same live agent is idempotent')
    assert.equal(first.cleanups.length, 1)
    assert.deepEqual(adapter.capabilities(first.id).operations, operations)

    live.set(second.id, second)
    adapter.attach(second)
    assert.equal(first.disposals, 1, 'replacing an agent releases its old registration')
    assert.equal(second.registrations, 1, 'a reused session ID gets the new agent tool')
    assert.deepEqual(adapter.capabilities(second.id).operations, operations)

    first.cleanups[0]()
    assert.equal(first.disposals, 1, 'late old cleanup does not dispose twice')
    assert.equal(second.disposals, 0, 'late old cleanup cannot touch the replacement')
    assert.deepEqual(adapter.capabilities(second.id).operations, operations)

    second.cleanups[0]()
    assert.equal(second.disposals, 1)
    assert.deepEqual(adapter.capabilities(second.id).operations, [])

    live.set(third.id, third)
    adapter.attach(third)
    assert.equal(third.registrations, 1, 'agent cleanup removed the previous map entry')
    adapter.dispose()
    assert.equal(third.disposals, 1)
    assert.deepEqual(adapter.capabilities(third.id).operations, [])
    third.cleanups[0](); second.cleanups[0](); adapter.dispose()
    assert.equal(second.disposals, 1)
    assert.equal(third.disposals, 1, 'agent and plugin cleanup remain idempotent')
  } finally { adapter.dispose() }
})
