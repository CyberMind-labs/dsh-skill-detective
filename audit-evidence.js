import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const SNAPSHOT_FORMAT = 'skill-directory-v1'
export const AUDIT_EVIDENCE_TTL = 180 * 86_400_000
const TEXT_FILE = /\.(?:md|markdown|mdown|txt|rst|csv|tsv|json|jsonc|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|fish|ps1|bat|cmd|py|rb|pl|lua|r|js|cjs|mjs|jsx|ts|tsx|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|swift|sql|html?|css|scss|less|xml|svg|vue|svelte|gradle)$/i
const EXTENSIONLESS_TEXT = new Set(['dockerfile', 'makefile', '.gitignore', 'license', 'licence', 'copying', 'notice', 'readme', 'pipfile', 'gemfile', 'rakefile'])
const BINARY_FILE = /\.(?:exe|dll|so|dylib|msi|scr|com|apk|node|wasm|png|jpe?g|gif|webp|ico|pdf|zip|gz|bz2|7z|tar|woff2?|ttf|pyc|class)$/i
const HASH = /^[a-f0-9]{64}$/
const digest = value => createHash('sha256').update(value).digest('hex')
const failure = (code, message, path) => ({ ok: false, contentHash: null, code, message, path })

function snapshotError(code, message, path) {
  return Object.assign(new Error(message), { snapshotCode: code, snapshotPath: path })
}

function readableTextPath(path) {
  const name = basename(path).toLowerCase()
  return EXTENSIONLESS_TEXT.has(name) || TEXT_FILE.test(name)
}

function permissions(entry) {
  return (entry.mode & 0o7777).toString(8).padStart(4, '0')
}

function* noLinkedAncestors(root) {
  const parents = []
  for (let current = root; ; current = dirname(current)) {
    parents.push(current)
    if (dirname(current) === current) break
  }
  for (const path of parents.reverse()) {
    const entry = yield { method: 'lstat', args: [path] }
    if (entry.isSymbolicLink()) throw snapshotError('snapshot-symlink', '目录路径包含符号链接或 junction', path)
  }
}

/** A complete, bounded local snapshot. Failure never supplies a reusable hash.
 * No hidden entry, unsupported file, symlink or failed read is silently skipped.
 * The optional fs adapter exists for deterministic I/O failure tests.
 */
function* snapshotSteps(directory, options = {}) {
  const root = resolve(directory)
  const limits = { files: options.maxFiles ?? 40, entries: options.maxEntries ?? 160, depth: options.maxDepth ?? 16, fileBytes: options.maxFileBytes ?? 256 * 1024, totalBytes: options.maxTotalBytes ?? 512 * 1024 }
  const manifest = [], files = []
  const checkedEntries = []
  let totalBytes = 0, totalChars = 0, directories = 0
  try {
    yield* noLinkedAncestors(root)
    function* visit(path, relative, depth) {
      if (depth > limits.depth) throw snapshotError('snapshot-depth-limit', '目录层级超过完整审查上限', relative)
      if (manifest.length >= limits.entries) throw snapshotError('snapshot-entry-limit', '目录条目超过完整审查上限', relative)
      const entry = yield { method: 'lstat', args: [path] }
      checkedEntries.push({ path, relative, entry })
      if (entry.isSymbolicLink()) throw snapshotError('snapshot-symlink', '目录包含符号链接或 junction，无法验证完整内容', relative)
      if ((entry.mode & 0o7000) !== 0) throw snapshotError('snapshot-special-mode', '目录包含不支持的特殊权限位', relative)
      if (entry.isDirectory()) {
        directories++
        manifest.push({ path: relative, type: 'directory', permissions: permissions(entry) })
        const children = (yield { method: 'readdir', args: [path, { withFileTypes: true }] }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        for (const child of children) {
          if (!child.name || child.name === '.' || child.name === '..' || /[\\/\u0000]/.test(child.name)) throw snapshotError('snapshot-invalid-path', '目录含不支持的文件名', relative)
          yield* visit(join(path, child.name), relative === '.' ? child.name : `${relative}/${child.name}`, depth + 1)
        }
        return
      }
      if (!entry.isFile()) throw snapshotError('snapshot-special-file', '目录包含非普通文件', relative)
      if (files.length >= limits.files) throw snapshotError('snapshot-file-limit', '文件数量超过完整审查上限', relative)
      if (entry.size > limits.fileBytes || totalBytes + entry.size > limits.totalBytes) throw snapshotError('snapshot-byte-limit', '文件大小超过完整审查上限', relative)
      if (BINARY_FILE.test(relative)) throw snapshotError('snapshot-binary', '目录包含无法按文本完整审查的二进制格式', relative)
      if (!readableTextPath(relative)) throw snapshotError('snapshot-unknown-format', '目录包含未知文件格式，未沿用历史审查', relative)
      const bytes = yield { method: 'readFile', args: [path] }
      if (!Buffer.isBuffer(bytes)) throw snapshotError('snapshot-invalid-read', '文件读取未返回完整字节', relative)
      if (bytes.length > limits.fileBytes || totalBytes + bytes.length > limits.totalBytes) throw snapshotError('snapshot-byte-limit', '读取期间文件大小超过完整审查上限', relative)
      if (bytes.includes(0)) throw snapshotError('snapshot-binary', '文件包含 NUL 字节，无法完整按文本审查', relative)
      let text
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { throw snapshotError('snapshot-invalid-utf8', '文件不是有效 UTF-8 文本', relative) }
      if (entry.size !== bytes.length) throw snapshotError('snapshot-changed-during-read', '读取期间文件发生变化', relative)
      const mode = entry.mode & 0o111 ? '100755' : '100644'
      manifest.push({ path: relative, type: 'file', mode, permissions: permissions(entry), bytes: bytes.length, sha256: digest(bytes) })
      files.push({ path: relative, text, mode, permissions: permissions(entry) })
      totalBytes += bytes.length
      totalChars += text.length
    }
    yield* visit(root, '.', 0)
    for (const { path, relative, entry } of checkedEntries) {
      const after = yield { method: 'lstat', args: [path] }
      if (after.isSymbolicLink() || after.isDirectory() !== entry.isDirectory() || after.isFile() !== entry.isFile()
        || after.mode !== entry.mode || after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs
        || after.ino !== entry.ino || after.dev !== entry.dev) throw snapshotError('snapshot-changed-during-read', '读取期间目录或文件发生变化', relative)
    }
    if (!files.some(file => file.path === 'SKILL.md')) throw snapshotError('snapshot-missing-skill', '目录缺少普通 UTF-8 SKILL.md', 'SKILL.md')
    manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const contentHash = digest(JSON.stringify([SNAPSHOT_FORMAT, manifest]))
    return { ok: true, root, format: SNAPSHOT_FORMAT, contentHash, files, manifest, coverage: { files: files.length, directories, bytes: totalBytes, chars: totalChars } }
  } catch (error) {
    return failure(error.snapshotCode || 'snapshot-read-failed', error.message, error.snapshotPath || root)
  }
}

export async function readSkillSnapshot(directory, options = {}) {
  const fs = options.fs || { lstat, readdir, readFile }
  const iterator = snapshotSteps(directory, options)
  let step = iterator.next()
  while (!step.done) {
    try { step = iterator.next(await fs[step.value.method](...step.value.args)) }
    catch (error) { step = iterator.throw(error) }
  }
  return step.value
}

export function readSkillSnapshotSync(directory, options = {}) {
  const fs = options.fs || { lstat: lstatSync, readdir: readdirSync, readFile: readFileSync }
  const iterator = snapshotSteps(directory, options)
  let step = iterator.next()
  while (!step.done) {
    try { step = iterator.next(fs[step.value.method](...step.value.args)) }
    catch (error) { step = iterator.throw(error) }
  }
  return step.value
}

function baseAudit(evidence, snapshot) {
  const source = evidence && typeof evidence === 'object' ? evidence : {}
  return { ...source, reviewedAt: Number.isFinite(source.reviewedAt) ? source.reviewedAt : null,
    scope: ['full-directory', 'skill-md', 'partial'].includes(source.scope) ? source.scope : null,
    fingerprint: HASH.test(source.fingerprint || '') ? source.fingerprint : null,
    currentFingerprint: snapshot?.ok ? snapshot.contentHash : null,
    verdict: null,
  }
}

/** UI and activation gates share this one derived, fail-closed status. */
export function assessAuditEvidence(evidence, snapshot, options = {}) {
  const audit = baseAudit(evidence, snapshot)
  if (!snapshot?.ok) return { ...audit, status: 'unverifiable', reason: snapshot?.message || '无法验证技能完整目录' }
  if (!audit.fingerprint || audit.scope !== 'full-directory' || !audit.reviewedAt) return { ...audit, status: 'unreviewed', reason: audit.reason || '缺少与完整目录绑定的审查证据' }
  if (audit.fingerprint !== snapshot.contentHash) return { ...audit, status: 'changed', reason: '技能目录正文、文件清单或权限已变化，需要重新审查' }
  const now = options.now ?? Date.now()
  if (!options.policyVersion || !options.promptHash || evidence.policyVersion !== options.policyVersion || evidence.promptHash !== options.promptHash
    || evidence.reviewedAt > now || !Number.isFinite(evidence.expiresAt) || evidence.expiresAt <= now || evidence.expiresAt <= evidence.reviewedAt
    || evidence.expiresAt > evidence.reviewedAt + (options.maxAgeMs ?? AUDIT_EVIDENCE_TTL)) return { ...audit, status: 'expired', reason: '审查期限、策略或提示词已变化，需要重新审查' }
  if (evidence.verdict !== 'allow') return { ...audit, status: 'rejected', verdict: ['warn', 'blocked'].includes(evidence.verdict) ? evidence.verdict : null, reason: evidence.reason || '完整目录未通过安全审查' }
  return { ...audit, status: 'current', verdict: 'allow', reason: '' }
}

export function isAuditCurrent(evidence, snapshot, options) {
  return assessAuditEvidence(evidence, snapshot, options).status === 'current'
}

/** The caller attests which exact snapshot was submitted to reviewFiles. */
export function createAuditEvidence(snapshot, review, options = {}) {
  const empty = baseAudit(null, snapshot)
  if (!snapshot?.ok) return assessAuditEvidence(null, snapshot, options)
  const reviewedAt = options.reviewedAt ?? Date.now()
  if (!review?.ok || review.contentHash !== snapshot.contentHash || !HASH.test(review.hash || '')
    || review.policyVersion !== options.policyVersion || review.promptHash !== options.promptHash
    || review.coverage?.files !== snapshot.coverage.files || review.coverage?.chars !== snapshot.coverage.chars
    || !options.policyVersion || !HASH.test(options.promptHash || '') || !Number.isFinite(options.expiresAt) || options.expiresAt <= reviewedAt) {
    return { ...empty, status: 'unreviewed', reason: review?.error || '审查证据未覆盖当前完整目录' }
  }
  const allow = review.verdict === 'safe' && review.poison === false && ['low', 'medium'].includes(review.severity)
  const audit = {
    status: allow ? 'current' : 'rejected', reviewedAt, scope: 'full-directory',
    fingerprint: snapshot.contentHash, currentFingerprint: snapshot.contentHash,
    verdict: allow ? 'allow' : review.verdict === 'suspicious' ? 'warn' : 'blocked',
    model: review.model || '', policyVersion: options.policyVersion, promptHash: options.promptHash,
    coverage: { ...snapshot.coverage, chunks: review.coverage.chunks },
    reviewHash: review.hash, expiresAt: options.expiresAt,
    reason: allow ? '' : review.summary || '完整目录未通过安全审查',
  }
  return assessAuditEvidence(audit, snapshot, { ...options, now: reviewedAt })
}

/** Only these exact metadata edits may carry existing directory evidence. */
export function transformSkillFrontmatter(text, operation) {
  let field, value
  if (operation?.type === 'toggle' && typeof operation.enabled === 'boolean') {
    field = 'disable-model-invocation'; value = operation.enabled ? 'false' : 'true'
  } else if (operation?.type === 'rename' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(operation.name || '')) {
    field = 'name'; value = operation.name
  } else throw new Error('不支持的受控技能变换')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) {
    if (operation.type === 'rename') return text
    return `---\n${field}: ${value}\n---\n\n${text}`
  }
  const head = match[1], rest = text.slice(match[0].length)
  const matcher = new RegExp(`^${field}:.*$`, 'gm')
  if ([...head.matchAll(matcher)].length > 1) throw new Error('重复的 frontmatter 字段不能受控迁移审查证据')
  const next = matcher.test(head) ? head.replace(matcher, `${field}: ${value}`) : `${head}\n${field}: ${value}`
  return `---\n${next}\n---${rest}`
}

/** Derivation keeps the original review clock, policy and expiry unchanged. */
export function carryControlledAudit(evidence, before, after, operation, options = {}) {
  const rejected = reason => ({ ok: false, code: 'audit-revalidation-required', audit: { ...baseAudit(evidence, after), status: after?.ok ? 'changed' : 'unverifiable', reason } })
  if (!isAuditCurrent(evidence, before, options)) return rejected('变换前缺少当前有效的完整目录审查')
  if (!after?.ok) return rejected(after?.message || '无法验证变换后的完整目录')
  const oldMain = before.files.find(file => file.path === 'SKILL.md')
  const newMain = after.files.find(file => file.path === 'SKILL.md')
  let expected
  try { expected = transformSkillFrontmatter(oldMain.text, operation) }
  catch (error) { return rejected(error.message) }
  if (newMain?.text !== expected) return rejected('主文档包含受控字段之外的变化')
  const preserved = manifest => manifest.map(entry => entry.path === 'SKILL.md' ? { ...entry, bytes: null, sha256: null } : entry)
  if (JSON.stringify(preserved(before.manifest)) !== JSON.stringify(preserved(after.manifest))) return rejected('配套文件、路径、类型或权限发生变化')
  const audit = { ...evidence, fingerprint: after.contentHash, currentFingerprint: after.contentHash,
    coverage: { ...evidence.coverage, ...after.coverage },
    derivation: { type: operation.type, ...(operation.type === 'toggle' ? { enabled: operation.enabled } : { name: operation.name }), fromFingerprint: before.contentHash, at: options.now ?? Date.now() },
  }
  return { ok: true, audit: assessAuditEvidence(audit, after, options) }
}
