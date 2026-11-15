import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile, readdir, lstat, chmod, rename, rm, symlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readSkillSnapshot, readSkillSnapshotSync, createAuditEvidence, assessAuditEvidence, carryControlledAudit, transformSkillFrontmatter } from '../audit-evidence.js'

const artifactRoot = process.env.DSH_TEST_ARTIFACTS || resolve(dirname(fileURLToPath(import.meta.url)), '../../test-artifacts/fix-2026-11-15')
await mkdir(artifactRoot, { recursive: true })
const run = await mkdtemp(join(artifactRoot, 'audit-evidence-'))
const policy = { policyVersion: 'test-full-directory-v1', promptHash: createHash('sha256').update('test prompt').digest('hex'), now: 1_000 }
async function fixture(t) {
  const root = await mkdtemp(join(run, 'skill-'))
  await writeFile(join(root, 'SKILL.md'), '---\nname: example\ndescription: "test"\n---\n\n# Test\nUse scripts/run.js.\n')
  await mkdir(join(root, 'scripts'))
  await writeFile(join(root, 'scripts', 'run.js'), 'export const safe = true\n')
  t.diagnostic(`Isolated snapshot: ${root}`)
  return root
}
function evidence(snapshot) {
  return createAuditEvidence(snapshot, { ok: true, contentHash: snapshot.contentHash, hash: 'a'.repeat(64), policyVersion: policy.policyVersion, promptHash: policy.promptHash, verdict: 'safe', poison: false, severity: 'low', model: 'local-stub', coverage: { files: snapshot.coverage.files, chars: snapshot.coverage.chars, chunks: 1 } }, { ...policy, reviewedAt: 1_000, expiresAt: 10_000 })
}

test('async and sync snapshots hash every file, hidden entry, path and directory consistently', async t => {
  const root = await fixture(t)
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, '.hidden', 'setup.sh'), 'echo hidden\n')
  const snapshot = await readSkillSnapshot(root)
  assert.equal(snapshot.ok, true)
  assert.deepEqual(readSkillSnapshotSync(root), snapshot)
  assert.ok(snapshot.manifest.some(file => file.path === '.hidden/setup.sh'))
  const audit = evidence(snapshot)
  assert.equal(audit.status, 'current')
  await writeFile(join(root, 'scripts', 'run.js'), 'export const safe = null\n')
  const changed = await readSkillSnapshot(root)
  assert.notEqual(changed.contentHash, snapshot.contentHash)
  assert.equal(assessAuditEvidence(audit, changed, policy).status, 'changed')
  assert.equal(assessAuditEvidence(audit, changed, policy).verdict, null)
  await rename(join(root, '.hidden', 'setup.sh'), join(root, '.hidden', 'renamed.sh'))
  const renamed = await readSkillSnapshot(root)
  assert.notEqual(renamed.contentHash, changed.contentHash)
  await mkdir(join(root, 'empty'))
  assert.notEqual((await readSkillSnapshot(root)).contentHash, renamed.contentHash)
})

test('unknown files, binaries, invalid UTF-8 and read failures never retain a historical pass', async t => {
  const root = await fixture(t)
  const good = await readSkillSnapshot(root), audit = evidence(good)
  for (const [name, bytes, code] of [ ['data.unknown', Buffer.from('plain text'), 'snapshot-unknown-format'], ['asset.png', Buffer.from([1, 2]), 'snapshot-binary'], ['bad.txt', Buffer.from([0xff, 0xfe]), 'snapshot-invalid-utf8'], ['nul.js', Buffer.from([0, 1]), 'snapshot-binary'] ]) {
    await writeFile(join(root, name), bytes)
    const invalid = await readSkillSnapshot(root)
    assert.equal(invalid.ok, false)
    assert.equal(invalid.code, code)
    assert.equal(invalid.contentHash, null)
    assert.equal(assessAuditEvidence(audit, invalid, policy).status, 'unverifiable')
    assert.equal(assessAuditEvidence(audit, invalid, policy).verdict, null)
    await rm(join(root, name))
  }
  const fs = { lstat, readdir, readFile: async path => { if (path.endsWith('run.js')) throw new Error('TEST_READ_FAILED'); return readFile(path) } }
  const failed = await readSkillSnapshot(root, { fs })
  assert.equal(failed.ok, false); assert.match(failed.message, /TEST_READ_FAILED/)
  assert.equal(failed.contentHash, null)
})

test('symlinks or junctions are rejected without reading their target', async t => {
  const root = await fixture(t)
  const external = await mkdtemp(join(run, 'external-'))
  await writeFile(join(external, 'outside.sh'), 'DO_NOT_READ\n')
  try { await symlink(external, join(root, '.linked'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`Host cannot create link: ${error.code}`); throw error }
  const snapshot = await readSkillSnapshot(root)
  assert.equal(snapshot.ok, false); assert.equal(snapshot.code, 'snapshot-symlink')
  assert.equal(readSkillSnapshotSync(root).code, 'snapshot-symlink')
})

test('permission changes invalidate evidence and special modes cannot be blessed', async t => {
  if (process.platform === 'win32') return t.skip('POSIX executable/special permission bits are not available on Windows')
  const root = await fixture(t), file = join(root, 'scripts', 'run.js')
  await chmod(file, 0o644)
  const original = await readSkillSnapshot(root)
  await chmod(file, 0o755)
  const executable = await readSkillSnapshot(root)
  assert.notEqual(executable.contentHash, original.contentHash)
  assert.equal(executable.files.find(item => item.path === 'scripts/run.js').mode, '100755')
  await chmod(file, 0o4755)
  assert.equal((await readSkillSnapshot(root)).code, 'snapshot-special-mode')
})

test('policy, prompt and expiry changes invalidate exact-content evidence; main-only evidence cannot migrate to full', async t => {
  const snapshot = await readSkillSnapshot(await fixture(t)), audit = evidence(snapshot)
  assert.equal(assessAuditEvidence(audit, snapshot, { ...policy, policyVersion: 'different' }).status, 'expired')
  assert.equal(assessAuditEvidence(audit, snapshot, { ...policy, promptHash: 'b'.repeat(64) }).status, 'expired')
  assert.equal(assessAuditEvidence(audit, snapshot, { ...policy, now: 10_000 }).status, 'expired')
  assert.equal(assessAuditEvidence({ ...audit, scope: 'skill-md' }, snapshot, policy).status, 'unreviewed')
  assert.equal(assessAuditEvidence({ ...audit, reviewedAt: 2_000 }, snapshot, policy).status, 'expired')
  assert.equal(assessAuditEvidence({ ...audit, expiresAt: audit.reviewedAt }, snapshot, policy).status, 'expired')
  assert.equal(assessAuditEvidence({ ...audit, expiresAt: Number.MAX_SAFE_INTEGER }, snapshot, policy).status, 'expired')
  assert.equal(createAuditEvidence(snapshot, { ok: true, contentHash: 'c'.repeat(64) }, policy).status, 'unreviewed')
})

test('controlled toggle and rename carry evidence only for the exact proved change without extending expiry', async t => {
  const root = await fixture(t)
  const before = await readSkillSnapshot(root), audit = evidence(before)
  const main = before.files.find(file => file.path === 'SKILL.md')
  const operation = { type: 'toggle', enabled: false }
  await writeFile(join(root, 'SKILL.md'), transformSkillFrontmatter(main.text, operation))
  const after = await readSkillSnapshot(root)
  const carried = carryControlledAudit(audit, before, after, operation, policy)
  assert.equal(carried.ok, true)
  assert.equal(carried.audit.status, 'current')
  assert.equal(carried.audit.reviewedAt, audit.reviewedAt)
  assert.equal(carried.audit.expiresAt, audit.expiresAt)
  assert.equal(carried.audit.derivation.fromFingerprint, before.contentHash)
  await writeFile(join(root, 'SKILL.md'), transformSkillFrontmatter(after.files.find(file => file.path === 'SKILL.md').text, { type: 'rename', name: 'example-two' }))
  const renamed = await readSkillSnapshot(root)
  assert.equal(carryControlledAudit(carried.audit, after, renamed, { type: 'rename', name: 'example-two' }, policy).ok, true)
  await writeFile(join(root, 'scripts', 'run.js'), 'export const injected = true\n')
  const tampered = await readSkillSnapshot(root)
  assert.equal(carryControlledAudit(carried.audit, after, tampered, { type: 'rename', name: 'example-two' }, policy).ok, false)
  assert.equal(carryControlledAudit({ ...audit, scope: 'partial' }, before, after, operation, policy).ok, false)
})

test('file changes during snapshot reads fail closed rather than minting mixed evidence', async t => {
  const root = await fixture(t)
  let changed = false
  const fs = { lstat, readdir, readFile: async path => {
    const bytes = await readFile(path)
    if (!changed && path.endsWith('run.js')) { changed = true; await writeFile(path, 'export const mutation = true\n') }
    return bytes
  } }
  const snapshot = await readSkillSnapshot(root, { fs })
  assert.equal(snapshot.ok, false); assert.equal(snapshot.code, 'snapshot-changed-during-read')
  assert.equal(snapshot.contentHash, null)
})
