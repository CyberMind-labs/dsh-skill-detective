import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

// Reopen an existing isolated fixture for browser inspection. This driver
// creates fresh empty agents, never follows up a message or invokes a model.
const runDir = resolve(process.argv[2]), origin = 'http://127.0.0.1:3096'
const home = join(runDir, 'dsh-home'), bridgeFile = join(home, 'profiles/web/live-e2e-bridge/index.mjs')
const original = await readFile(bridgeFile, 'utf8')
const match = original.match(/return original\(ctx,(\{.*\})\)\}/)
if (!match) throw new Error('Unknown generated bridge configuration')
const config = JSON.parse(match[1])
config.maxCallsPerTask = 0; config.modelMetadataFile = 'ui-model-call-metadata.json'
await writeFile(bridgeFile, original.replace(match[1], JSON.stringify(config)))
let logs = '', exited = false, accessWritten = false
const child = spawn('E:/harness/DeepSeek Harness.exe', ['--expose-internals', join(config.runtimeModules, '@deepseek-ai/dsh-desktop-host/lib/cli.js'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '3096'], { cwd: config.tasks[0].workspace, env: { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(runDir, 'agents-home'), ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const redact = text => text.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]').replace(/([?&]token=)[^&\s]+/g, '$1[REDACTED]')
async function capture(chunk) {
  const text = chunk.toString(), url = text.match(/http:\/\/127\.0\.0\.1:3096\/\?token=[^\s]+/)?.[0]
  if (url && !accessWritten) { accessWritten = true; await writeFile(join(runDir, 'ui-access.json'), JSON.stringify({ url, processId: child.pid, inferenceDisabled: true }, null, 2)) }
  logs += redact(text)
}
child.stdout.on('data', capture); child.stderr.on('data', capture)
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function json(path, body, driver = true) {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { origin, ...(driver ? { 'x-e2e-key': config.controlKey } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json(); if (!response.ok || value.ok === false) throw new Error(value.message || value.error || `API ${response.status}`); return value
}
child.on('exit', async () => { exited = true; await writeFile(join(runDir, 'ui-host-redacted.log'), logs); console.log(JSON.stringify({ phase: 'ui-stopped', processId: child.pid })) })
process.on('SIGINT', () => child.kill('SIGINT')); process.on('SIGTERM', () => child.kill('SIGTERM'))
for (let attempt = 0; attempt < 90; attempt++) {
  if (exited) throw new Error('Isolated UI host stopped before ready')
  try { await json('/api/live-e2e/inspect'); break } catch { await sleep(500) }
}
const sessions = []
for (const task of config.tasks) {
  const created = await json('/api/live-e2e/create', { taskId: task.id })
  await json('/api/dsh-skill-detective/checkbox', { sessionId: created.sessionId, enabled: true }, false)
  sessions.push({ taskId: task.id, sessionId: created.sessionId, workspace: task.workspace })
}
await writeFile(join(runDir, 'ui-sessions.json'), JSON.stringify({ processId: child.pid, inferenceDisabled: true, sessions }, null, 2))
console.log(JSON.stringify({ phase: 'ui-ready', processId: child.pid, accessFile: join(runDir, 'ui-access.json'), sessionFile: join(runDir, 'ui-sessions.json'), inferenceDisabled: true }))
