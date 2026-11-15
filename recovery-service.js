import { lstat, readFile, writeFile, rename, link, unlink } from 'node:fs/promises'
import { resolve, dirname, join, basename, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MAX_BYTES = 32 * 1024 * 1024
const MODES = new Set(['read-only', 'workspace-write'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(value).digest('hex')
const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 })

function rejectPrototypeKeys(value, depth = 0) {
  if (depth > 40) throw new Error('备份结构层级过深')
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('备份含不支持的字典键')
    rejectPrototypeKeys(child, depth + 1)
  }
}

export function validateRecoveryDocument(target, data) {
  if (!object(data)) throw new Error('备份根节点必须为对象')
  rejectPrototypeKeys(data)
  if (target === 'protection') {
    if (data.protections !== undefined && !object(data.protections)) throw new Error('保护记录必须为对象')
    for (const [id, policy] of Object.entries(data.protections || {})) {
      if (!id || !object(policy) || policy.enabled !== true || !MODES.has(policy.mode)
        || typeof policy.workspace !== 'string' || !isAbsolute(policy.workspace)) throw new Error('保护记录不完整，不能恢复')
    }
  } else if (target === 'state') {
    for (const key of ['settings', 'installs', 'sessions', 'suppressed', 'deleted', 'discovered']) {
      if (data[key] !== undefined && !object(data[key])) throw new Error(`${key} 不是有效状态集合`)
    }
    if (Object.keys(data).length && !['settings', 'installs', 'sessions', 'suppressed', 'deleted', 'discovered'].some(key => Object.hasOwn(data, key))) throw new Error('不是技能管理状态备份')
  } else if (target === 'index') {
    if (!object(data.skills)) throw new Error('索引备份缺少技能集合')
    for (const item of Object.values(data.skills)) if (!object(item) || typeof item.path !== 'string') throw new Error('索引备份包含不完整实例')
  } else if (target === 'audit-cache') {
    if (!object(data.entries)) throw new Error('审查缓存备份缺少条目集合')
  } else throw new Error('不支持的恢复目标')
  return data
}

export function createRecoveryService(options) {
  const { targets, withFileLock = (_file, fn) => fn(), afterRestore = async () => {} } = options
  const tokens = new Map()
  const targetFor = id => {
    const target = targets[id]
    if (!Object.hasOwn(targets, id) || !target || typeof target.file !== 'string') throw failure('invalid-recovery-target', '请选择一个已知状态文件')
    return { ...target, file: resolve(target.file) }
  }
  async function checkedBytes(file) {
    for (let path = resolve(file); ; path = dirname(path)) {
      try { if ((await lstat(path)).isSymbolicLink()) throw failure('recovery-linked-path', '恢复路径包含链接，不能自动恢复') }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      if (dirname(path) === path) break
    }
    let before
    try { before = await lstat(file) }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES) throw failure('recovery-unverifiable', '文件类型、链接或大小不适合自动恢复')
    const bytes = await readFile(file)
    const after = await lstat(file)
    if (bytes.length > MAX_BYTES || bytes.length !== before.size || before.ino !== after.ino || before.dev !== after.dev
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw failure('recovery-file-changed', '读取期间状态文件发生变化，请重新预览')
    return { bytes, hash: hash(bytes), size: bytes.length, mtime: after.mtime.toISOString() }
  }
  function parse(id, record) {
    if (!record) return null
    return validateRecoveryDocument(id, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.bytes)))
  }
  async function inspectUnlocked(id) {
    const target = targetFor(id), backupPath = `${target.file}.bak`
    let current, backup, currentData, backupData, currentError = '', backupError = '', busy = false
    try { current = await checkedBytes(target.file); currentData = parse(id, current) }
    catch (cause) { currentError = cause.message; busy = ['recovery-file-changed', 'ENOENT'].includes(cause.code) }
    try { backup = await checkedBytes(backupPath); backupData = parse(id, backup) }
    catch (cause) { backupError = cause.message }
    return { id, target, backupPath, current, backup, currentData, backupData,
      currentState: busy ? 'busy' : currentError ? 'corrupt' : current ? 'valid' : 'missing', currentError, backupError,
      canRestore: Boolean(backup && backupData && !backupError) }
  }
  async function inspect(id) {
    const target = targetFor(id)
    // The normal panel refresh can rewrite the index while preflight reads it.
    // Serialize that read too; an external concurrent change remains retryable,
    // never evidence that the JSON needs a backup restore.
    return withFileLock(target.file, async () => {
      let item
      for (let attempt = 0; attempt < 3; attempt++) {
        item = await inspectUnlocked(id)
        if (item.currentState !== 'busy') return item
      }
      item.canRestore = false
      return item
    })
  }
  function publicInfo(item) {
    return { id: item.id, label: item.target.label, path: item.target.file, state: item.currentState,
      reason: item.currentError, backupAvailable: item.canRestore,
      backup: { path: item.backupPath, size: item.backup?.size ?? null, mtime: item.backup?.mtime ?? null, reason: item.backupError || (!item.backup ? '没有可用的 .bak 备份' : '') } }
  }
  async function describe() {
    return { files: await Promise.all(Object.keys(targets).map(async id => publicInfo(await inspect(id)))) }
  }
  async function preview(id) {
    const item = await inspect(id), info = publicInfo(item)
    if (item.currentState === 'busy') return { ok: true, canRestore: false, target: id, summary: info, reason: '状态正在更新，请重新检查；无需恢复备份' }
    if (!item.canRestore) return { ok: true, canRestore: false, target: id, summary: info, reason: item.backupError || '没有可验证的备份，未修改原文件' }
    // A readable corrupt original must still be bound to the preview hash.
    let current = item.current
    if (!current) current = await checkedBytes(item.target.file)
    const token = randomUUID(), preservedPath = `${item.target.file}.recovered-original-${Date.now()}-${randomUUID()}`
    const row = { target: id, currentHash: current?.hash ?? null, backupHash: item.backup.hash, preservedPath, expiresAt: Date.now() + 5 * 60_000 }
    for (const [key, value] of tokens) if (value.expiresAt <= Date.now()) tokens.delete(key)
    if (tokens.size >= 32) throw failure('recovery-preview-limit', '恢复预览过多，请稍后重试')
    tokens.set(token, row)
    const counts = id === 'protection' ? { protectedSessions: Object.keys(item.backupData.protections || {}).length }
      : id === 'index' ? { skillInstances: Object.keys(item.backupData.skills).length }
        : id === 'audit-cache' ? { auditEntries: Object.keys(item.backupData.entries).length }
          : { installedRecords: Object.keys(item.backupData.installs || {}).length }
    return { ok: true, canRestore: true, target: id, previewToken: token, expiresAt: row.expiresAt,
      summary: { ...info, counts, current: { state: item.currentState, size: current?.size ?? null, mtime: current?.mtime ?? null },
        preservedPath: current ? preservedPath : null,
        impact: '仅恢复所选文件；原件先单独保留，.bak 不变。恢复后重新检查配置、审查记录和会话保护。' } }
  }
  async function restore(id, previewToken) {
    const target = targetFor(id), row = tokens.get(previewToken)
    if (!row || row.target !== id || row.expiresAt <= Date.now()) throw failure('recovery-preview-expired', '预览已过期，请重新查看备份')
    tokens.delete(previewToken)
    const result = await withFileLock(target.file, async () => {
      const current = await checkedBytes(target.file), backup = await checkedBytes(`${target.file}.bak`)
      if ((current?.hash ?? null) !== row.currentHash || backup?.hash !== row.backupHash) throw failure('recovery-file-changed', '原件或备份在预览后发生变化，未执行恢复')
      parse(id, backup)
      const temp = join(dirname(target.file), `.${basename(target.file)}.restore-${randomUUID()}.tmp`)
      let preserved = false, published = false
      const warnings = []
      try {
        await writeFile(temp, backup.bytes, { flag: 'wx', mode: 0o600 })
        if (current) {
          await rename(target.file, row.preservedPath)
          preserved = true
          const moved = await checkedBytes(row.preservedPath)
          if (moved?.hash !== row.currentHash) throw failure('recovery-file-changed', '保留原件时发现变化，恢复已停止')
        }
        // link publishes only if destination does not exist, avoiding an
        // overwrite of a concurrent writer between the check and publication.
        await link(temp, target.file)
        published = true
      } catch (cause) {
        if (preserved && !published) {
          try { await link(row.preservedPath, target.file); await unlink(row.preservedPath) }
          catch { cause.message += `；原件已保留在 ${row.preservedPath}，未覆盖新出现的目标文件` }
        }
        throw cause
      } finally { await unlink(temp).catch(cause => { if (cause.code !== 'ENOENT') warnings.push(`暂存文件需手动清理：${temp}`) }) }
      return { ok: true, target: id, recovered: true, preservedPath: current ? row.preservedPath : null, warnings }
    })
    // Reload may write a fresh index. Release the per-file queue first so
    // restoring the index cannot await a write queued behind itself.
    try { await afterRestore(id) } catch (cause) { result.warnings.push(`文件已恢复，重新加载仍需处理：${cause.message}`) }
    return result
  }
  return { describe, preview, restore }
}
