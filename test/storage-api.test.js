import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS ?? join(project, '../test-artifacts/fix-2026-11-13'))
const root = join(artifacts, `storage-api-${randomUUID()}`)
await mkdir(root, { recursive: true })
process.env.DSH_HOME = join(root, 'dsh-home')
const { apply, __test } = await import('../index.js')
const { JsonStore, StateStore, readJsonFile, writeJsonFile } = __test

test('corrupt or non-object state is preserved and cannot be silently overwritten', async () => {
  for (const [label, contents] of [['syntax', '{broken'], ['array', '[]'], ['null', 'null']]) {
    const file = join(root, `${label}.json`)
    await writeFile(file, contents)
    await assert.rejects(readJsonFile(file), { code: 'state-corrupt' })
    await assert.rejects(writeJsonFile(file, { replacement: true }), { code: 'state-corrupt' })
    assert.equal(await readFile(file, 'utf8'), contents)
  }
  assert.equal(await readJsonFile(join(root, 'missing.json')), null)
  await assert.rejects(readJsonFile(root), error => error.code !== 'ENOENT')
})

test('JSON replacement keeps the last valid backup and no shared temporary file', async () => {
  const file = join(root, 'backup.json')
  await writeJsonFile(file, { counter: 1 })
  await writeJsonFile(file, { counter: 2 })
  assert.deepEqual(await readJsonFile(file), { counter: 2 })
  assert.deepEqual(await readJsonFile(`${file}.bak`), { counter: 1 })
  assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp')))
})

test('different store instances serialize read-modify-write without losing panel actions', async () => {
  const file = join(root, 'parallel.json')
  const stores = [new JsonStore(file), new JsonStore(file)]
  await Promise.all(Array.from({ length: 16 }, (_, index) => stores[index % 2].update(async data => {
    const before = data.count ?? 0
    await new Promise(resolve => setImmediate(resolve))
    data.count = before + 1
  })))
  assert.equal((await readJsonFile(file)).count, 16)
})

test('failed mutations and failed saves restore both in-memory and persisted state', async () => {
  const file = join(root, 'rollback.json')
  const store = new JsonStore(file)
  await store.update(data => { data.count = 7 })
  await assert.rejects(store.update(data => { data.count = 99; throw new Error('fixture mutation failure') }))
  assert.equal((await store.load()).count, 7)
  assert.equal((await readJsonFile(file)).count, 7)
  const save = store.save
  store.save = async () => { throw new Error('fixture disk failure') }
  await assert.rejects(store.update(data => { data.count = 100 }), /fixture disk failure/)
  assert.equal((await store.load()).count, 7)
  assert.equal((await readJsonFile(file)).count, 7)
  store.save = save
  await store.update(data => { data.count += 1 })
  assert.equal((await readJsonFile(file)).count, 8)
})

test('state metadata retains instance identity and rejects prototype dictionary keys', async () => {
  const file = join(root, 'instances.json')
  const record = { name: 'shared-skill', path: join(root, 'workspace-a/shared-skill'), workspace: join(root, 'workspace-a'), sessionId: 'live', installedAt: Date.now() }
  await writeJsonFile(file, { installs: { 'instance:fixture-a': record }, deleted: { 'instance:fixture-b': { ...record, at: Date.now(), group: 'test' } } })
  const store = new StateStore(file)
  const state = await store.load()
  assert.equal(state.installs['instance:fixture-a'].sessionId, 'live')
  assert.equal(state.deleted['instance:fixture-b'].path, record.path)
  const polluted = store.normalize(JSON.parse('{"installs":{"__proto__":{"installedAt":1}},"sessions":{"constructor":true},"suppressed":{"__proto__":{"at":1}}}'))
  assert.deepEqual(Object.keys(polluted.installs), [])
  assert.deepEqual(Object.keys(polluted.sessions), [])
  assert.deepEqual(Object.keys(polluted.suppressed), [])
  assert.equal({}.installedAt, undefined)
})

test('HTTP routes reject malformed bodies and select exact workspace skill instances', async t => {
  const workspaceA = join(root, 'workspace-a')
  const workspaceB = join(root, 'workspace-b')
  for (const workspace of [workspaceA, workspaceB]) {
    const dir = join(workspace, '.dsh/skills/shared-skill')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), `---\nname: shared-skill\ndescription: "${workspace === workspaceA ? 'A' : 'B'}"\n---\n# Fixture\n`)
  }
  const events = new Map(), disposers = [], effectDisposers = new Map()
  let handler
  const definitions = new Map(['read', 'skill'].map(name => {
    const field = name === 'skill' ? 'name' : 'file_path'
    return [name, { name, parameters: { type: 'object', required: [field], properties: { [field]: { type: 'string' } } } }]
  }))
  const tools = {
    get: name => definitions.get(name), modeFor: () => 'native', guard: () => () => {},
    register(definition) { definitions.set(definition.name, definition); return () => definitions.delete(definition.name) },
  }
  const scoped = { effect: fn => fn(), skills: { register: () => () => {} }, get: name => name === 'tools' ? tools : undefined }
  const agent = { id: 'session-live', session: { id: 'session-live', header: { title: 'HTTP repository fixture', cwd: workspaceB }, seq: 0, eventAt: () => undefined }, ctx: scoped }
  const services = {
    tools,
    workingDirectory: { defaultDirectory: workspaceA, get: session => session?.header?.cwd || workspaceA },
    workspaceRegistry: { list: () => [{ path: workspaceA, title: 'A' }, { path: workspaceB, title: 'B' }] },
    skills: { list: async () => [], register: () => () => {} },
    agents: { get: id => id === 'session-live' ? agent : undefined, list: () => [agent] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'local-fixture', model: 'deterministic-audit' }) },
    llm: {
      listProviders: () => [{ id: 'local-fixture' }],
      async *stream(request) {
        assert.equal(request.sessionId, 'session-live')
        yield { type: 'text-delta', text: JSON.stringify({ verdict: 'safe', severity: 'low', findings: [], summary: 'Local deterministic fixture review', capabilities: ['fixture'], triggers: ['fixture'], slug: '' }) }
      },
    },
  }
  const ctx = {
    get: name => services[name], logger: { info() {} },
    effect(fn, label) { const dispose = fn(); if (typeof dispose === 'function') { disposers.push(dispose); effectDisposers.set(label, dispose) } return dispose },
    on(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name).delete(fn) },
    emit(name, ...args) { for (const fn of events.get(name) ?? []) fn(...args) },
    inject(_names, fn) { return fn(ctx) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }
  apply(ctx)
  const server = createServer((req, res) => { handler(req, res).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/dsh-skill-detective`
  const request = async (path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  try {
    for (const body of ['{invalid', 'null', '[]', '7']) assert.equal((await request('/settings', body)).status, 400)
    assert.equal((await request('/settings', '{}', { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await request('/settings', { value: 'x'.repeat(513 * 1024) })).status, 413)
    assert.equal((await request('/settings', {}, { origin: 'https://foreign.invalid' })).status, 403)
    assert.equal((await request('/scan', {})).body.ok, true)
    const query = `?workspace=${encodeURIComponent(workspaceB)}&sessionId=session-live`
    const state = (await request(`/state${query}`)).body
    assert.equal(state.sessionAvailable, true)
    assert.equal(state.sessionId, 'session-live')
    assert.ok(state.sessions.some(session => session.id === 'session-live'))
    const target = state.installed.find(skill => skill.name === 'shared-skill')
    assert.equal(target.workspace, workspaceB)
    assert.ok(target.instanceId)
    const selector = { name: target.name, instanceId: target.instanceId, path: target.path, workspace: workspaceB, sessionId: 'session-live' }
    assert.equal(target.audit.status, 'unreviewed')
    const missingReviewSession = await request('/review', { ...selector, sessionId: '' })
    assert.equal(missingReviewSession.body.ok, false)
    assert.equal(missingReviewSession.body.code, 'session-unavailable')
    const reviewed = await request('/review', selector)
    assert.equal(reviewed.body.ok, true, JSON.stringify(reviewed.body))
    assert.equal(reviewed.body.audit.status, 'current')
    assert.equal(reviewed.body.audit.scope, 'full-directory')
    const refreshed = (await request(`/state${query}`)).body.installed.find(item => item.instanceId === selector.instanceId)
    assert.equal(refreshed.audit.status, 'current')
    assert.ok(refreshed.audit.checkedAt)
    await writeFile(join(target.path, '.companion.txt'), 'NEW_HIDDEN_COMPANION')
    const changed = (await request(`/state${query}`)).body.installed.find(item => item.instanceId === selector.instanceId)
    assert.equal(changed.audit.status, 'changed', 'state refresh must not reuse its scan TTL approval')
    const detail = await request(`/detail${query}&instanceId=${encodeURIComponent(selector.instanceId)}&name=${selector.name}&path=${encodeURIComponent(selector.path)}`)
    assert.equal(detail.body.skill.audit.status, 'changed')
    assert.equal((await request('/toggle', { ...selector, enabled: false })).body.ok, true)
    assert.doesNotMatch(await readFile(join(workspaceA, '.dsh/skills/shared-skill/SKILL.md'), 'utf8'), /disable-model-invocation: true/)
    assert.match(await readFile(join(workspaceB, '.dsh/skills/shared-skill/SKILL.md'), 'utf8'), /disable-model-invocation: true/)
    assert.equal((await request('/scope', { ...selector, scope: 'invalid' })).status, 400)
    assert.equal((await request('/toggle', { ...selector, enabled: 'false' })).status, 400)
    const mismatch = await request('/delete', { ...selector, path: join(workspaceA, '.dsh/skills/shared-skill') })
    assert.ok(mismatch.status >= 400 || mismatch.body.ok === false)
    const unavailable = (await request(`/state?workspace=${encodeURIComponent(workspaceB)}&sessionId=missing`)).body
    assert.equal(unavailable.sessionAvailable, false)

    let capturedService
    await t.test('HTTP mutations forward only literal compatibility consent and retain exact selector context', async subtest => {
      const protectedSession = await request('/protection', { sessionId: 'session-live', enabled: true, mode: 'read-only' })
      assert.equal(protectedSession.body.ok, true, JSON.stringify(protectedSession.body))
      assert.equal(protectedSession.body.protection.mode, 'read-only')
      const calls = []
      for (const method of ['install', 'installRemote', 'learn', 'toggle', 'moveSkill', 'replace', 'learnAll']) {
        subtest.mock.method(__test.SkillDetective.prototype, method, async function (...args) {
          capturedService = this
          calls.push({ method, args })
          return { ok: true, name: 'fixture', learned: 0, skipped: 0 }
        })
      }
      const routes = [
        { route: '/install', method: 'install', body: { ...selector, origin: 'market' }, options: args => args[0] },
        { route: '/remote/install', method: 'installRemote', body: { ...selector, id: 'owner/repository/fixture', scope: 'workspace' }, options: args => args[3] },
        { route: '/learn', method: 'learn', body: { ...selector }, options: args => args[2] },
        { route: '/toggle', method: 'toggle', body: { ...selector, enabled: true }, options: args => args[3] },
        { route: '/scope', method: 'moveSkill', body: { ...selector, scope: 'global', workspaces: [workspaceB] }, options: args => args[5] },
        { route: '/replace', method: 'replace', body: { ...selector }, options: args => args[2] },
        { route: '/learn-all', method: 'learnAll', body: { workspace: workspaceB, sessionId: 'session-live' }, options: args => args[1] },
      ]
      for (const spec of routes) {
        for (const value of [undefined, 'true', true]) {
          const body = { ...spec.body, ...(value === undefined ? {} : { compatibilityConsent: value }) }
          const result = await request(spec.route, body)
          assert.equal(result.body.ok, true, `${spec.route}: ${JSON.stringify(result.body)}`)
          const call = calls.at(-1)
          assert.equal(call.method, spec.method)
          assert.equal(spec.options(call.args).compatibilityConsent, value === true, `${spec.route} must not infer consent from omission or strings`)
          if (spec.method !== 'moveSkill') assert.equal(spec.options(call.args).sessionId, 'session-live')
          else { assert.equal(call.args[4], 'session-live'); assert.equal(call.args[1], 'global') }
          if (spec.method !== 'install' && spec.method !== 'installRemote' && spec.method !== 'learnAll') {
            assert.equal(call.args[0].instanceId, selector.instanceId)
            assert.equal(call.args[0].path, selector.path)
          }
          if (spec.method === 'installRemote') { assert.equal(call.args[0], 'owner/repository/fixture'); assert.equal(call.args[3].instanceId, selector.instanceId) }
        }
      }
      assert.equal(calls.length, routes.length * 3)
    })

    await t.test('HTTP preflight and fixed-target recovery remain reachable when the primary state is corrupt', async () => {
      assert.ok(capturedService)
      // The module binds DSH_HOME at import. Reuse this one serial HTTP fixture
      // and stop only its background scans before temporarily corrupting state.
      effectDisposers.get('skill-detective: initial skill scan')?.()
      effectDisposers.get('skill-detective: rescan on skills change')?.()
      const file = join(process.env.DSH_HOME, 'skill-detective.json')
      const backupFile = `${file}.bak`, before = await readFile(file)
      const corrupt = Buffer.from('{HTTP_STATE_CORRUPTION\n')
      const arbitraryPath = join(root, 'never-a-recovery-target.json')
      await writeFile(arbitraryPath, 'PRESERVE_ARBITRARY_FILE')
      await writeFile(backupFile, before)
      await writeFile(file, corrupt)
      capturedService.state.data = null
      try {
        const failedState = await request(`/state${query}`)
        assert.equal(failedState.status, 409)
        assert.equal(failedState.body.error.code, 'state-corrupt')
        const preflight = await request(`/preflight${query}`)
        assert.equal(preflight.status, 200)
        assert.equal(preflight.body.ok, true)
        assert.equal(preflight.body.ready, false)
        assert.ok(preflight.body.sessions.some(item => item.id === 'session-live'))
        const storage = preflight.body.checks.find(item => item.id === 'storage-state')
        assert.equal(storage.status, 'blocked')
        assert.deepEqual(storage.action, { type: 'preview-recovery', label: '预览备份恢复', target: 'state' })
        assert.equal(preflight.body.recovery.files.find(item => item.id === 'state').backupAvailable, true)

        const invalidTarget = await request('/recovery/preview', { target: arbitraryPath })
        assert.ok(invalidTarget.status >= 400 && invalidTarget.status < 500)
        assert.equal(invalidTarget.body.error.code, 'invalid-recovery-target')
        const preview = await request('/recovery/preview', { target: 'state', path: arbitraryPath, backupPath: arbitraryPath })
        assert.equal(preview.body.ok, true)
        assert.equal(preview.body.canRestore, true)
        assert.equal(preview.body.summary.path, file)
        assert.equal(preview.body.summary.backup.path, backupFile)
        assert.deepEqual(await readFile(file), corrupt, 'Preview must leave corrupt original untouched')
        assert.equal((await request('/recovery/restore', { target: 'index', previewToken: preview.body.previewToken })).body.error.code, 'recovery-preview-expired')
        assert.deepEqual(await readFile(file), corrupt)

        const restored = await request('/recovery/restore', { target: 'state', previewToken: preview.body.previewToken, path: arbitraryPath })
        assert.equal(restored.body.ok, true, JSON.stringify(restored.body))
        assert.equal(restored.body.recovered, true)
        assert.equal(restored.body.preservedPath, preview.body.summary.preservedPath)
        assert.deepEqual(await readFile(restored.body.preservedPath), corrupt)
        assert.deepEqual(await readFile(file), before)
        assert.deepEqual(await readFile(backupFile), before)
        assert.equal(await readFile(arbitraryPath, 'utf8'), 'PRESERVE_ARBITRARY_FILE')
        const recoveredPreflight = await request(`/preflight${query}`)
        assert.equal(recoveredPreflight.body.recovery.files.find(item => item.id === 'state').state, 'valid')
        assert.equal((await request('/recovery/restore', { target: 'state', previewToken: preview.body.previewToken })).body.error.code, 'recovery-preview-expired')
      } finally {
        // Leave the shared per-file test home valid even if an assertion fails.
        await writeFile(file, before)
        capturedService.state.data = null
      }
    })
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await new Promise(resolve => server.close(resolve))
  }
})
