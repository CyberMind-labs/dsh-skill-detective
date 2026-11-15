import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { extractToolReceipts } from './e2e-artifacts.mjs'

export const name = 'skill-detective-live-e2e-bridge'
export const inject = ['agents', 'agentPresets', 'llm', 'credentials', 'workingDirectory', 'workspaceRegistry', 'webServer']

const redact = value => String(value ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]').replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
const numberTree = value => typeof value === 'number' ? value : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, numberTree(item)]).filter(([, item]) => item !== undefined)) : undefined

/** Test-only driver around genuine DSH services. It never supplies model output. */
export function apply(ctx, config) {
  const context = new AsyncLocalStorage()
  const calls = [], credentialWrites = [], tasks = new Map()
  const byTrace = new Map()
  let active = null
  const responseIds = new Set(['x-request-id', 'request-id', 'x-dsh-request-id', 'x-ds-request-id', 'x-trace-id', 'trace-id'])
  const network = message => {
    const record = byTrace.get(context.getStore())
    if (!record) return
    const path = String(message.request?.path || '').split('?')[0]
    if (!/messages|completions/.test(path)) return
    const headers = message.response?.headers || []
    const requestIds = {}
    for (let index = 0; index + 1 < headers.length; index += 2) {
      const key = String(headers[index]).toLowerCase()
      if (responseIds.has(key)) requestIds[key] = String(headers[index + 1])
    }
    record.httpResponses.push({ path, status: message.response?.statusCode, requestIds })
  }
  channel('undici:request:headers').subscribe(network)
  ctx.effect(() => () => channel('undici:request:headers').unsubscribe(network), 'live e2e metadata observer')
  ctx.effect(() => ctx.on('credentials/reference-updated', ref => credentialWrites.push({ kind: 'reference', name: String(ref) })), 'live e2e credential write audit')
  ctx.effect(() => ctx.on('credentials/record-updated', key => credentialWrites.push({ kind: 'record', name: String(key) })), 'live e2e credential record audit')
  ctx.effect(() => ctx.on('llm/stream', (options, next) => {
    const task = active
    const trace = { source: 'host-llm-stream-pass-through', traceId: randomUUID(), taskId: task?.id || null, stage: task?.phase || 'unattributed', sessionId: options.sessionId || task?.sessionId || null, provider: options.provider, model: options.model, maxTokens: options.maxTokens, startedAt: Date.now(), chunkTypes: [], usage: null, finish: null, httpResponses: [] }
    calls.push(trace); byTrace.set(trace.traceId, trace)
    if (task && calls.filter(call => call.taskId === task.id).length > config.maxCallsPerTask) {
      trace.dispatchAttempted = false; trace.error = 'LIVE_E2E_MODEL_CALL_BUDGET_EXCEEDED'; trace.endedAt = Date.now()
      throw new Error(trace.error)
    }
    trace.dispatchAttempted = true
    return (async function* () {
      const iterator = next()[Symbol.asyncIterator]()
      try {
        while (true) {
          const step = await context.run(trace.traceId, () => iterator.next())
          if (step.done) break
          const chunk = step.value
          if (!trace.chunkTypes.includes(chunk.type)) trace.chunkTypes.push(chunk.type)
          if (typeof chunk.requestId === 'string') trace.providerRequestId = chunk.requestId
          if (chunk.type === 'usage') trace.usage = numberTree(chunk.usage)
          if (chunk.type === 'finish') trace.finish = { kind: chunk.reason?.kind, code: chunk.reason?.failure?.code, status: chunk.reason?.failure?.status, requestId: chunk.reason?.failure?.requestId, message: chunk.reason?.failure?.message ? redact(chunk.reason.failure.message) : undefined }
          yield chunk
        }
      } catch (error) { trace.error = redact(error.message); throw error }
      finally { trace.endedAt = Date.now(); trace.requestIdAvailability = trace.providerRequestId || trace.httpResponses.some(response => Object.keys(response.requestIds).length) ? 'observed' : 'not-exposed-by-host'; await writeFile(join(config.runDir, config.modelMetadataFile || 'model-call-metadata.json'), JSON.stringify(calls, null, 2)) }
    })()
  }, { prepend: true }), 'live e2e transparent model observer')

  const { createUserMessage } = awaitImport(config.runtimeModules, '@deepseek-ai/dsh-llm/lib/index.js')
  function receipts(agent) {
    return extractToolReceipts(agent.session.snapshotEvents(0))
  }
  async function createTask(id) {
    const spec = config.tasks.find(task => task.id === id)
    if (!spec) throw new Error('Unknown fixed E2E task')
    if (tasks.has(id)) return tasks.get(id)
    const selected = ctx.get('agentDefaultModel').currentSelection()
    const preset = ctx.get('agentPresets'), resolved = await preset.resolve('standard')
    const sessionId = `session-e2e-${id}-${randomUUID()}`
    const handle = await ctx.get('agents').create({ sessionId, seed: [], meta: { cwd: spec.workspace, agentPreset: resolved.id }, agentOptions: { ...selected, maxTokens: config.mainMaxTokens }, setup: async agentCtx => { await preset.mount(agentCtx, resolved.id) } })
    const agent = ctx.get('agents').get(sessionId)
    if (!agent || handle.agent !== agent || agent.session.id !== sessionId) throw new Error('Actual host agent identity mismatch')
    ctx.effect(() => () => handle.dispose(), 'live e2e task lifetime')
    const workspace = await ctx.get('workspaceRegistry').create(spec.workspace, `E2E ${id}`)
    await workspace.attachSession(sessionId)
    const task = { ...spec, sessionId, agent, phase: 'created', run: null }
    tasks.set(id, task); active = task
    return task
  }
  async function start(task) {
    if (task.run) throw new Error('A fixed task may only run once')
    active = task; task.phase = 'agent-task'
    task.startedAt = Date.now()
    task.run = (async () => {
      const helpers = await createUserMessage
      task.agent.followup(helpers({ content: [{ type: 'text', text: task.prompt }], source: { kind: 'user' } }))
      let timer
      try {
        await Promise.race([task.agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => { task.agent.cancel({ kind: 'interrupted' }); reject(new Error('LIVE_E2E_TASK_DEADLINE')) }, config.taskTimeoutMs) })])
        const events = task.agent.session.snapshotEvents(0)
        const final = events.filter(event => event.type === 'assistant/message').at(-1)?.data.message
        const finalText = final?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') || ''
        task.outcome = { endedAt: Date.now(), turnEnd: events.filter(event => event.type === 'turn/end').at(-1)?.data, finalText, toolReceipts: receipts(task.agent), modelCalls: calls.filter(call => call.taskId === task.id) }
      } catch (error) { task.outcome = { endedAt: Date.now(), error: redact(error.message), toolReceipts: receipts(task.agent), modelCalls: calls.filter(call => call.taskId === task.id) } }
      finally { clearTimeout(timer) }
      await writeFile(join(config.runDir, task.id, 'execution.json'), JSON.stringify(task.outcome, null, 2))
    })()
  }
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
  ctx.effect(() => ctx.get('webServer').register({ kind: 'prefix', path: '/api/live-e2e', handler: async (req, res) => {
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress) || req.headers['x-e2e-key'] !== config.controlKey) return send(res, 403, { ok: false })
    try {
      const route = new URL(req.url, config.origin).pathname.slice('/api/live-e2e'.length)
      let body = {}
      if (req.method === 'POST') {
        const chunks = []; let bytes = 0
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw new Error('Oversized fixed driver request'); chunks.push(chunk) }
        body = JSON.parse(Buffer.concat(chunks).toString())
      }
      if (route === '/inspect' && req.method === 'GET') {
        const selected = ctx.get('agentDefaultModel').currentSelection()
        const credential = await ctx.get('credentials').describe('DEEPSEEK_API_KEY')
        const models = await ctx.get('llm').listModels(selected.provider)
        return send(res, 200, { ok: true, selected, credential: { configured: credential.configured, source: credential.source }, providers: ctx.get('llm').listProviders().map(item => ({ id: item.id })), models: models.map(model => ({ id: model.id })), inferenceCalls: calls.length, credentialWrites })
      }
      if (route === '/create' && req.method === 'POST') {
        const task = await createTask(body.taskId)
        const definition = task.agent.ctx.get('tools').get('dsh_file_task', task.agent)
        return send(res, 200, { ok: true, sessionId: task.sessionId, workspace: task.workspace,
          toolAvailable: Boolean(definition), operations: definition?.parameters?.properties?.operation?.enum || [] })
      }
      const task = tasks.get(body.taskId || new URL(req.url, config.origin).searchParams.get('taskId'))
      if (!task) throw new Error('Fixed task has not been created')
      if (route === '/phase' && req.method === 'POST') { if (!['analysis', 'install', 'agent-task'].includes(body.phase)) throw new Error('Invalid phase'); active = task; task.phase = body.phase; return send(res, 200, { ok: true }) }
      if (route === '/visible' && req.method === 'GET') { const skills = await task.agent.ctx.get('skills').list({ cwd: task.workspace, scope: task.agent }); return send(res, 200, { ok: true, skills: skills.map(skill => ({ name: skill.name, path: skill.path })) }) }
      if (route === '/run' && req.method === 'POST') { await start(task); return send(res, 200, { ok: true }) }
      if (route === '/result' && req.method === 'GET') return send(res, 200, { ok: true, running: Boolean(task.run && !task.outcome), outcome: task.outcome || null, calls: calls.filter(call => call.taskId === task.id), credentialWrites })
      return send(res, 404, { ok: false })
    } catch (error) { return send(res, 500, { ok: false, error: redact(error.message) }) }
  } }), 'live e2e fixed task driver')
}

function awaitImport(root, path) {
  const module = import(pathToFileURL(join(root, path)).href)
  return { createUserMessage: module.then(value => value.createUserMessage) }
}
