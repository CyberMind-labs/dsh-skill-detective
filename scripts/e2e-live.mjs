import { mkdir, readFile, writeFile, cp, symlink } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkArtifact, assessClosedLoop } from './e2e-artifacts.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
if (!args.has('--live') || !args.has('--workspace-write')) throw new Error('This explicit live-model run requires --live --workspace-write; unit tests never invoke it.')
const taskIds = args.has('--javascript-only') ? ['javascript-check'] : args.has('--remaining') ? ['todo-report', 'javascript-check'] : ['repo-inventory']
const artifactRoot = process.env.DSH_TEST_ARTIFACTS || resolve(repo, '../test-artifacts/usability-2026-11-16')
const runDir = join(artifactRoot, `live-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const home = join(runDir, 'dsh-home'), profile = join(home, 'profiles/web'), bridge = join(profile, 'live-e2e-bridge')
const runtimeModules = 'E:/harness/resources/app.asar/dsh/node_modules'
const executable = 'E:/harness/DeepSeek Harness.exe'
const cli = join(runtimeModules, '@deepseek-ai/dsh-desktop-host/lib/cli.js')
const credentialsPath = join(process.env.USERPROFILE, '.dsh/.credentials.yaml')
const credentialHash = createHash('sha256').update(await readFile(credentialsPath)).digest('hex')
const controlKey = randomBytes(24).toString('hex'), port = 3096, origin = `http://127.0.0.1:${port}`
const fixture = join(repo, 'fixtures/e2e/sample-repo'), expectations = JSON.parse(await readFile(join(repo, 'fixtures/e2e/expectations.json'), 'utf8'))
const tasks = []
await mkdir(join(profile, 'node_modules'), { recursive: true }); await mkdir(bridge, { recursive: true })
await mkdir(join(runDir, 'agents-home/skills'), { recursive: true })
for (const id of taskIds) {
  const workspace = join(runDir, id, 'workspace'), repository = join(workspace, 'repository'), outputPath = join(workspace, 'reports', `${id}.md`)
  await mkdir(join(workspace, '.git'), { recursive: true }); await cp(fixture, repository, { recursive: true }); await mkdir(dirname(outputPath), { recursive: true })
  const request = id === 'repo-inventory'
    ? `请整理这个仓库的文件清单，统计文件数、目录数、总字节并列出各文件路径和大小，生成 Markdown 报告。仓库路径：${repository}；报告写到：${outputPath}。请不要修改源码或执行仓库脚本。`
    : id === 'todo-report'
      ? `请汇总仓库源码中的 TODO、FIXME、XXX 标记，列出文件、行号和原文并统计数量。仓库路径：${repository}；Markdown 报告写到：${outputPath}。只读源码，不执行仓库脚本。`
      : `请只把 ${join(repository, 'src/greet.js')} 中 greet 的默认名字从 'World' 改成 'Repository'，其他字节不要改。修改后对该文件做 JavaScript 语法检查，把结果写到 ${outputPath}。不要运行仓库脚本、代码或单元测试，也不要把语法检查说成测试通过。`
  const finish = id === 'javascript-check' ? '\n当前保护仅支持已确认的 read/edit/write/skill/dsh_file_task。不要调用 pwsh、present、glob 或其他未知工具。源码精确改动、报告已保存且工具返回 syntaxPassed=true 后，最多再用 read 复核一次报告，然后用自然语言简短报告结果和路径并结束。' : ''
  tasks.push({ id, workspace, repository, outputPath, expectedSkill: `safe-${id}`, operation: id, request, prompt: `${request}\n\n相关技能现已安装并完成完整目录审查。请先通过 skill 工具加载适用的技能，再按技能使用受控工具完成任务。${finish}` })
}
const config = { runDir, tasks, runtimeModules, origin, controlKey, mainMaxTokens: 6000, maxCallsPerTask: args.has('--javascript-only') ? 16 : 12, taskTimeoutMs: 240000 }
const yaml = value => JSON.stringify(value.replaceAll('\\', '/'))
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-skill-detective', 'dsh-live-e2e-bridge'] } }, dependencies: { 'dsh-skill-detective': `link:${repo.replaceAll('\\', '/')}`, 'dsh-live-e2e-bridge': 'link:./live-e2e-bridge' } }, null, 2))
await writeFile(join(profile, 'cordis.yml'), '[]\n')
await writeFile(join(profile, 'cordis.patch.yml'), `- id: working-directory\n  config:\n    defaultDirectory: ${yaml(tasks[0].workspace)}\n- id: workspace-controller\n  config:\n    documentsDirectory: ${yaml(join(runDir, 'documents'))}\n- id: credentials\n  config:\n    path: ${yaml(credentialsPath)}\n    watch: false\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n    reasoningEffort: max\n- id: session-title-llm\n  disabled: true\n- id: llm-deepseek-account\n  disabled: true\n- id: deepseek-account\n  disabled: true\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n`)
await writeFile(join(bridge, 'package.json'), JSON.stringify({ name: 'dsh-live-e2e-bridge', version: '0.0.0', type: 'module', exports: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
await writeFile(join(bridge, 'cordis.patch.yml'), '- insert:\n    - id: live-e2e-bridge\n      name: dsh-live-e2e-bridge\n')
await writeFile(join(bridge, 'index.mjs'), `import {apply as original,name,inject} from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/e2e-bridge.mjs')).href)};\nexport {name,inject};\nexport function apply(ctx){return original(ctx,${JSON.stringify(config)})}\n`)
await symlink(repo, join(profile, 'node_modules/dsh-skill-detective'), 'junction')
await symlink(bridge, join(profile, 'node_modules/dsh-live-e2e-bridge'), 'junction')
const redact = value => String(value).replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]').replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]').replace(/([?&]token=)[^&\s]+/g, '$1[REDACTED]').replace(/(web-(?:auth|client)-token[=: ]+)[^\s]+/gi, '$1[REDACTED]')
let logs = '', exited = false
const child = spawn(executable, ['--expose-internals', cli, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: tasks[0].workspace, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(runDir, 'agents-home'), ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
child.stdout.on('data', chunk => { logs += redact(chunk.toString()) }); child.stderr.on('data', chunk => { logs += redact(chunk.toString()) }); child.on('exit', () => { exited = true })
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function json(path, body, driver = false) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}), ...(driver ? { 'x-e2e-key': controlKey } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240000) })
  const text = await response.text(); let value
  try { value = JSON.parse(text) } catch { throw new Error(`Non-JSON API response ${response.status}: ${text.slice(0, 300)}`) }
  if (!response.ok || value.ok === false) throw Object.assign(new Error(`API ${path.split('?')[0]}: ${value.code || response.status} ${value.message || value.error || ''}`), { response: value })
  return value
}
const save = (path, value) => writeFile(join(runDir, path), JSON.stringify(value, null, 2))
const summary = { runMode: 'live', runDir, startedAt: Date.now(), model: { provider: 'deepseek-official', model: 'deepseek-flash' }, processId: child.pid, tasks: [], agentsHomeIsolated: true, credentialsCopied: false, credentialWrites: [], processLeftRunning: true }
console.log(JSON.stringify({ phase: 'starting', runDir, processId: child.pid }))
try {
  let inspect
  for (let attempt = 0; attempt < 90; attempt++) {
    if (exited) throw new Error('Isolated DSH exited before readiness')
    try { inspect = await json('/api/live-e2e/inspect', null, true); break } catch { await sleep(500) }
  }
  if (!inspect) throw new Error('Isolated driver never became ready')
  await save('readonly-inspection.json', inspect)
  if (!inspect.credential.configured || inspect.selected.provider !== 'deepseek-official' || inspect.selected.model !== 'deepseek-flash') throw new Error('Configured native model route is unavailable')
  console.log(JSON.stringify({ phase: 'ready', configured: inspect.credential.configured, model: inspect.selected, inferenceCalls: inspect.inferenceCalls }))
  if (args.has('--inspect-only')) { summary.inspectOnly = true }
  else for (const spec of tasks) {
    const record = { ...spec, runMode: 'live', model: inspect.selected }; summary.tasks.push(record)
    const created = await json('/api/live-e2e/create', { taskId: spec.id }, true); record.sessionId = created.sessionId
    record.hostTool = created
    if (!created.toolAvailable || !['repo-inventory', 'todo-report', 'javascript-check'].every(op => created.operations.includes(op))) throw new Error('Actual agent lacks all three controlled repository operations')
    const base = { workspace: spec.workspace, sessionId: record.sessionId }
    record.protection = await json('/api/dsh-skill-detective/protection', { ...base, enabled: true, mode: 'workspace-write' })
    record.preState = await json('/api/dsh-skill-detective/state?' + new URLSearchParams(base))
    record.compatibility = []
    for (const name of ['safe-repo-inventory', 'safe-todo-report', 'safe-javascript-check']) {
      const result = await json('/api/dsh-skill-detective/compatibility', { ...base, name })
      record.compatibility.push({ name, ...result })
      if (result.compatibility?.status !== 'supported') throw new Error(`Real session compatibility not supported: ${name}`)
    }
    await json('/api/dsh-skill-detective/scan', base)
    await json('/api/live-e2e/phase', { taskId: spec.id, phase: 'analysis' }, true)
    record.analysis = (await json('/api/dsh-skill-detective/analyze', { ...base, text: spec.request })).analysis
    await save(`${spec.id}/analysis.json`, record.analysis)
    if (record.analysis.source !== 'llm' || record.analysis.need !== `catalog:${spec.expectedSkill}`) throw new Error(`Real model did not select ${spec.expectedSkill}: ${record.analysis.need} / ${record.analysis.error}`)
    await json('/api/live-e2e/phase', { taskId: spec.id, phase: 'install' }, true)
    record.install = await json('/api/dsh-skill-detective/install', { ...base, name: record.analysis.candidates[0].name, need: record.analysis.need, origin: 'plugin', scope: 'workspace', text: spec.request })
    const state = await json('/api/dsh-skill-detective/state?' + new URLSearchParams(base))
    record.audit = state.installed.find(skill => skill.name === spec.expectedSkill && skill.scope === 'workspace')?.audit
    for (let attempt = 0; attempt < 20; attempt++) {
      record.visible = (await json('/api/live-e2e/visible?taskId=' + spec.id, null, true)).skills
      if (record.visible.some(skill => skill.name === spec.expectedSkill)) break
      await sleep(250)
    }
    if (record.audit?.status !== 'current' || !record.visible.some(skill => skill.name === spec.expectedSkill)) throw new Error('Reviewed installed skill is not current and host-visible')
    await json('/api/live-e2e/run', { taskId: spec.id }, true)
    let result
    do { await sleep(1000); result = await json('/api/live-e2e/result?taskId=' + spec.id, null, true) } while (result.running)
    record.modelCalls = result.calls; record.toolReceipts = result.outcome?.toolReceipts; record.turnEnd = result.outcome?.turnEnd; record.executionError = result.outcome?.error; record.finalText = result.outcome?.finalText
    summary.credentialWrites.push(...result.credentialWrites)
    record.artifactChecks = await checkArtifact(spec, fixture, expectations)
    record.acceptance = assessClosedLoop(record)
    await save(`${spec.id}/acceptance.json`, record)
    console.log(JSON.stringify({ phase: 'task-complete', taskId: spec.id, passed: record.acceptance.passed, modelCalls: record.modelCalls.length, tools: record.toolReceipts.map(receipt => ({ name: receipt.name, error: receipt.result?.isError })) }))
    if (!record.acceptance.passed) throw new Error('First failing observed stage stops further paid tasks')
  }
} catch (error) {
  summary.error = redact(error.message); if (error.response) summary.errorResponse = error.response
  console.error(JSON.stringify({ phase: 'failed', error: summary.error })); process.exitCode = 1
} finally {
  child.kill('SIGINT')
  for (let attempt = 0; attempt < 30 && !exited; attempt++) await sleep(100)
  if (!exited) child.kill()
  summary.processLeftRunning = !exited; summary.endedAt = Date.now()
  summary.credentialFileUnchanged = credentialHash === createHash('sha256').update(await readFile(credentialsPath)).digest('hex')
  await save('summary.json', summary); await writeFile(join(runDir, 'host-redacted.log'), logs)
  console.log(JSON.stringify({ phase: 'finished', runDir, processLeftRunning: summary.processLeftRunning, credentialFileUnchanged: summary.credentialFileUnchanged }))
}
