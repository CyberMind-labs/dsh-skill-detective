import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, readdir, link, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRecoveryService, validateRecoveryDocument } from '../recovery-service.js'

const artifacts = resolve(process.env.DSH_TEST_ARTIFACTS || '../test-artifacts/usability-2026-11-16')
await mkdir(artifacts, { recursive: true })
async function fixture(options = {}) {
  const root = await mkdtemp(join(artifacts, 'recovery-')), file = join(root, 'state.json')
  const targets = { state: { file, label: '技能管理状态' } }
  return { root, file, backup: `${file}.bak`, service: createRecoveryService({ targets, ...options }) }
}

test('recovery preview makes no writes and explicit restore preserves exact corrupt original and backup', async () => {
  const f = await fixture(), original = Buffer.from('{broken\n'), backup = Buffer.from('{"installs":{},"settings":{"autoLearn":false}}\n')
  await writeFile(f.file, original); await writeFile(f.backup, backup)
  const before = (await readdir(f.root)).sort(), description = await f.service.describe()
  assert.equal(description.files[0].state, 'corrupt'); assert.equal(description.files[0].backupAvailable, true)
  const preview = await f.service.preview('state')
  assert.equal(preview.canRestore, true); assert.equal(preview.summary.current.state, 'corrupt')
  assert.equal(preview.summary.backup.size, backup.length)
  assert.deepEqual((await readdir(f.root)).sort(), before)
  assert.deepEqual(await readFile(f.file), original)
  const result = await f.service.restore('state', preview.previewToken)
  assert.equal(result.recovered, true); assert.equal(result.preservedPath, preview.summary.preservedPath)
  assert.deepEqual(await readFile(result.preservedPath), original)
  assert.deepEqual(await readFile(f.file), backup); assert.deepEqual(await readFile(f.backup), backup)
  assert.ok(!(await readdir(f.root)).some(name => name.endsWith('.tmp')))
  await assert.rejects(f.service.restore('state', preview.previewToken), { code: 'recovery-preview-expired' })
})

test('no backup or invalid backup never changes original or creates a restore token', async () => {
  const f = await fixture(); await writeFile(f.file, '{broken')
  for (const invalid of [undefined, '[]', 'null', '{broken', '{"irrelevant":true}', '{"installs":[]}']) {
    if (invalid !== undefined) await writeFile(f.backup, invalid)
    const result = await f.service.preview('state')
    assert.equal(result.canRestore, false); assert.equal(result.previewToken, undefined)
    assert.equal(await readFile(f.file, 'utf8'), '{broken')
  }
})

test('fixed recovery targets and schema validation reject path injection and prototype keys', async () => {
  const f = await fixture()
  for (const id of ['../state', f.file, '__proto__', 'constructor', 'unknown']) await assert.rejects(f.service.preview(id), { code: 'invalid-recovery-target' })
  for (const target of ['state', 'protection', 'index', 'audit-cache']) assert.throws(() => validateRecoveryDocument(target, JSON.parse('{"__proto__":{}}')), /字典键/)
  assert.throws(() => validateRecoveryDocument('protection', { protections: { live: { enabled: true, mode: 'anything', workspace: f.root } } }))
  assert.throws(() => validateRecoveryDocument('index', { skills: { bad: {} } }))
  assert.throws(() => validateRecoveryDocument('audit-cache', { entries: [] }))
})

test('a preview is bound to exact primary and backup bytes, including after a missing primary appears', async () => {
  for (const changed of ['primary', 'backup', 'missing-primary']) {
    const f = await fixture()
    if (changed !== 'missing-primary') await writeFile(f.file, '{"settings":{"old":true}}')
    await writeFile(f.backup, '{"settings":{"backup":true}}')
    const preview = await f.service.preview('state')
    await writeFile(changed === 'backup' ? f.backup : f.file, '{"settings":{"concurrent":true}}')
    const before = await readFile(f.file).catch(() => null)
    await assert.rejects(f.service.restore('state', preview.previewToken), { code: 'recovery-file-changed' })
    assert.deepEqual(await readFile(f.file).catch(() => null), before)
    assert.ok(!(await readdir(f.root)).some(name => name.includes('recovered-original')))
  }
})

test('valid backup can restore a missing primary and reload runs after releasing the shared file queue', async () => {
  let held = false, reloaded = false
  const f = await fixture({
    withFileLock: async (_path, fn) => { assert.equal(held, false); held = true; try { return await fn() } finally { held = false } },
    afterRestore: async () => { assert.equal(held, false); reloaded = true },
  })
  await writeFile(f.backup, '{"installs":{}}')
  const preview = await f.service.preview('state'), result = await f.service.restore('state', preview.previewToken)
  assert.equal(result.preservedPath, null); assert.equal(reloaded, true)
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { installs: {} })
})

test('reload failure reports a committed restore with actionable warning rather than misreporting failure', async () => {
  const f = await fixture({ afterRestore: async () => { throw new Error('fixture reload needs a fresh session') } })
  await writeFile(f.file, '{broken'); await writeFile(f.backup, '{"settings":{}}')
  const preview = await f.service.preview('state'), result = await f.service.restore('state', preview.previewToken)
  assert.equal(result.ok, true); assert.match(result.warnings.join(' '), /文件已恢复.*fresh session/)
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { settings: {} })
})

test('primary and backup hardlinks are rejected before any recovery mutation', async () => {
  for (const position of ['primary', 'backup']) {
    const f = await fixture(); await writeFile(f.file, '{"settings":{}}'); await writeFile(f.backup, '{"settings":{}}')
    await link(position === 'primary' ? f.file : f.backup, join(f.root, 'alias.json'))
    if (position === 'backup') assert.equal((await f.service.preview('state')).canRestore, false)
    else await assert.rejects(f.service.preview('state'), { code: 'recovery-unverifiable' })
    assert.equal(await readFile(f.file, 'utf8'), '{"settings":{}}')
  }
})

test('linked recovery paths never allow restoring into another directory', async t => {
  const f = await fixture(), linked = join(f.root, 'linked'), real = join(f.root, 'real')
  await mkdir(real); await writeFile(join(real, 'state.json'), '{broken'); await writeFile(join(real, 'state.json.bak'), '{"settings":{}}')
  try { await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (cause) { if (['EPERM', 'EACCES'].includes(cause.code)) return t.skip('OS denied creation of a directory link'); throw cause }
  const service = createRecoveryService({ targets: { state: { file: join(linked, 'state.json'), label: 'state' } } })
  assert.equal((await service.preview('state')).canRestore, false)
  assert.equal(await readFile(join(real, 'state.json'), 'utf8'), '{broken')
})

test('diagnosis and preview share the writer queue so an in-progress update is not diagnosed as corruption', async () => {
  let queue = Promise.resolve(), release
  const gate = new Promise(fulfill => { release = fulfill })
  const withFileLock = (_path, fn) => { const next = queue.catch(() => {}).then(fn); queue = next.catch(() => {}); return next }
  const f = await fixture({ withFileLock })
  await writeFile(f.file, '{"settings":{}}'); await writeFile(f.backup, '{"settings":{}}')
  const writer = withFileLock(f.file, async () => { await writeFile(f.file, '{updating'); await gate; await writeFile(f.file, '{"settings":{"updated":true}}') })
  const description = f.service.describe(), preview = f.service.preview('state')
  release(); await writer
  assert.equal((await description).files[0].state, 'valid')
  assert.equal((await preview).canRestore, true)
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { settings: { updated: true } })
})
