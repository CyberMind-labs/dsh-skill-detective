import { lstat, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, relative, dirname, extname, sep, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { executeFileRecipe } from './file-recipes.js'
import { validateWorkspaceTaskPath } from './runtime-policy.js'

export const REPO_OPERATIONS = Object.freeze(['repo-inventory', 'todo-report', 'javascript-check'])
const EXCLUDED = new Set(['.git', '.dsh', '.codex', '.agents', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage'])
const TEXT = /\.(?:[cm]?js|jsx|tsx?|py|go|rs|java|[ch]|cpp|hpp|cs|rb|php|sh|ps1|md|txt|json|ya?ml|toml|css|html?)$/i
const LIMITS = Object.freeze({ files: 400, entries: 1200, depth: 12, bytes: 512 * 1024, fileBytes: 256 * 1024, reportBytes: 256 * 1024 })
const fail = (code, message) => Object.assign(new Error(message), { code })
const inside = (root, path) => { const tail = relative(root, path); return tail === '' || tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail) }

export function planRepoTask(args, active, context, controlRoots = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['operation', 'input_path', 'output_path'].includes(key))
    || !REPO_OPERATIONS.includes(args.operation)) throw fail('repo-task-invalid', '仅支持已列出的固定仓库操作，不接受命令、脚本或额外参数')
  if (!active.some(record => record.operations?.includes(args.operation))) throw fail('recipe-skill-required', '请先加载对应的完整审查受控技能')
  const pathOptions = { controlRoots, readonlyRoots: active.flatMap(record => record.readonlyRoots || []) }
  const input = validateWorkspaceTaskPath(args.input_path, context, { ...pathOptions, directory: args.operation !== 'javascript-check' })
  let output = null
  if (args.output_path !== undefined) {
    output = validateWorkspaceTaskPath(args.output_path, context, { ...pathOptions, write: true })
    if (resolve(output) === resolve(input)) throw fail('repo-task-invalid', '报告不能覆盖输入')
    if (!/\.(?:md|txt)$/i.test(output)) throw fail('repo-task-invalid', '报告只能保存为新的 .md 或 .txt 文件')
  }
  if (args.operation === 'javascript-check' && !/\.(?:js|mjs|cjs)$/i.test(input)) throw fail('repo-task-invalid', '语法检查只接受 .js、.mjs 或 .cjs 文件')
  return { operation: args.operation, input, output, context, pathOptions }
}

async function checkedSource(path, maximum = LIMITS.fileBytes) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw fail('repo-input-unverifiable', '源码不是可核验的普通文件或超过大小限制')
  const bytes = await readFile(path), after = await lstat(path)
  if (bytes.length > maximum || before.size !== bytes.length || before.ino !== after.ino || before.dev !== after.dev
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.isSymbolicLink()) throw fail('repo-input-changed', '读取期间源码发生变化')
  let text
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw fail('repo-input-unverifiable', '源码不是完整 UTF-8 文本') }
  if (text.includes('\0')) throw fail('repo-input-unverifiable', '源码包含二进制内容')
  return { text, bytes: bytes.length }
}

async function repositoryInput(plan) {
  const files = [], excluded = []
  let directories = 0, entries = 0, bytes = 0
  async function walk(directory, depth) {
    if (depth > LIMITS.depth) throw fail('repo-task-limit', '仓库目录超过深度限制，未生成不完整报告')
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const child of children) {
      if (++entries > LIMITS.entries) throw fail('repo-task-limit', '仓库条目超过限制，未生成不完整报告')
      const path = join(directory, child.name), label = relative(plan.input, path).split(sep).join('/')
      if (EXCLUDED.has(child.name.toLowerCase())) { excluded.push({ path: label, reason: '默认排除的控制或生成目录' }); continue }
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw fail('repo-input-unverifiable', `仓库含链接或特殊文件：${label}`)
      try { validateWorkspaceTaskPath(path, plan.context, { ...plan.pathOptions, directory: info.isDirectory() }) }
      catch (cause) {
        if (cause.code === 'runtime-sensitive-path') { excluded.push({ path: label, reason: '敏感路径或控制面' }); continue }
        throw cause
      }
      if (info.isDirectory()) { directories++; await walk(path, depth + 1); continue }
      if (files.length >= LIMITS.files) throw fail('repo-task-limit', '仓库文件超过限制，未生成不完整报告')
      if (plan.operation === 'todo-report') {
        if (!TEXT.test(child.name)) { excluded.push({ path: label, reason: '非受支持源码文本' }); continue }
        const source = await checkedSource(path)
        bytes += source.bytes
        if (bytes > LIMITS.bytes) throw fail('repo-task-limit', '源码总量超过限制，未截断后报告成功')
        files.push({ path: label, ...source })
      } else files.push({ path: label, bytes: info.size })
    }
  }
  await walk(plan.input, 0)
  return { files, directories, excluded }
}

async function inputType(plan) {
  if (extname(plan.input).toLowerCase() === '.mjs') return 'module'
  if (extname(plan.input).toLowerCase() === '.cjs') return 'commonjs'
  for (let dir = dirname(plan.input); inside(plan.context.workspaceRoot, dir); dir = dirname(dir)) {
    const file = join(dir, 'package.json')
    try {
      // Missing nearest manifests are normal. Check that exact case before
      // the boundary checker deliberately normalizes filesystem errors.
      try { await lstat(file) } catch (cause) { if (cause.code === 'ENOENT') { if (dir === plan.context.workspaceRoot) break; continue }; throw cause }
      validateWorkspaceTaskPath(file, plan.context, plan.pathOptions)
      const value = JSON.parse((await checkedSource(file, 64 * 1024)).text.replace(/^\uFEFF/, ''))
      return value.type === 'module' ? 'module' : 'commonjs'
    } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    if (dir === plan.context.workspaceRoot || dirname(dir) === dir) break
  }
  return 'commonjs'
}

/** Fixed syntax parser only. Input bytes go to stdin, never to eval or a shell. */
export async function checkJavaScriptSyntax(text, mode, options = {}) {
  if (!['module', 'commonjs'].includes(mode) || typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.fileBytes) throw fail('repo-task-invalid', '语法检查输入或模式无效')
  const executable = options.executable || process.execPath
  const environment = { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '', NODE_PATH: '', NODE_NO_WARNINGS: '1' }
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) environment[key] = process.env[key]
  return new Promise((fulfill, reject) => {
    const child = spawn(executable, ['--check', `--input-type=${mode}`], { shell: false, windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    let diagnostic = '', settled = false
    const timer = setTimeout(() => { child.kill(); finish(fail('repo-check-timeout', '固定语法检查超时，未执行仓库脚本')) }, 5000)
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : fulfill(result) }
    const collect = chunk => { diagnostic += chunk.toString('utf8'); if (Buffer.byteLength(diagnostic) > 32 * 1024) { child.kill(); finish(fail('repo-check-limit', '语法诊断超过限制')) } }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', cause => finish(fail('repo-check-unavailable', `宿主语法检查不可用：${cause.message}`)))
    child.on('close', code => finish(null, { passed: code === 0, diagnostic: diagnostic.trim(), mode }))
    child.stdin.on('error', cause => { if (cause.code !== 'EPIPE') finish(cause) })
    child.stdin.end(text)
  })
}

export function createRepoTaskService(service) {
  const definitions = new Map()
  let ready = false, probeReason = '正在检查固定语法解析器'
  const initialization = checkJavaScriptSyntax('export const fixture = 1;', 'module').then(result => { if (!result.passed) throw fail('repo-check-unavailable', '固定语法解析器自检未通过'); ready = true; probeReason = '' }).catch(cause => { probeReason = cause.message })
  const definition = {
    name: 'dsh_file_task', description: 'Run a fixed reviewed repository operation: file inventory, TODO markers, or JavaScript syntax parsing. No repository scripts, arbitrary commands or network. Load the corresponding safe-* skill first.',
    parameters: { type: 'object', additionalProperties: false, required: ['operation', 'input_path'], properties: {
      operation: { type: 'string', enum: REPO_OPERATIONS }, input_path: { type: 'string' }, output_path: { type: 'string', description: 'Optional new report path. Requires workspace-write. Existing files are preserved.' },
    } },
    output: { schema: { type: 'object', required: ['ok', 'operation', 'report', 'summary', 'outputPath'], properties: {
      ok: { type: 'boolean' }, operation: { type: 'string' }, report: { type: 'string' }, summary: { type: 'object', properties: {}, additionalProperties: true }, outputPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!ready && args.operation === 'javascript-check') throw fail('repo-check-unavailable', probeReason)
      const plan = service.protection.checkFileTask(exec)
      let result
      if (args.operation === 'javascript-check') {
        const source = await checkedSource(plan.input), mode = await inputType(plan)
        const check = await checkJavaScriptSyntax(source.text, mode)
        // Parser diagnostics include untrusted source lines. Indent every line
        // so a saved Markdown report cannot turn them into links or HTML.
        const diagnostic = check.diagnostic.split(/\r?\n/).map(line => `    ${line}`).join('\n')
        result = { operation: args.operation, text: `# JavaScript 语法检查\n\n${check.passed ? '通过' : '未通过'}（${mode}）\n\n仅检查语法，未执行代码或单元测试。\n\n${diagnostic}\n`, summary: { syntaxPassed: check.passed, inputType: mode, executedCode: false }, ok: check.passed }
      } else {
        const input = await repositoryInput(plan)
        result = executeFileRecipe(args.operation, input)
        result.text += `\n默认排除：${[...EXCLUDED].join('、')}。另排除 ${input.excluded.length} 项敏感或非源码内容。\n`
        result.summary.excludedCount = input.excluded.length
        result.ok = true
      }
      if (Buffer.byteLength(result.text) > LIMITS.reportBytes) throw fail('repo-report-limit', '完整报告超过限制，未截断或写入')
      if (plan.output) {
        // Repeat authorization after I/O and parser work; create a new file
        // exclusively so an existing user's report is never silently replaced.
        const fresh = service.protection.checkFileTask(exec)
        if (fresh.input !== plan.input || fresh.output !== plan.output) throw fail('repo-task-changed', '任务路径在执行期间发生变化')
        await mkdir(dirname(plan.output), { recursive: true })
        validateWorkspaceTaskPath(plan.output, fresh.context, { ...fresh.pathOptions, write: true })
        await writeFile(plan.output, result.text, { flag: 'wx', mode: 0o600 })
      }
      return { ok: result.ok, operation: args.operation, report: result.text, summary: result.summary, outputPath: plan.output }
    },
  }
  function attach(agent) {
    if (!agent?.ctx) return
    const previous = definitions.get(agent.id)
    if (previous?.agent === agent) return
    if (previous) { definitions.delete(agent.id); previous.dispose?.() }
    const tools = agent.ctx.get?.('tools')
    if (typeof tools?.register !== 'function') return
    const existing = tools.get?.(definition.name, agent)
    if (existing && existing !== definition) return
    const dispose = existing ? () => {} : tools.register(definition)
    const entry = { agent, dispose }
    definitions.set(agent.id, entry)
    agent.ctx.effect?.(() => () => {
      // A resumed agent may reuse the session id. Its predecessor's cleanup
      // cannot remove that new registration or retain the old agent forever.
      if (definitions.get(agent.id) !== entry) return
      definitions.delete(agent.id); dispose?.()
    }, 'skill-detective: repository tool agent lifetime')
  }
  function capabilities(sessionId) {
    const agent = service.ctx.get('agents')?.get?.(sessionId)
    let tools
    try { tools = agent?.ctx?.get?.('tools') || service.ctx.get('tools') } catch { /* unavailable */ }
    const visible = Boolean(agent && tools?.get?.(definition.name, agent) === definition)
    return { operations: visible ? REPO_OPERATIONS.filter(operation => operation !== 'javascript-check' || ready) : [],
      reason: !visible ? '所选会话尚未提供受控仓库工具' : probeReason, toolAvailable: visible }
  }
  return { definition, initialization, attach, capabilities, dispose() { for (const value of definitions.values()) value.dispose?.(); definitions.clear() } }
}

export const __test = { repositoryInput, checkedSource, inputType, LIMITS }
