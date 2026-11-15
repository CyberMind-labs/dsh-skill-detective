import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createOnboardingService } from '../onboarding-service.js'

const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS || '../test-artifacts/usability-2026-11-16')
await mkdir(artifacts, { recursive: true })

async function fixture(options = {}) {
  const root = await mkdtemp(join(artifacts, 'onboarding-'))
  const workspace = join(root, 'repository'), otherWorkspace = join(root, 'another-repository')
  await Promise.all([workspace, otherWorkspace].map(path => mkdir(path, { recursive: true })))
  const calls = { routes: 0, choices: [], selection: [], compatibility: [] }
  const tools = { modeFor: () => options.mode ?? 'native' }
  const agents = new Map(['first-live', 'second-live'].map(id => [id, {
    id, session: { header: { title: `Repository work ${id}`, cwd: options.mismatchedWorkspace ? otherWorkspace : workspace } },
    ctx: { get: key => key === 'tools' ? tools : undefined },
  }]))
  const service = {
    ctx: { get: key => key === 'agents' ? { get: id => agents.get(id), list: () => [...agents.values()] } : key === 'tools' ? tools : undefined },
    normalizeWorkspace: value => value ? resolve(value) : workspace,
    validSessionId: id => agents.has(id) ? id : '',
    state: { load: async () => {
      if (options.corruptState) throw new Error('Unreadable JSON')
      return { sessions: {}, settings: {} }
    } },
    judge: {
      route: async () => { calls.routes += 1; return options.configured === false ? null : { provider: 'fixture-provider', model: 'fixture-model' } },
      review: () => assert.fail('Preflight must not call a review model'),
    },
    protection: { status: id => ({ available: Boolean(id), enabled: Boolean(id) && options.protected !== false, protected: Boolean(id) && options.protected !== false, mode: 'read-only', workspace }) },
    repoTasks: { capabilities: () => ({ toolAvailable: true, operations: ['repository-tree', 'todo-summary', 'javascript-syntax-check'] }) },
    recovery: {
      describe: async () => ({ files: options.recoveryFiles ?? [{ id: 'state', label: 'Recommendation state', state: 'valid', backupAvailable: true }] }),
      restore: () => assert.fail('Preflight must never restore a backup'),
    },
    workspaceList: () => [{ path: workspace, title: 'Repository' }],
    selectInstalled: async (...args) => {
      calls.selection.push(args)
      return options.selected ?? { name: 'reviewed-recipe', audit: { status: 'current' }, compatibility: { status: 'supported', summary: 'Fixed repository operation' } }
    },
    inspectCompatibility: async (...args) => {
      calls.compatibility.push(args)
      if (options.compatibilityError) throw new Error(options.compatibilityError)
      return { ok: true, compatibility: options.compatibility ?? { status: 'unknown', summary: 'Candidate needs complete inspection' } }
    },
  }
  const onboarding = createOnboardingService(service, {
    sessionChoices: (currentService, state, requestedId) => {
      calls.choices.push({ state, requestedId })
      return currentService.ctx.get('agents').list().map(agent => ({ id: agent.id, title: agent.session.header.title }))
    },
  })
  return { onboarding, workspace, otherWorkspace, calls }
}

const check = (result, id) => {
  const found = result.checks.find(item => item.id === id)
  assert.ok(found, `Missing prerequisite: ${id}`)
  return found
}

test('preflight without a selected session lists all live choices without requiring automatic recommendations', async () => {
  const { onboarding, calls } = await fixture()
  const result = await onboarding.preflight()
  assert.equal(result.ok, true)
  assert.equal(result.ready, false)
  assert.deepEqual(result.sessions.map(session => session.id), ['first-live', 'second-live'])
  assert.equal(result.session.id, '', 'Never guess a recent or first live conversation')
  assert.equal(result.session.available, false)
  assert.equal(check(result, 'session').action.type, 'choose-session')
  assert.match(check(result, 'session').message, /无需开启自动推荐/)
  assert.deepEqual(calls.choices[0].state.sessions, {})
})

test('model discovery reports configured and tested false without a model inference or task execution', async () => {
  const { onboarding, calls } = await fixture()
  const result = await onboarding.preflight({ sessionId: 'first-live' })
  assert.deepEqual(result.model, { configured: true, provider: 'fixture-provider', model: 'fixture-model', tested: false })
  assert.equal(check(result, 'model').status, 'pass')
  assert.match(check(result, 'model').message, /尚未验证/)
  assert.equal(calls.routes, 1)
  assert.equal(calls.selection.length, 0)
})

test('unconfigured models produce a concrete configuration action rather than claiming availability', async () => {
  const { onboarding } = await fixture({ configured: false })
  const result = await onboarding.preflight({ sessionId: 'first-live' })
  assert.equal(result.ready, false)
  assert.equal(result.model.configured, false)
  assert.equal(result.model.tested, false)
  assert.equal(check(result, 'model').action.type, 'configure-model')
})

test('PTC mode requires an explicit native-mode action without silently changing tools', async () => {
  const { onboarding } = await fixture({ mode: 'ptc' })
  const result = await onboarding.preflight({ sessionId: 'first-live' })
  assert.equal(result.ready, false)
  assert.equal(check(result, 'tool-mode').status, 'action')
  assert.equal(check(result, 'tool-mode').action.type, 'choose-native-mode')
})

test('a different fixed session workspace requires selecting the right workspace', async () => {
  const { onboarding } = await fixture({ mismatchedWorkspace: true })
  const result = await onboarding.preflight({ sessionId: 'first-live' })
  assert.equal(result.ready, false)
  assert.equal(check(result, 'session-workspace').status, 'action')
  assert.equal(check(result, 'session-workspace').action.type, 'select-workspace')
})

test('disabled protection asks for read-only protection and does not imply write permission', async () => {
  const { onboarding } = await fixture({ protected: false })
  const result = await onboarding.preflight({ sessionId: 'first-live' })
  assert.equal(result.ready, false)
  assert.equal(result.protection.enabled, false)
  assert.equal(check(result, 'protection').action.type, 'enable-read-only-protection')
  assert.equal(result.checks.some(item => item.action?.type === 'enable-workspace-write'), false)
})

test('state corruption leaves recovery diagnostics and live choices accessible with fixed targets', async () => {
  const files = [{ id: 'state', label: 'Recommendation state', state: 'corrupt', backupAvailable: true },
    { id: 'index', label: 'Skill index', state: 'corrupt', backupAvailable: true },
    { id: 'audit-cache', label: 'Review cache', state: 'corrupt', backupAvailable: false }]
  const { onboarding } = await fixture({ corruptState: true, recoveryFiles: files })
  const result = await onboarding.preflight()
  assert.equal(result.ok, true)
  assert.equal(result.ready, false)
  assert.equal(result.sessions.length, 2)
  assert.deepEqual(result.recovery.files, files)
  for (const id of ['state', 'index']) {
    assert.equal(check(result, `storage-${id}`).status, 'blocked')
    assert.deepEqual(check(result, `storage-${id}`).action, { type: 'preview-recovery', label: '预览备份恢复', target: id })
  }
  assert.equal(check(result, 'storage-audit-cache').action.type, 'retry-check')
})

test('ready means verified prerequisites, while model connectivity and task results remain untested', async () => {
  const { onboarding, workspace, calls } = await fixture()
  const selector = { sessionId: 'second-live', name: 'reviewed-recipe', instanceId: 'exact-instance', path: join(workspace, '.dsh', 'skills', 'reviewed-recipe') }
  const result = await onboarding.preflight(selector)
  assert.equal(result.ready, true)
  assert.equal(result.session.id, 'second-live')
  assert.equal(result.model.tested, false)
  assert.equal(result.checks.filter(item => item.required).every(item => item.status === 'pass'), true)
  assert.equal(check(result, 'skill-review').status, 'pass')
  assert.equal(check(result, 'skill-compatibility').status, 'pass')
  assert.deepEqual(calls.selection[0], [selector, workspace, { sessionId: 'second-live', freshAudit: true }])
  assert.equal(Object.hasOwn(result, 'taskVerified'), false)
})

test('stale review evidence and unknown compatibility prevent ready and retain explicit repair actions', async () => {
  const { onboarding } = await fixture({ selected: { audit: { status: 'changed', reason: 'Files changed after review' }, compatibility: { status: 'unknown', summary: 'No verified execution contract' } } })
  const result = await onboarding.preflight({ sessionId: 'first-live', name: 'changed-skill', instanceId: 'changed-instance' })
  assert.equal(result.ready, false)
  assert.equal(check(result, 'skill-review').action.type, 'review-skill')
  assert.equal(check(result, 'skill-compatibility').status, 'unknown')
  assert.equal(check(result, 'skill-compatibility').action.type, 'check-compatibility')
})

test('uninstalled named and remote candidates inspect compatibility without phantom installed-skill review actions', async () => {
  for (const candidate of [{ name: 'catalog-candidate' }, { id: 'owner/repository/remote-candidate', name: 'remote-candidate' }, { remoteId: 'owner/repository/remote-candidate' }]) {
    const { onboarding, workspace, calls } = await fixture()
    const input = { ...candidate, sessionId: 'first-live' }
    const result = await onboarding.preflight(input)
    assert.equal(result.ready, false)
    assert.deepEqual(calls.compatibility, [[input, workspace, { sessionId: 'first-live' }]])
    assert.equal(calls.selection.length, 0, 'A marketplace candidate is not an installed instance')
    assert.equal(result.checks.some(item => item.action?.type === 'review-skill'), false)
    assert.equal(check(result, 'skill-compatibility').status, 'unknown')
    assert.equal(check(result, 'skill-compatibility').action.type, 'check-compatibility')
  }
})

test('candidate compatibility inspection errors remain unknown and do not point to missing installed details', async () => {
  const { onboarding, calls } = await fixture({ compatibilityError: 'Full directory unavailable' })
  const result = await onboarding.preflight({ id: 'owner/repository/candidate', sessionId: 'first-live' })
  assert.equal(result.ready, false)
  assert.equal(calls.selection.length, 0)
  assert.equal(calls.compatibility.length, 1)
  assert.equal(check(result, 'skill-compatibility').status, 'unknown')
  assert.match(check(result, 'skill-compatibility').message, /Full directory unavailable/)
  assert.equal(result.checks.some(item => item.action?.type === 'review-skill'), false)
})
