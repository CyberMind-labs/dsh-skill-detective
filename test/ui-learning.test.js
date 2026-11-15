import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { __test as host } from '../index.js'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function createClient(fetchImpl) {
  let hooks = null
  let client
  const timers = []
  const intervals = []
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) {
      const owner = hooks
      const index = owner.cursor++
      if (!owner.cells[index]) owner.cells[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [owner.cells[index].value, next => {
        owner.cells[index].value = typeof next === 'function' ? next(owner.cells[index].value) : next
      }]
    },
    useRef(initial) {
      const index = hooks.cursor++
      if (!hooks.cells[index]) hooks.cells[index] = { current: initial }
      return hooks.cells[index]
    },
    useMemo(fn, dependencies) {
      const owner = hooks
      const index = owner.cursor++
      const before = owner.cells[index]
      if (!before || !dependencies || dependencies.some((value, i) => value !== before.dependencies?.[i])) {
        owner.cells[index] = { dependencies, value: fn() }
      }
      return owner.cells[index].value
    },
    useCallback(fn, dependencies) { return React.useMemo(() => fn, dependencies) },
    useEffect(fn, dependencies) {
      const owner = hooks
      const index = owner.cursor++
      const before = owner.cells[index]
      if (!before || dependencies?.some((value, i) => value !== before.dependencies?.[i])) {
        before?.cleanup?.()
        owner.cells[index] = { dependencies }
        owner.effects.push(() => { owner.cells[index].cleanup = fn() })
      }
    },
  }
  const sandbox = {
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length },
    clearTimeout: () => {},
    setInterval: fn => { intervals.push(fn); return intervals.length },
    clearInterval: () => {},
    document: { body: { dataset: {} } },
    window: {
      addEventListener() {}, removeEventListener() {},
      __ModuleLoader__: { load(definition) { client = definition.factory(name => {
        assert.equal(name, 'react')
        return React
      }).__test } },
    },
  }
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' })
  return {
    client, timers, intervals,
    mount(Component, props) {
      const owner = { cursor: 0, cells: [], effects: [] }
      return {
        render() {
          hooks = owner
          owner.cursor = 0
          const element = Component(props)
          hooks = null
          for (const effect of owner.effects.splice(0)) effect()
          return element
        },
      }
    },
  }
}

function elements(element) {
  if (!element || typeof element !== 'object') return []
  return [element, ...(element.props?.children ?? []).flatMap(elements)]
}
function button(element, label) {
  const found = elements(element).find(node => node.type === 'button' && node.props.children.includes(label))
  assert.ok(found, `Missing button: ${label}`)
  return found
}
const response = payload => ({ ok: true, status: 200, json: async () => payload })
const t = key => key
const plain = value => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
const skill = (instanceId, workspace = '/work/a') => ({
  name: 'same-skill', instanceId, path: `${workspace}/.dsh/skills/same-skill`, scope: 'workspace', workspace, workspaces: [workspace], managed: true, origin: 'user', enabled: true,
  compatibility: { status: 'supported', basis: 'full-directory', summary: 'Controlled file recipe' },
})
const settings = installed => ({
  installed, workspace: '/work/a', settings: { defaultScope: 'workspace' }, suppressed: [],
  workspaces: [{ path: '/work/a', title: 'Workspace A' }, { path: '/work/b', title: 'Workspace B' }],
})

test('settings saves workspace-only changes and targets the exact duplicate instance', async () => {
  const calls = []
  const app = createClient(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response({ ok: true }) })
  const component = app.mount(app.client.SettingsModal, {
    data: settings([skill('instance-a'), skill('instance-b', '/work/b')]), t, onClose() {}, onSaved() {},
  })
  let view = component.render()
  button(view, 'Workspace B').props.onClick()
  view = component.render()
  await button(view, 'save').props.onClick()
  const changes = calls.filter(call => call.url.endsWith('/scope'))
  assert.equal(changes.length, 1)
  assert.equal(changes[0].body.instanceId, 'instance-a')
  assert.equal(changes[0].body.path, '/work/a/.dsh/skills/same-skill')
  assert.deepEqual(changes[0].body.workspaces, ['/work/a', '/work/b'])
})

test('temporary settings require and transmit an explicit current session', async () => {
  const calls = []
  const app = createClient(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response({ ok: true }) })
  const component = app.mount(app.client.SettingsModal, {
    data: settings([skill('instance-a')]), sessionId: 'live-session', t, onClose() {}, onSaved() {},
  })
  elements(component.render()).find(node => node.type === 'select').props.onChange({ target: { value: 'temp' } })
  await button(component.render(), 'save').props.onClick()
  assert.equal(calls.find(call => call.url.endsWith('/scope')).body.sessionId, 'live-session')
})

test('global settings disable temporary scope and reject forced invalid saves before requests', async () => {
  const calls = []
  const app = createClient(async (...args) => { calls.push(args); return response({ ok: true }) })
  const component = app.mount(app.client.SettingsModal, { data: settings([skill('instance-a')]), t, onClose() {}, onSaved() {} })
  let view = component.render()
  assert.equal(elements(view).find(node => node.type === 'option' && node.props.value === 'temp').props.disabled, true)
  assert.ok(elements(view).some(node => node.props.children.includes('tempSessionRequired')))
  elements(view).find(node => node.type === 'select').props.onChange({ target: { value: 'temp' } })
  await button(component.render(), 'save').props.onClick()
  assert.equal(calls.length, 0)
})

test('workspace changes respect Windows case equivalence and POSIX case sensitivity', () => {
  const { client } = createClient(async () => response({ ok: true }))
  assert.equal(client.sameWorkspaces(['C:\\Work\\A'], ['c:/work/a/']), true)
  assert.equal(client.sameWorkspaces(['/work/A'], ['/work/a']), false)
})

test('API preserves business error details and can return conflicts for user review', async () => {
  const payload = { ok: false, code: 'name-conflict', message: 'Existing skill', conflict: { instanceId: 'one' } }
  const { client } = createClient(async () => response(payload))
  assert.deepEqual(plain(await client.api('/install', { body: {}, allowFailure: true })), payload)
  await assert.rejects(client.api('/install', { body: {} }), error => error.code === 'name-conflict' && error.payload.conflict.instanceId === 'one')
  assert.equal(client.installFailure({ code: 'none-found' }, t).kind, 'none')
  assert.equal(client.installFailure({ code: 'poison' }, t).kind, 'failed')
  assert.equal(client.installFailure({ code: 'session-unavailable' }, t).message, 'sessionUnavailable')
})

test('committed mutation warnings remain visible without turning success into failure', async () => {
  let route
  const app = createClient(async url => {
    route = url.split('/').pop()
    return response({ ok: true, name: 'fixture', warnings: [`${route}: cleanup requires attention`] })
  })
  const notices = app.mount(app.client.ApiWarnings, { t })
  assert.equal(notices.render(), null)
  for (const endpoint of ['/install', '/remote/install', '/toggle', '/delete', '/scope', '/learn']) {
    const result = await app.client.api(endpoint, { body: {} })
    assert.equal(result.ok, true)
    assert.ok(elements(notices.render()).some(node => node.type === 'li' && node.props.children.includes(`${route}: cleanup requires attention`)))
  }
  assert.ok(elements(notices.render()).some(node => node.props.role === 'status'))
  assert.equal(app.timers.length, 0, 'Warnings remain visible until explicitly dismissed')
  button(notices.render(), 'close').props.onClick()
  assert.equal(notices.render(), null)
})

test('recommendation progress stays pending until the server responds and shows actual failure', async () => {
  let finish
  const requests = []
  const app = createClient(async (url, options) => {
    if (url.endsWith('/pending/latest')) return response({ ok: true, sessionId: 'live-session', pending: { kind: 'recommend', need: 'open', label: 'task', searchText: 'query' } })
    if (url.endsWith('/install')) {
      requests.push(JSON.parse(options.body))
      return new Promise(resolve => { finish = resolve })
    }
    return response({ ok: true })
  })
  const component = app.mount(app.client.DetectiveDock, { t })
  component.render()
  await flush()
  const installation = button(component.render(), 'find').props.onClick()
  const pending = elements(component.render()).filter(node => String(node.props.className ?? '').startsWith('sd-step '))
  assert.equal(pending.length, 1)
  assert.equal(pending[0].props.className, 'sd-step run')
  assert.equal(app.timers.length, 0, 'No timer may manufacture completed installation steps')
  finish(response({ ok: false, code: 'audit-unavailable', message: 'Review service offline' }))
  await installation
  const failure = elements(component.render()).find(node => node.props.role === 'alert')
  assert.ok(failure)
  assert.ok(failure.props.children.some(value => String(value).includes('Review service offline')))
  assert.equal(app.timers.length, 0, 'Failure details are displayed without a timed replay')
  const retry = button(component.render(), 'retry').props.onClick()
  assert.equal(requests[1].text, 'query', 'Retry preserves the original open-ended request')
  finish(response({ ok: false, code: 'audit-unavailable' }))
  await retry
})

test('detail and manager actions transmit exact instance identity and the validated session', async () => {
  const calls = []
  const installed = [skill('instance-a'), skill('instance-b', '/work/b')]
  const app = createClient(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null })
    if (url.includes('/state')) return response({ ok: true, ...settings(installed), sessionId: 'live-session', sessionAvailable: true })
    return response({ ok: true, skill: installed[1], preview: '', tree: [] })
  })
  const manager = app.mount(app.client.ManagerPanel, { t, sessionId: 'live-session' })
  manager.render()
  await flush()
  const row = elements(manager.render()).find(node => typeof node.type === 'function' && node.type.name === 'Row' && node.props.skill.instanceId === 'instance-b')
  assert.ok(row)
  await row.props.onToggle(installed[1])
  const toggle = calls.find(call => call.url.endsWith('/toggle'))
  assert.equal(toggle.body.instanceId, 'instance-b')
  assert.equal(toggle.body.path, installed[1].path)
  assert.equal(toggle.body.sessionId, 'live-session')
  const detail = app.mount(app.client.DetailModal, { skill: installed[1], workspace: '/work/b', sessionId: 'live-session', t, onClose() {} })
  detail.render()
  await flush()
  const detailQuery = new URL(calls.find(call => call.url.includes('/detail?')).url, 'http://test.local').searchParams
  assert.equal(detailQuery.get('instanceId'), 'instance-b')
  assert.equal(detailQuery.get('path'), installed[1].path)
  assert.equal(detailQuery.get('sessionId'), 'live-session')
})

test('global manager explicitly selects a named review session and passes it to settings and install', async () => {
  const calls = []
  const app = createClient(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null })
    if (url.includes('/state')) {
      const id = new URL(url, 'http://test.local').searchParams.get('sessionId') || ''
      return response({ ok: true, ...settings([skill('one')]), sessionId: id, sessionAvailable: id === 'session-two', sessions: [{ id: 'session-one', title: 'First conversation' }, { id: 'session-two', title: 'Selected conversation' }] })
    }
    if (url.includes('/market?')) return response({ ok: true, skills: [{ name: 'fixture', description: 'Fixture skill', compatibility: { status: 'supported' } }] })
    return response({ ok: true, name: 'fixture' })
  })
  const manager = app.mount(app.client.ManagerPanel, { t })
  manager.render()
  await flush()
  let view = manager.render()
  const picker = elements(view).find(node => node.type === 'select' && node.props['aria-label'] === 'reviewSession')
  assert.equal(picker.props.value, '', 'Never silently choose a recent or first session')
  assert.ok(elements(picker).some(node => node.type === 'option' && node.props.children.includes('Selected conversation')))
  picker.props.onChange({ target: { value: 'session-two' } })
  manager.render()
  await flush()
  view = manager.render()
  assert.ok(calls.some(call => call.url.endsWith('/state?sessionId=session-two')))
  button(view, 'settings').props.onClick()
  const settingsModal = elements(manager.render()).find(node => node.type === app.client.SettingsModal)
  assert.equal(settingsModal.props.sessionId, 'session-two')
  settingsModal.props.onClose()
  button(manager.render(), 'market').props.onClick()
  const marketProps = elements(manager.render()).find(node => node.type === app.client.MarketView).props
  assert.equal(marketProps.sessionId, 'session-two')
  const market = app.mount(app.client.MarketView, { ...marketProps, pushToast() {} })
  market.render()
  await flush()
  const action = elements(market.render()).find(node => node.type === app.client.CompatibilityAction)
  const compatibilityAction = app.mount(app.client.CompatibilityAction, action.props)
  await button(compatibilityAction.render(), 'install').props.onClick()
  assert.equal(calls.find(call => call.url.endsWith('/install')).body.sessionId, 'session-two')
})

test('global manager without a usable session explains how to enable one', async () => {
  const app = createClient(async () => response({ ok: true, ...settings([]), sessions: [], sessionAvailable: false, sessionId: '' }))
  const manager = app.mount(app.client.ManagerPanel, { t })
  manager.render()
  await flush()
  const view = manager.render()
  const picker = elements(view).find(node => node.type === 'select' && node.props['aria-label'] === 'reviewSession')
  assert.equal(picker.props.value, '')
  assert.equal(elements(picker).filter(node => node.type === 'option').length, 1)
  assert.ok(elements(view).some(node => node.props.children.includes('reviewSessionHint')))
})

test('a late state response cannot replace the explicitly selected review session', async () => {
  const pending = new Map()
  const sessions = [{ id: 'session-one', title: 'First conversation' }, { id: 'session-two', title: 'Second conversation' }]
  const state = id => response({ ok: true, ...settings([skill('one')]), sessions, sessionId: id, sessionAvailable: Boolean(id) })
  const app = createClient(async url => {
    const id = new URL(url, 'http://test.local').searchParams.get('sessionId') || ''
    return id ? new Promise(resolve => pending.set(id, resolve)) : state('')
  })
  const manager = app.mount(app.client.ManagerPanel, { t })
  manager.render()
  await flush()
  const picker = view => elements(view).find(node => node.type === 'select' && node.props['aria-label'] === 'reviewSession')
  picker(manager.render()).props.onChange({ target: { value: 'session-one' } })
  manager.render()
  picker(manager.render()).props.onChange({ target: { value: 'session-two' } })
  manager.render()
  pending.get('session-two')(state('session-two'))
  await flush()
  pending.get('session-one')(state('session-one'))
  await flush()
  button(manager.render(), 'settings').props.onClick()
  const settingsModal = elements(manager.render()).find(node => node.type === app.client.SettingsModal)
  assert.equal(settingsModal.props.sessionId, 'session-two')
})

test('complete markdown sources survive structural merge including long fenced code and later sections', () => {
  const longCode = `\`\`\`python\n${'print("complete")\n'.repeat(120)}## heading inside code\n\`\`\``
  const sourceText = `---\nname: source\n---\n# Source\n\n## 流程\nFirst paragraph.\n\n${longCode}\n\n## 依赖\nKeep this final dependency.\n\n## 验收\n${'完整验收条件。'.repeat(100)}`
  const peerText = '# Peer\n\n## 使用\nPeer instructions.\n\n## 风险\nDo not drop this final warning.'
  const merged = host.buildMergedSkill({ name: 'source', version: '1.0.0', author: 'local-author' }, sourceText, null, [{ entry: { name: 'peer', author: 'peer-author' }, text: peerText }])
  assert.ok(merged.markdown.includes(sourceText.split('---\n')[2]))
  assert.ok(merged.markdown.includes(longCode))
  assert.ok(merged.markdown.includes(peerText))
  assert.deepEqual(merged.authors, ['local-author', 'peer-author'])
  assert.ok(merged.markdown.includes('未自动验证能力提升'))
})

test('learning with companion assets displays preservation details and never adopts an incomplete skill', async () => {
  const requests = []
  const source = skill('instance-a')
  const message = 'Keep the complete source directory; this document merge is preview-only.'
  const app = createClient(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return response({
      ok: true, previewOnly: true, code: 'unsupported-learning-assets', message,
      preserveSources: [{ name: source.name, instanceId: source.instanceId, path: source.path, files: [{ path: 'scripts', type: 'dir' }, { path: 'template.bin', type: 'file' }], reason: 'Keep resource references intact.' }],
    })
  })
  const learning = app.mount(app.client.LearnView, {
    t, workspace: '/work/a', sessionId: 'live-session', installed: [source], onBack() {}, onInstalled() {}, pushToast() {},
  })
  const pick = elements(learning.render()).find(node => node.type === 'button' && String(node.props.className).startsWith('sd-pick'))
  await pick.props.onClick()
  const preview = learning.render()
  assert.ok(elements(preview).some(node => node.props.role === 'alert' && elements(node).some(child => child.props.children.includes(message))))
  assert.ok(elements(preview).some(node => node.props.children.includes(source.path)))
  assert.ok(elements(preview).some(node => node.type === 'li' && node.props.children.includes('scripts/')))
  assert.ok(elements(preview).some(node => node.type === 'li' && node.props.children.includes('template.bin')))
  const adopt = button(preview, 'generateMerged')
  assert.equal(adopt.props.disabled, true)
  await adopt.props.onClick()
  assert.equal(requests.length, 1, 'Even a forced handler invocation must not install a preview-only merge')
  assert.equal(requests[0].body.dryRun, true)
})

test('section parsing keeps fenced headings inside the original section', () => {
  const sections = host.sectionsOf('# Title\n## 流程\n```md\n## not a section\n```\n\n## 验收\nCheck.')
  assert.deepEqual(sections.map(section => section.title), ['流程', '验收'])
  assert.ok(sections[0].content.includes('## not a section'))
})

test('document checks report observed structure from supplied content without a total score', () => {
  const entry = { name: 'fixture', description: 'Example', body: '# fixture\n\n## 流程\n1. One\n2. Two\n3. Three\n\n## 验收\nCheck.', perm: 'files', installs: 0 }
  assert.deepEqual(host.evaluateSkill(entry), host.evaluateSkill({ ...entry, installs: 1_000_000 }))
  const actual = host.evaluateSkill(entry, '# Installed version\n\nPlain instructions only.', 'installed-file')
  assert.equal('score' in actual, false)
  assert.equal(actual.basis, 'installed-file')
  assert.equal(actual.effectValidation, 'unverified')
  assert.equal(actual.checks.find(check => check.id === 'acceptance').status, 'missing')
  const fenced = host.evaluateSkill(entry, '```md\n1. Sample code line\n## 验收\n```\n', 'installed-file')
  assert.equal(fenced.checks.find(check => check.id === 'numbered-steps').count, 0)
  assert.equal(fenced.checks.find(check => check.id === 'acceptance').status, 'missing')
  const { client } = createClient(async () => response({ ok: true }))
  const view = client.DocumentChecks({ checks: actual.checks, contentSource: actual.basis, t })
  assert.ok(elements(view).some(node => node.props.children.includes('effectUnverified')))
  assert.equal(client.zh.matchScore, undefined)
})

test('learning checks installed peer file content and never substitutes a template for unreadable installed content', async () => {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS ?? join(project, '../test-artifacts/fix-2026-11-15'))
  await mkdir(artifacts, { recursive: true })
  for (const unreadable of [false, true]) {
    const root = await mkdtemp(join(artifacts, 'document-checks-'))
    const source = { ...skill('source', root), name: 'word-docx', path: join(root, 'word-docx'), version: '1.0.0' }
    const peer = { ...skill('peer', root), name: 'markdown-writer', path: join(root, 'markdown-writer'), version: '1.0.0' }
    await mkdir(source.path)
    await mkdir(peer.path)
    await writeFile(join(source.path, 'SKILL.md'), '# Installed Word source\n\nActual source instructions.')
    const localText = '# Local Markdown peer\n\nLocal text without catalog acceptance steps.'
    if (!unreadable) await writeFile(join(peer.path, 'SKILL.md'), localText)
    const detective = Object.create(host.SkillDetective.prototype)
    detective.selectInstalled = async () => source
    detective.listInstalled = async () => [source, peer]
    detective.reviewFiles = async () => ({ ok: true, poison: false, findings: [] })
    const preview = await detective.learn({ instanceId: source.instanceId }, root, { dryRun: true, sessionId: 'live' })
    const checked = preview.peers.find(item => item.name === 'markdown-writer')
    assert.equal('score' in checked, false)
    if (unreadable) {
      assert.equal(preview.previewOnly, true)
      assert.equal(checked.contentSource, 'unavailable')
      assert.ok(checked.documentChecks.every(check => check.status === 'unavailable'))
      assert.ok(preview.preserveSources.some(item => item.instanceId === peer.instanceId && item.reason.includes('SKILL.md')))
    } else {
      assert.equal(checked.contentSource, 'installed-file')
      assert.equal(checked.documentChecks.find(check => check.id === 'acceptance').status, 'missing')
      assert.ok(preview.merged.markdown.includes(localText))
    }
  }
})

test('audit labels require explicit evidence and expose scope, time, fingerprint and unverified effects', () => {
  const { client } = createClient(async () => response({ ok: true }))
  const legacy = { ...skill('one'), origin: 'market', auditVerdict: 'allow' }
  assert.equal(client.auditView(legacy, t).status, 'unreviewed')
  const row = client.Row({ skill: legacy, t })
  assert.ok(elements(row).some(node => node.props['data-audit-status'] === 'unreviewed' && node.props.children.includes('auditUnreviewed')))
  for (const status of ['unreviewed', 'current', 'changed', 'unverifiable', 'expired', 'rejected']) {
    const selected = { ...legacy, audit: { status, scope: 'full-directory', reviewedAt: 1_800_000_000_000, fingerprint: 'abc123def4567890', currentFingerprint: status === 'changed' ? 'changed000111' : 'abc123def4567890' } }
    assert.equal(client.auditView(selected, t).status, status)
    const evidence = client.AuditEvidence({ skill: selected, t })
    assert.ok(elements(evidence).some(node => node.props.children.includes('auditFullDirectory')))
    assert.ok(elements(evidence).some(node => node.props.children.includes('abc123def456')))
    assert.ok(elements(evidence).some(node => node.props.children.includes('auditEvidenceHint')))
  }
})

test('review again uses the selected session and exact instance, refreshes, and shows failures', async () => {
  const calls = []
  let fail = false
  let reviewed = 0
  let status = 'unreviewed'
  const selected = skill('target')
  const app = createClient(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null })
    if (url.endsWith('/review')) {
      status = fail ? 'unverifiable' : 'current'
      return response(fail ? { ok: false, code: 'audit-unavailable', message: 'Review unavailable' } : { ok: true })
    }
    return response({ ok: true, skill: { ...selected, audit: { status } }, preview: '', tree: [] })
  })
  const detail = app.mount(app.client.DetailModal, { skill: selected, workspace: '/work/a', sessionId: 'selected-session', t, onClose() {}, onReviewed() { reviewed += 1 } })
  detail.render()
  await flush()
  await button(detail.render(), 'reviewAgain').props.onClick()
  detail.render()
  await flush()
  assert.deepEqual(calls.find(call => call.url.endsWith('/review')).body, { name: selected.name, instanceId: selected.instanceId, path: selected.path, workspace: '/work/a', sessionId: 'selected-session' })
  assert.equal(reviewed, 1)
  assert.equal(elements(detail.render()).find(node => node.type === app.client.AuditEvidence).props.skill.audit.status, 'current')
  fail = true
  await button(detail.render(), 'reviewAgain').props.onClick()
  detail.render()
  await flush()
  assert.ok(elements(detail.render()).some(node => node.props.children.includes('Review unavailable')))
  assert.equal(elements(detail.render()).find(node => node.type === app.client.AuditEvidence).props.skill.audit.status, 'unverifiable')
  const withoutSession = app.mount(app.client.DetailModal, { skill: selected, workspace: '/work/a', t, onClose() {} })
  const reviewButton = button(withoutSession.render(), 'reviewAgain')
  assert.equal(reviewButton.props.disabled, true)
  const before = calls.filter(call => call.url.endsWith('/review')).length
  await reviewButton.props.onClick()
  assert.equal(calls.filter(call => call.url.endsWith('/review')).length, before)
})

test('session protection defaults to read-only and writes require an explicit user selection', async () => {
  const calls = []
  let refreshed = 0
  const app = createClient(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response({ ok: true }) })
  const controls = app.mount(app.client.ProtectionControls, {
    sessionId: 'chosen-session', protection: { available: true, enabled: false, workspace: '/work/a' }, t, onChanged() { refreshed += 1 },
  })
  let view = controls.render()
  assert.equal(elements(view).find(node => node.type === 'select').props.value, 'read-only')
  assert.equal(calls.length, 0, 'Mounting or reading state must not change protection')
  assert.ok(elements(view).some(node => node.props.children.includes('protectionOff')))
  assert.ok(elements(view).some(node => node.props.children.includes('protectionLimits')))
  await button(view, 'protectionEnable').props.onClick()
  assert.deepEqual(calls[0], { url: '/api/dsh-skill-detective/protection', body: { sessionId: 'chosen-session', enabled: true, mode: 'read-only' } })
  view = controls.render()
  elements(view).find(node => node.type === 'select').props.onChange({ target: { value: 'workspace-write' } })
  await button(controls.render(), 'protectionEnable').props.onClick()
  assert.deepEqual(calls[1].body, { sessionId: 'chosen-session', enabled: true, mode: 'workspace-write' })
  assert.equal(refreshed, 2)
})

test('disabling protection targets only the selected session and never happens automatically', async () => {
  const calls = []
  const app = createClient(async (_url, options) => { calls.push(JSON.parse(options.body)); return response({ ok: true }) })
  const controls = app.mount(app.client.ProtectionControls, { sessionId: 'chosen-session', protection: { available: true, enabled: true, mode: 'workspace-write' }, t })
  const view = controls.render()
  assert.equal(calls.length, 0)
  assert.ok(elements(view).some(node => node.props.children.some(child => String(child).includes('protectionOn'))))
  await button(view, 'protectionDisable').props.onClick()
  assert.deepEqual(calls, [{ sessionId: 'chosen-session', enabled: false, mode: 'read-only' }])
})

test('unavailable session protection is explicit and cannot be submitted through disabled controls', async () => {
  const calls = []
  const app = createClient(async (...args) => { calls.push(args); return response({ ok: true }) })
  const controls = app.mount(app.client.ProtectionControls, { sessionId: 'chosen-session', protection: { available: false, enabled: false, reason: 'Tool guard unavailable' }, t })
  const view = controls.render()
  assert.ok(elements(view).some(node => node.props.children.includes('protectionUnavailable')))
  assert.ok(elements(view).some(node => node.props.children.includes('Tool guard unavailable')))
  assert.equal(button(view, 'protectionEnable').props.disabled, true)
  await button(view, 'protectionEnable').props.onClick()
  assert.equal(calls.length, 0)
  assert.ok(elements(controls.render()).some(node => node.props.role === 'alert' && node.props.children.includes('Tool guard unavailable')))
})

test('an enabled policy with an unavailable guard can be explicitly disabled but never enabled or elevated', async () => {
  const calls = []
  const app = createClient(async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return response({ ok: true }) })
  const controls = app.mount(app.client.ProtectionControls, {
    sessionId: 'selected-session', protection: { available: false, enabled: true, mode: 'read-only', reason: 'Host guard unavailable' }, t,
  })
  let view = controls.render()
  assert.equal(button(view, 'protectionUpdate').props.disabled, true)
  assert.equal(elements(view).find(node => node.type === 'select').props.disabled, true)
  await button(view, 'protectionUpdate').props.onClick()
  assert.equal(calls.length, 0, 'An unavailable host cannot enable or upgrade execution permissions')
  view = controls.render()
  assert.equal(button(view, 'protectionDisable').props.disabled, false)
  await button(view, 'protectionDisable').props.onClick()
  assert.deepEqual(calls, [{ url: '/api/dsh-skill-detective/protection', body: { sessionId: 'selected-session', enabled: false, mode: 'read-only' } }])
})

test('protection request failures stay visible and never report an enabled session', async () => {
  const app = createClient(async () => response({ ok: false, code: 'protection-unavailable', message: 'Guard was disposed' }))
  const controls = app.mount(app.client.ProtectionControls, { sessionId: 'chosen-session', protection: { available: true, enabled: false }, t })
  await button(controls.render(), 'protectionEnable').props.onClick()
  const view = controls.render()
  assert.ok(elements(view).some(node => node.props.children.includes('protectionOff')))
  assert.ok(elements(view).some(node => node.props.role === 'alert' && node.props.children.includes('Guard was disposed')))
})

test('enabling a skill without protection directs the user to protection settings without changing them', async () => {
  const calls = []
  const selected = { ...skill('chosen'), enabled: false }
  const app = createClient(async (url, options) => {
    calls.push(url)
    if (url.includes('/state')) return response({ ok: true, ...settings([selected]), sessionId: 'chosen-session', sessionAvailable: true, protection: { available: true, enabled: false } })
    return response({ ok: false, code: 'protection-required', message: 'Protection disabled' })
  })
  const manager = app.mount(app.client.ManagerPanel, { t, sessionId: 'chosen-session' })
  manager.render()
  await flush()
  const row = elements(manager.render()).find(node => node.type === app.client.Row)
  await row.props.onToggle(selected)
  assert.ok(elements(manager.render()).some(node => node.props.className === 'sd-toast' && node.props.children.includes('protectionRequired')))
  assert.equal(calls.filter(url => url.endsWith('/protection')).length, 0)
})


test('recommendation dock accepts a second session recommendation after a completed install fades', async () => {
  let pending = { sessionId: 'session-one', pending: { kind: 'recommend', need: 'catalog:first', label: 'first' } }
  const installs = []
  const app = createClient(async (url, options) => {
    if (url.endsWith('/pending/latest')) return response({ ok: true, ...pending })
    if (url.endsWith('/install')) installs.push(JSON.parse(options.body))
    if (url.endsWith('/dismiss')) pending = { pending: null }
    return response({ ok: true, name: 'installed' })
  })
  const dock = app.mount(app.client.DetectiveDock, { t })
  dock.render()
  await flush()
  await button(dock.render(), 'find').props.onClick()
  dock.render()
  app.timers[0].fn()
  app.timers[1].fn()
  assert.equal(dock.render(), null)
  pending = { sessionId: 'session-two', pending: { kind: 'recommend', need: 'catalog:second', label: 'second' } }
  await app.intervals[0]()
  assert.equal(dock.render().props.className, 'sd-dock', 'A new recommendation must not inherit the completed bubble fade')
  await button(dock.render(), 'find').props.onClick()
  assert.deepEqual(installs.map(item => [item.need, item.sessionId]), [['catalog:first', 'session-one'], ['catalog:second', 'session-two']])
})

test('moving a temporary skill to either persistent scope keeps its source session for lookup', () => {
  const { client } = createClient(async () => response({ ok: true }))
  const temporary = { ...skill('temp-instance'), scope: 'temp', sessionId: 'live-session' }
  for (const scope of ['global', 'workspace']) {
    const changes = client.scopeChanges([temporary], { 'temp-instance': { scope, workspaces: ['/work/a'] } }, '/work/a', 'live-session', t)
    assert.equal(changes[0].sessionId, 'live-session')
    assert.equal(changes[0].instanceId, 'temp-instance')
  }
})

test('a partially committed scope save retries only the remaining move', async () => {
  const requests = []
  let failSecond = true
  let refreshed = 0
  const first = skill('first')
  const second = { ...skill('second'), name: 'other', path: '/work/a/.dsh/skills/other' }
  const app = createClient(async (url, options) => {
    const body = JSON.parse(options.body)
    if (url.endsWith('/scope')) {
      requests.push(body.instanceId)
      if (body.instanceId === 'second' && failSecond) return response({ ok: false, code: 'name-conflict', message: 'Target exists' })
    }
    return response({ ok: true })
  })
  const modal = app.mount(app.client.SettingsModal, { data: settings([first, second]), t, onClose() {}, onSaved() { refreshed += 1 } })
  modal.render()
  for (const select of elements(modal.render()).filter(node => node.type === 'select')) select.props.onChange({ target: { value: 'global' } })
  await button(modal.render(), 'save').props.onClick()
  assert.equal(refreshed, 1, 'Refresh committed server state after the partial failure')
  failSecond = false
  await button(modal.render(), 'save').props.onClick()
  assert.deepEqual(requests, ['first', 'second', 'second'])
})


test('scope rows rebase committed identities after refresh and preserve the failed edit', async () => {
  const requests = []
  let failSecond = true
  const first = skill('first')
  const second = { ...skill('second'), name: 'other', path: '/work/a/.dsh/skills/other' }
  const props = { data: settings([first, second]), t, onClose() {}, onSaved() {} }
  const app = createClient(async (url, options) => {
    const body = JSON.parse(options.body)
    if (url.endsWith('/scope')) {
      requests.push(body.instanceId)
      if (body.instanceId === 'second' && failSecond) return response({ ok: false, code: 'name-conflict', message: 'Target exists' })
    }
    return response({ ok: true })
  })
  const modal = app.mount(app.client.SettingsModal, props)
  modal.render()
  for (const select of elements(modal.render()).filter(node => node.type === 'select')) select.props.onChange({ target: { value: 'global' } })
  await button(modal.render(), 'save').props.onClick()
  props.data = settings([{ ...first, instanceId: 'global-first', path: '/global/first', scope: 'global' }, second])
  modal.render()
  const selects = elements(modal.render()).filter(node => node.type === 'select')
  assert.deepEqual(selects.map(node => node.props.value), ['global', 'global'])
  failSecond = false
  await button(modal.render(), 'save').props.onClick()
  assert.deepEqual(requests, ['first', 'second', 'second'])
})


test('dock conflict confirmation and failed retry retain the exact target scope and identity', async () => {
  const requests = []
  const target = { name: 'fixture', instanceId: 'workspace-fixture', path: '/work/a/.dsh/skills/fixture', scope: 'workspace' }
  const app = createClient(async (url, options) => {
    if (url.endsWith('/pending/latest')) return response({ ok: true, sessionId: 'review-session', pending: { kind: 'recommend', need: 'catalog:fixture', label: 'Fixture', searchText: 'original search' } })
    if (url.endsWith('/install')) {
      requests.push(JSON.parse(options.body))
      if (requests.length === 1) return response({ ok: false, code: 'name-conflict', conflict: target })
      if (requests.length === 2) throw new TypeError('Network request failed')
      return response({ ok: true, name: 'fixture' })
    }
    return response({ ok: true })
  })
  const dock = app.mount(app.client.DetectiveDock, { t })
  dock.render()
  await flush()
  await button(dock.render(), 'find').props.onClick()
  await button(dock.render(), 'overwriteInstall').props.onClick()
  await button(dock.render(), 'retry').props.onClick()
  const expected = { need: 'catalog:fixture', sessionId: 'review-session', text: 'original search', conflict: 'overwrite', name: target.name, instanceId: target.instanceId, path: target.path, scope: 'workspace' }
  assert.deepEqual(requests[1], expected, 'The confirmed scope overrides a later defaultScope change')
  assert.deepEqual(requests[2], expected, 'Network retry must keep the same confirmed target')
})


test('dock explicit dismissal suppresses only its displayed recommendation ID', async () => {
  const acknowledgements = []
  const app = createClient(async (url, options) => {
    if (url.endsWith('/pending/latest')) return response({ ok: true, sessionId: 'session', pending: { id: 'displayed', kind: 'recommend', need: 'catalog:fixture', label: 'Fixture' } })
    acknowledgements.push(JSON.parse(options.body))
    return response({ ok: true })
  })
  const dock = app.mount(app.client.DetectiveDock, { t })
  dock.render()
  await flush()
  await button(dock.render(), 'notNow').props.onClick()
  assert.deepEqual(acknowledgements, [{ sessionId: 'session', recommendationId: 'displayed', suppress: true }])
})

test('dock success and covered acknowledgements clear their original IDs without suppression', async () => {
  for (const kind of ['recommend', 'covered']) {
    const acknowledgements = []
    let finishInstall
    const app = createClient(async (url, options) => {
      if (url.endsWith('/pending/latest')) return response({ ok: true, sessionId: 'session', pending: { id: 'displayed', kind, need: 'catalog:fixture', label: 'Fixture', name: 'fixture' } })
      if (url.endsWith('/install')) return new Promise(resolve => { finishInstall = resolve })
      acknowledgements.push(JSON.parse(options.body))
      return response({ ok: true })
    })
    const dock = app.mount(app.client.DetectiveDock, { t })
    dock.render()
    await flush()
    if (kind === 'recommend') {
      const install = button(dock.render(), 'find').props.onClick()
      dock.render()
      finishInstall(response({ ok: true, name: 'fixture' }))
      await install
    }
    assert.deepEqual(acknowledgements, [{ sessionId: 'session', recommendationId: 'displayed', suppress: false }])
  }
})


test('compatibility labels use explicit evidence, default to unknown, and never claim verified effects', () => {
  const { client } = createClient(async () => response({ ok: true }))
  assert.equal(client.compatibilityView({ compatible: true, status: 'supported' }, t).status, 'unknown')
  assert.equal(client.compatibilityView({ compatibility: { status: 'compatible' } }, t).status, 'unknown')
  const view = client.CompatibilityInfo({ candidate: { compatibility: { status: 'blocked', summary: 'Requires shell', basis: 'full-directory', requirements: [{ capability: 'shell', status: 'blocked', reason: 'Denied', evidence: [{ path: 'SKILL.md', line: 14, excerpt: 'npm test' }] }] } }, t })
  assert.ok(elements(view).some(node => node.props['data-compatibility'] === 'blocked'))
  assert.ok(elements(view).some(node => node.props.children.includes('effectUnverified')))
  assert.ok(elements(view).some(node => node.type === 'details'))
  assert.ok(elements(view).some(node => node.props.children.includes('SKILL.md:14 npm test')))
})

test('unknown compatibility is inspected before a separate explicit restricted trial, without changing tools or protection', async () => {
  const calls = []
  const proceeded = []
  const app = createClient(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return response({ ok: true, compatibility: { status: 'unknown', basis: 'full-directory', summary: 'Unproven workflow' } })
  })
  const candidate = { ...skill('chosen'), compatibility: { status: 'unknown', basis: 'metadata-only' } }
  const controls = app.mount(app.client.CompatibilityAction, { candidate, sessionId: 'explicit-session', workspace: '/work/a', t, onProceed: (consent, effective) => proceeded.push({ consent, effective }) })
  let view = controls.render()
  assert.equal(calls.length, 0)
  assert.equal(elements(view).filter(node => node.type === 'button' && node.props.children.includes('restrictedTrial')).length, 0)
  await button(view, 'checkCompatibility').props.onClick()
  assert.deepEqual(calls, [{ url: '/api/dsh-skill-detective/compatibility', body: { ...plain(app.client.skillSelector(candidate)), workspace: '/work/a', sessionId: 'explicit-session' } }])
  assert.equal(proceeded.length, 0, 'Inspection must not install or consent')
  view = controls.render()
  await button(view, 'restrictedTrial').props.onClick()
  assert.equal(proceeded.length, 1)
  assert.equal(proceeded[0].consent, true)
  assert.equal(proceeded[0].effective.instanceId, 'chosen')
  assert.equal(calls.length, 1)
})

test('blocked compatibility and failed inspection never expose install or trial controls', async () => {
  const app = createClient(async () => response({ ok: false, message: 'Download failed' }))
  const blocked = app.mount(app.client.CompatibilityAction, { candidate: { name: 'blocked', compatibility: { status: 'blocked' } }, sessionId: 's', t, onProceed() { assert.fail('Blocked candidates must not proceed') } })
  assert.equal(elements(blocked.render()).filter(node => node.type === 'button').length, 0)
  const unknown = app.mount(app.client.CompatibilityAction, { candidate: { name: 'unknown' }, sessionId: 's', t, onProceed() { assert.fail('Failed inspection must not proceed') } })
  await button(unknown.render(), 'checkCompatibility').props.onClick()
  const view = unknown.render()
  assert.ok(elements(view).some(node => node.props.role === 'alert' && node.props.children.includes('Download failed')))
  assert.equal(elements(view).filter(node => node.type === 'button' && node.props.children.includes('restrictedTrial')).length, 0)
})

test('market retry preserves the explicitly confirmed candidate, overwrite instance and consent snapshot', async () => {
  const calls = []
  let installs = 0
  const candidate = { name: 'unknown-market', compatibility: { status: 'unknown', basis: 'metadata-only' } }
  const existing = { ...skill('overwrite-exact'), name: 'unknown-market', scope: 'global' }
  const app = createClient(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    if (url.includes('/market?')) return response({ ok: true, skills: [candidate] })
    if (url.endsWith('/compatibility')) return response({ ok: true, compatibility: { status: 'unknown', basis: 'catalog-template', summary: 'Unverified custom workflow' } })
    if (url.endsWith('/install')) {
      installs += 1
      if (installs === 1) return response({ ok: false, code: 'name-conflict', conflict: existing })
      if (installs === 2) return response({ ok: false, code: 'protection-required', message: 'Enable protection' })
      return response({ ok: true, name: candidate.name })
    }
    assert.fail(`Unexpected endpoint ${url}`)
  })
  const market = app.mount(app.client.MarketView, { workspace: '/work/a', sessionId: 'selected-session', t, pushToast() {} })
  market.render(); await flush()
  const props = elements(market.render()).find(node => node.type === app.client.CompatibilityAction).props
  const action = app.mount(app.client.CompatibilityAction, props)
  await button(action.render(), 'checkCompatibility').props.onClick()
  assert.equal(installs, 0)
  await button(action.render(), 'restrictedTrial').props.onClick()
  await button(market.render(), 'overwriteInstall').props.onClick()
  const failure = elements(market.render()).find(node => node.type === app.client.TaskFailure)
  assert.ok(failure)
  assert.equal(failure.props.failure.body.compatibilityConsent, true)
  assert.equal(failure.props.failure.body.instanceId, existing.instanceId)
  const retained = plain(failure.props.failure.body)
  await failure.props.onRetry()
  const requests = calls.filter(call => call.url.endsWith('/install'))
  assert.deepEqual(requests[2].body, retained)
  assert.equal(requests[2].body.sessionId, 'selected-session')
  assert.equal(calls.filter(call => call.url.endsWith('/protection')).length, 0)
})

test('remote search results remain unknown until full inspection and blocked results cannot install', async () => {
  const calls = []
  const app = createClient(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    if (url.includes('/market?')) return response({ ok: true, skills: [] })
    if (url.endsWith('/remote/search')) return response({ ok: true, skills: [{ id: 'owner/repo/remote-skill', name: 'remote-skill' }] })
    if (url.endsWith('/compatibility')) return response({ ok: true, compatibility: { status: 'blocked', basis: 'full-directory', summary: 'Requires network and shell' } })
    assert.fail(`Unexpected install or mode change: ${url}`)
  })
  const market = app.mount(app.client.MarketView, { workspace: '/work/a', sessionId: 'selected-session', t, pushToast() {} })
  market.render(); await flush()
  elements(market.render()).find(node => node.type === 'input').props.onChange({ target: { value: 'remote' } })
  await button(market.render(), 'remoteSearch').props.onClick()
  const action = app.mount(app.client.CompatibilityAction, elements(market.render()).find(node => node.type === app.client.CompatibilityAction).props)
  await button(action.render(), 'checkCompatibility').props.onClick()
  assert.deepEqual(calls.find(call => call.url.endsWith('/compatibility')).body, { id: 'owner/repo/remote-skill', workspace: '/work/a', sessionId: 'selected-session' })
  assert.equal(elements(action.render()).filter(node => node.type === 'button').length, 0)
})

test('preflight lists concrete next steps, keeps configured models untested, and executes no unknown actions or automatic mutations', async () => {
  const calls = []
  const app = createClient(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null })
    return response({ ok: true, ready: false, session: { id: 's', available: true }, model: { configured: true, tested: false }, checks: [
      { id: 'model', status: 'unknown', message: 'Not tested', action: { type: 'configure-model', label: 'Configure model' } },
      { id: 'mode', status: 'action', message: 'PTC unavailable', action: { type: 'choose-native-mode', label: 'Select native' } },
      { id: 'untrusted', status: 'action', message: 'Foreign action', action: { type: 'run-shell', label: 'Do not render' } },
    ] })
  })
  const panel = app.mount(app.client.PreflightPanel, { sessionId: 's', workspace: '/work/a', t })
  panel.render(); await flush()
  let view = panel.render()
  assert.ok(elements(view).some(node => node.props.children.includes('modelUntested')))
  assert.equal(elements(view).filter(node => node.type === 'button' && node.props.children.includes('Do not render')).length, 0)
  button(view, 'Configure model').props.onClick()
  assert.ok(elements(panel.render()).some(node => node.props.children.includes('configureModelHint')))
  button(panel.render(), 'Select native').props.onClick()
  assert.ok(elements(panel.render()).some(node => node.props.children.includes('chooseNativeHint')))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.includes('sessionId=s'))
  assert.equal(calls[0].body, null)
})

test('backup recovery requires a server preview and a separate explicit restore with its exact token', async () => {
  const calls = []
  let restored = false
  const app = createClient(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    if (url.includes('/preflight?')) return response({ ok: true, ready: false, recovery: { files: [{ id: 'state', label: 'Recommendation state', state: restored ? 'valid' : 'corrupt', backupAvailable: true }] } })
    if (url.endsWith('/recovery/preview')) return response({ ok: true, canRestore: true, previewToken: 'bound-token', summary: { backupPath: '/profile/state.json.bak', size: 128, modifiedAt: '2026-11-16', original: 'quarantine before replacement' } })
    if (url.endsWith('/recovery/restore')) { restored = true; return response({ ok: true }) }
    assert.fail(url)
  })
  const panel = app.mount(app.client.PreflightPanel, { sessionId: '', t })
  panel.render(); await flush()
  assert.equal(calls.filter(call => call.body).length, 0)
  await button(panel.render(), 'previewRecovery').props.onClick()
  const view = panel.render()
  const summary = elements(view).find(node => node.type === app.client.RecoverySummary)
  assert.ok(summary)
  const summaryView = app.client.RecoverySummary(summary.props)
  assert.ok(elements(summaryView).some(node => node.type === 'dd' && node.props.children.includes('/profile/state.json.bak')))
  assert.ok(elements(summaryView).some(node => node.type === 'details'), 'Technical recovery fields stay folded')
  assert.equal(calls.filter(call => call.url.endsWith('/recovery/restore')).length, 0)
  await button(view, 'restoreBackup').props.onClick()
  assert.deepEqual(calls.find(call => call.url.endsWith('/recovery/restore')).body, { target: 'state', previewToken: 'bound-token' })
  assert.ok(elements(panel.render()).some(node => node.props.children.includes('recoveryDone')))
})

test('failed or stale recovery previews cannot be retried as an unreviewed restore', async () => {
  let restores = 0
  const app = createClient(async (url) => {
    if (url.includes('/preflight?')) return response({ ok: true, ready: false, recovery: { files: [{ id: 'index', state: 'corrupt', backupAvailable: true }] } })
    if (url.endsWith('/recovery/preview')) return response({ ok: true, canRestore: true, previewToken: 'expired', summary: 'old backup' })
    if (url.endsWith('/recovery/restore')) { restores += 1; return response({ ok: false, message: 'State changed; preview again' }) }
    assert.fail(url)
  })
  const panel = app.mount(app.client.PreflightPanel, { t })
  panel.render(); await flush()
  await button(panel.render(), 'previewRecovery').props.onClick()
  await button(panel.render(), 'restoreBackup').props.onClick()
  const view = panel.render()
  assert.ok(elements(view).some(node => node.props.role === 'alert' && node.props.children.some(child => String(child).includes('State changed'))))
  assert.equal(elements(view).filter(node => node.type === 'button' && node.props.children.includes('restoreBackup')).length, 0)
  assert.equal(restores, 1)
})

test('a corrupt state page still exposes independent preflight and live session selection without guessing a session', async () => {
  const app = createClient(async () => response({ ok: false, message: 'State JSON damaged' }))
  const manager = app.mount(app.client.ManagerPanel, { t })
  manager.render(); await flush()
  let view = manager.render()
  let preflight = elements(view).find(node => node.type === app.client.PreflightPanel)
  assert.ok(preflight)
  assert.equal(preflight.props.sessionId, '')
  preflight.props.onResult({ ok: true, workspace: '/work/a', session: { id: '', available: false }, sessions: [{ id: 'live-one', title: 'Repository maintenance · live-one' }] })
  view = manager.render()
  const picker = elements(view).find(node => node.type === 'select' && node.props['aria-label'] === 'reviewSession')
  assert.equal(picker.props.value, '')
  assert.ok(elements(picker).some(node => node.props.children.includes('Repository maintenance · live-one')))
  picker.props.onChange({ target: { value: 'live-one' } })
  manager.render(); await flush()
  preflight = elements(manager.render()).find(node => node.type === app.client.PreflightPanel)
  assert.equal(preflight.props.sessionId, 'live-one')
})

test('blocked and unconfirmed installed skills cannot activate through manager callbacks without explicit consent', async () => {
  const calls = []
  const selected = { ...skill('blocked-instance'), enabled: false, compatibility: { status: 'blocked' } }
  const app = createClient(async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null })
    return response({ ok: true, ...settings([selected]), sessionId: 's', sessionAvailable: true })
  })
  const manager = app.mount(app.client.ManagerPanel, { t, sessionId: 's' })
  manager.render(); await flush()
  const row = elements(manager.render()).find(node => node.type === app.client.Row)
  await row.props.onToggle(selected)
  await row.props.onToggle({ ...selected, compatibility: { status: 'unknown' } })
  assert.equal(calls.filter(call => call.url.endsWith('/toggle')).length, 0)
  const preflight = elements(manager.render()).find(node => node.type === app.client.PreflightPanel)
  assert.equal(preflight.props.selector.instanceId, 'blocked-instance')
  await row.props.onToggle({ ...selected, compatibility: { status: 'unknown' } }, true)
  assert.deepEqual(calls.find(call => call.url.endsWith('/toggle')).body, { ...plain(app.client.skillSelector(selected)), enabled: true, workspace: '/work/a', sessionId: 's', compatibilityConsent: true })
})


test('learning unknown final drafts require a separate explicit trial and retry keeps that exact source and consent', async () => {
  const calls = []
  const selected = skill('source-exact')
  const app = createClient(async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, body })
    if (body.dryRun) return response({ ok: true, source: { name: selected.name }, peers: [], merged: { name: 'merged', markdown: '# merged', authors: [] }, compatibility: { status: 'unknown', basis: 'full-directory', summary: 'Final draft unverified' }, audit: { poison: false } })
    return response({ ok: false, code: 'audit-unavailable', message: 'Model unavailable' })
  })
  const learning = app.mount(app.client.LearnView, { workspace: '/work/a', sessionId: 'chosen-session', installed: [selected], t, pushToast() {} })
  let view = learning.render()
  await elements(view).find(node => node.type === 'button' && String(node.props.className).includes('sd-pick')).props.onClick()
  view = learning.render()
  assert.equal(button(view, 'generateMerged').props.disabled, true)
  await button(view, 'generateMerged').props.onClick()
  assert.equal(calls.length, 1)
  await button(view, 'restrictedTrial').props.onClick()
  const failure = elements(learning.render()).find(node => node.type === app.client.TaskFailure)
  assert.ok(failure)
  await failure.props.onRetry()
  const expected = { ...plain(app.client.skillSelector(selected)), workspace: '/work/a', sessionId: 'chosen-session', compatibilityConsent: true }
  assert.deepEqual(calls[1].body, expected)
  assert.deepEqual(calls[2].body, expected)
})

test('recommendation candidates are inspected before explicit trial and retries keep their chosen identity and consent', async () => {
  const calls = []
  const app = createClient(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    if (url.endsWith('/pending/latest')) return response({ ok: true, sessionId: 'original-session', pending: { id: 'recommendation', kind: 'recommend', label: 'Repository task', need: 'catalog:original', candidates: [{ name: 'original' }] } })
    if (url.endsWith('/compatibility')) return response({ ok: true, compatibility: { status: 'unknown', basis: 'catalog-template', summary: 'Unverified' } })
    if (url.endsWith('/install')) return response({ ok: false, code: 'audit-unavailable', message: 'Model unavailable' })
    assert.fail(url)
  })
  const dock = app.mount(app.client.DetectiveDock, { t })
  dock.render(); await flush()
  const candidateAction = elements(dock.render()).find(node => node.type === app.client.CompatibilityAction)
  assert.ok(candidateAction)
  const action = app.mount(app.client.CompatibilityAction, candidateAction.props)
  await button(action.render(), 'checkCompatibility').props.onClick()
  assert.equal(calls.filter(call => call.url.endsWith('/install')).length, 0)
  await button(action.render(), 'restrictedTrial').props.onClick()
  await button(dock.render(), 'retry').props.onClick()
  const requests = calls.filter(call => call.url.endsWith('/install'))
  assert.deepEqual(requests[0].body, { sessionId: 'original-session', name: 'original', compatibilityConsent: true })
  assert.deepEqual(requests[1].body, requests[0].body)
})

test('open search compatibility confirmation switches to the exact returned remote candidate rather than rerunning search', async () => {
  const calls = []
  const app = createClient(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    if (url.endsWith('/pending/latest')) return response({ ok: true, sessionId: 'original-session', pending: { kind: 'recommend', label: 'Open task', need: 'open', searchText: 'repo maintenance' } })
    if (url === '/api/dsh-skill-detective/install') return response({ ok: false, code: 'compatibility-confirmation-required', candidate: { remoteId: 'owner/repo/exact-skill', name: 'exact-skill', scope: 'workspace' }, compatibility: { status: 'unknown', basis: 'full-directory' } })
    if (url.endsWith('/compatibility')) return response({ ok: true, compatibility: { status: 'unknown', basis: 'full-directory' } })
    if (url.endsWith('/remote/install')) return response({ ok: false, code: 'audit-unavailable' })
    assert.fail(url)
  })
  const dock = app.mount(app.client.DetectiveDock, { t })
  dock.render(); await flush()
  await button(dock.render(), 'find').props.onClick()
  const candidateAction = elements(dock.render()).find(node => node.type === app.client.CompatibilityAction)
  assert.ok(candidateAction)
  const action = app.mount(app.client.CompatibilityAction, candidateAction.props)
  await button(action.render(), 'checkCompatibility').props.onClick()
  await button(action.render(), 'restrictedTrial').props.onClick()
  assert.equal(calls.filter(call => call.url === '/api/dsh-skill-detective/install').length, 1)
  assert.deepEqual(calls.find(call => call.url.endsWith('/remote/install')).body, { sessionId: 'original-session', id: 'owner/repo/exact-skill', scope: 'workspace', compatibilityConsent: true })
})


test('scope compatibility failures retain the pending exact move and require inspection and explicit trial before resuming', async () => {
  const calls = []
  let moved = 0
  const selected = skill('scope-exact')
  const app = createClient(async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push({ url, body })
    if (url.endsWith('/settings')) return response({ ok: true })
    if (url.endsWith('/compatibility')) return response({ ok: true, compatibility: { status: body.targetScope === 'global' ? 'unknown' : 'supported', basis: 'full-directory' } })
    if (url.endsWith('/scope')) {
      moved += 1
      if (moved === 1) return response({ ok: false, code: 'compatibility-confirmation-required', message: 'Needs explicit trial', compatibility: { status: 'unknown', basis: 'full-directory' } })
      return response({ ok: true })
    }
    assert.fail(url)
  })
  const modal = app.mount(app.client.SettingsModal, { data: settings([selected]), sessionId: 'chosen-session', t, onSaved() {}, onClose() {} })
  const select = elements(modal.render()).find(node => node.type === 'select')
  select.props.onChange({ target: { value: 'global' } })
  await button(modal.render(), 'save').props.onClick()
  const actionProps = elements(modal.render()).find(node => node.type === app.client.CompatibilityAction).props
  assert.equal(actionProps.candidate.instanceId, selected.instanceId)
  assert.equal(actionProps.sessionId, 'chosen-session')
  assert.equal(actionProps.inspectionContext.targetScope, 'global')
  assert.equal(moved, 1)
  const action = app.mount(app.client.CompatibilityAction, actionProps)
  await button(action.render(), 'checkCompatibility').props.onClick()
  const inspection = calls.find(call => call.url.endsWith('/compatibility')).body
  assert.equal(inspection.targetScope, 'global')
  assert.deepEqual(inspection.targetWorkspaces, calls.find(call => call.url.endsWith('/scope')).body.workspaces)
  assert.equal(moved, 1)
  await button(action.render(), 'restrictedTrial').props.onClick()
  const attempts = calls.filter(call => call.url.endsWith('/scope'))
  assert.deepEqual(attempts[1].body, { ...attempts[0].body, compatibilityConsent: true })
  assert.equal(attempts[1].body.scope, 'global')
  assert.equal(attempts[1].body.instanceId, selected.instanceId)
})

test('compatibility inspection is bound to the intended scope and destination workspaces', async () => {
  const calls = []
  const app = createClient(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return response({ ok: true, compatibility: { status: 'unknown', basis: 'full-directory' } })
  })
  const props = { candidate: { ...skill('scope-source'), compatibility: { status: 'unknown' } }, sessionId: 'chosen-session', workspace: '/work/a', t,
    inspectionContext: { targetScope: 'workspace', targetWorkspaces: ['/work/b'] }, onProceed() { assert.fail('Changing the destination must require a fresh check') } }
  const action = app.mount(app.client.CompatibilityAction, props)
  await button(action.render(), 'checkCompatibility').props.onClick()
  assert.ok(button(action.render(), 'restrictedTrial'))
  props.inspectionContext = { targetScope: 'workspace', targetWorkspaces: ['/work/c'] }
  assert.equal(elements(action.render()).filter(node => node.type === 'button' && node.props.children.includes('restrictedTrial')).length, 0)
  await button(action.render(), 'checkCompatibility').props.onClick()
  assert.deepEqual(calls.map(call => call.body.targetWorkspaces), [['/work/b'], ['/work/c']])
  assert.ok(calls.every(call => call.body.targetScope === 'workspace' && call.body.instanceId === 'scope-source'))
})

test('finding an alternative opens an explicitly searched marketplace without an implicit replacement request', async () => {
  const calls = []
  const selected = { ...skill('old-skill'), category: 'repository-maintenance', enabled: false }
  const app = createClient(async (url) => {
    calls.push(url)
    return response({ ok: true, ...settings([selected]), sessionId: 'chosen-session', sessionAvailable: true })
  })
  const manager = app.mount(app.client.ManagerPanel, { sessionId: 'chosen-session', t })
  manager.render(); await flush()
  const row = elements(manager.render()).find(node => node.type === app.client.Row)
  row.props.onReplace(selected)
  const market = elements(manager.render()).find(node => node.type === app.client.MarketView)
  assert.ok(market)
  assert.equal(market.props.initialQuery, 'repository-maintenance')
  assert.equal(calls.filter(url => url.endsWith('/replace') || url.endsWith('/install')).length, 0)
})

test('update suggestions use the same compatibility gate and preserve explicit consent when installation fails', async () => {
  const calls = []
  const candidate = { name: 'peer-candidate', compatibility: { status: 'unknown', basis: 'metadata-only' } }
  const app = createClient(async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body })
    if (url.includes('/updates?')) return response({ ok: true, updates: [{ ...skill('old'), status: 'alternative', suggestion: candidate }] })
    if (url.endsWith('/compatibility')) return response({ ok: true, compatibility: { status: 'unknown', basis: 'catalog-template' } })
    if (url.endsWith('/install')) return response({ ok: false, message: 'Review unavailable' })
    assert.fail(url)
  })
  const updates = app.mount(app.client.UpdatesModal, { sessionId: 'chosen-session', workspace: '/work/a', t, pushToast() {} })
  updates.render(); await flush()
  const props = elements(updates.render()).find(node => node.type === app.client.CompatibilityAction).props
  const action = app.mount(app.client.CompatibilityAction, props)
  await button(action.render(), 'checkCompatibility').props.onClick()
  assert.equal(calls.filter(call => call.url.endsWith('/install')).length, 0)
  await button(action.render(), 'restrictedTrial').props.onClick()
  const failure = elements(updates.render()).find(node => node.type === app.client.TaskFailure)
  assert.ok(failure)
  await failure.props.onRetry()
  const attempts = calls.filter(call => call.url.endsWith('/install'))
  assert.deepEqual(attempts[0].body, { name: 'peer-candidate', origin: 'market', workspace: '/work/a', sessionId: 'chosen-session', compatibilityConsent: true })
  assert.deepEqual(attempts[1].body, attempts[0].body)
})


test('marketplace distinguishes built-in template provenance from live remote installation data', async () => {
  const app = createClient(async url => {
    if (url.includes('/market?')) return response({ ok: true, skills: [{ name: 'local-template', source: 'catalog/template-source', author: 'Catalog author', installsLabel: 'UNVERIFIED_LOCAL_COUNT' }] })
    if (url.endsWith('/remote/search')) return response({ ok: true, skills: [{ id: 'owner/repo/remote', name: 'remote', installsLabel: '258 verified remote installs', author: 'Remote author' }] })
    assert.fail(url)
  })
  const market = app.mount(app.client.MarketView, { t, workspace: '/work/a', sessionId: 'chosen-session', pushToast() {} })
  market.render(); await flush()
  let view = market.render()
  assert.equal(view.props.className, 'sd-page-inner sd-market-page', 'Theme-safe styles are limited to the marketplace')
  const localFoot = elements(view).find(node => node.props.className === 'sd-card-foot')
  assert.deepEqual(localFoot.props.children, ['catalog/template-source · Catalog author'])
  assert.equal(localFoot.props.children.some(child => String(child).includes('UNVERIFIED_LOCAL_COUNT')), false)
  elements(view).find(node => node.type === 'input').props.onChange({ target: { value: 'remote' } })
  await button(market.render(), 'remoteSearch').props.onClick()
  view = market.render()
  assert.ok(elements(view).some(node => node.props.className === 'sd-card-foot' && node.props.children.includes('258 verified remote installs · Remote author')))
  assert.match(app.client.zh.marketSource, /内置目录候选/)
  assert.match(app.client.zh.marketSource, /完整目录/)
  assert.match(app.client.zh.reviewSessionHint, /新会话打开后重新检查/)
  assert.doesNotMatch(app.client.zh.reviewSessionHint, /发送消息/)
})
