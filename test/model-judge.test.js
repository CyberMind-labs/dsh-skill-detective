import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

// These are synthetic host-protocol chunks. No provider, credential or network
// is used; the terminal shape matches the shipped DSH stream API.
const finish = kind => ({ type: 'finish', reason: { kind } })
const text = value => ({ type: 'text-delta', index: 0, text: value })
const limited = partial => [
  { type: 'reasoning-delta', index: 0, text: 'Synthetic reasoning budget consumed' },
  ...(partial ? [text(partial)] : []),
  { type: 'usage', usage: { inputTokens: 20, outputTokens: 400, totalTokens: 420 } },
  finish('max-tokens'),
]
const options = { system: 'Return one JSON object.', user: 'Synthetic classification fixture.', maxTokens: 400, temperature: 0, sessionId: 'fixture-session' }

function fixture(responses) {
  const requests = []
  const state = {
    selection: { provider: 'fixture-provider', model: 'fixture-reasoning-model', reasoningEffort: 'max' },
    agents: new Map(), pending: new Map(), unavailable: new Set(),
  }
  const llm = {
    listProviders: () => [{ id: 'fixture-provider' }],
    listModels: async () => [{ id: 'fixture-fast-model' }],
    resolveModelInfo: async () => ({}),
    stream(request) {
      requests.push(request)
      const response = responses[requests.length - 1]
      if (response === undefined) throw new Error('UNEXPECTED_EXTRA_MODEL_ATTEMPT')
      return (async function* () {
        if (response instanceof Error) throw response
        yield* (typeof response === 'function' ? response() : response)
      })()
    },
  }
  const services = {
    llm,
    agentDefaultModel: { currentSelection: () => state.selection },
    agents: { get: id => state.agents.get(id) },
    sessionProjections: { stateOf: (session, key) => {
      assert.equal(key, 'modelSelection')
      return { pending: state.pending.get(session.id) ?? null }
    } },
  }
  const ctx = { get(name) {
    if (state.unavailable.has(name)) throw new Error('Synthetic unavailable host service')
    return services[name]
  }, logger: { info() {} } }
  const judge = new __test.SkillDetective(ctx).judge
  return { judge, requests, state }
}

function session(f, id, created, header) {
  const agent = { options: created, session: { id, requestHeader: () => agent.header }, header }
  f.state.agents.set(id, agent)
  return agent
}

const complete = () => [text('{"ok":true}'), finish('stop')]

test('the configured maximum reasoning effort reaches the actual auxiliary stream request', async () => {
  const f = fixture([complete()])
  assert.equal((await f.judge.call(options)).ok, true)
  assert.equal(f.requests[0].reasoningEffort, 'max')
})

test('a live session inherits its own creation route and effort rather than the global default', async () => {
  const f = fixture([complete()])
  session(f, options.sessionId, { provider: 'session-provider', model: 'session-model', reasoningEffort: 'low' })
  await f.judge.call(options)
  assert.equal(f.requests[0].provider, 'session-provider')
  assert.equal(f.requests[0].model, 'session-model')
  assert.equal(f.requests[0].reasoningEffort, 'low')
})

test('pending GUI selection overrides stale headers and creation options without a cached delay', async () => {
  const f = fixture([complete(), complete(), complete()])
  const agent = session(f, options.sessionId, f.state.selection, {
    config: { provider: 'old-provider', model: 'old-model', reasoningEffort: 'low' },
  })
  f.state.pending.set(options.sessionId, { provider: 'gui-provider', model: 'gui-model', reasoningEffort: 'max' })
  await f.judge.call(options)
  f.state.pending.set(options.sessionId, { provider: 'gui-provider', model: 'other-model' })
  await f.judge.call(options)
  f.state.pending.delete(options.sessionId)
  agent.header = { config: { provider: 'used-provider', model: 'used-model', reasoningEffort: 'high' } }
  await f.judge.call(options)
  assert.deepEqual(f.requests.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [
    { provider: 'gui-provider', model: 'gui-model', reasoningEffort: 'max' },
    { provider: 'gui-provider', model: 'other-model', reasoningEffort: undefined },
    { provider: 'used-provider', model: 'used-model', reasoningEffort: 'high' },
  ])
  assert.equal(Object.hasOwn(f.requests[1], 'reasoningEffort'), false)
})

test('live default changes and clearing effort take effect immediately', async () => {
  const f = fixture([complete(), complete(), complete()])
  await f.judge.call(options)
  f.state.selection = { provider: 'changed-provider', model: 'changed-model', reasoningEffort: 'low' }
  await f.judge.call(options)
  delete f.state.selection.reasoningEffort
  await f.judge.call(options)
  assert.deepEqual(f.requests.map(r => [r.provider, r.model, r.reasoningEffort]), [
    ['fixture-provider', 'fixture-reasoning-model', 'max'],
    ['changed-provider', 'changed-model', 'low'],
    ['changed-provider', 'changed-model', undefined],
  ])
  assert.equal(Object.hasOwn(f.requests[2], 'reasoningEffort'), false)
})

test('different sessions never borrow the preceding session route or effort', async () => {
  const f = fixture([complete(), complete(), complete()])
  session(f, 'session-a', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'max' })
  session(f, 'session-b', { provider: 'provider-b', model: 'model-b' })
  await f.judge.call({ ...options, sessionId: 'session-a' })
  await f.judge.call({ ...options, sessionId: 'session-b' })
  await f.judge.call({ ...options, sessionId: 'session-a' })
  assert.deepEqual(f.requests.map(r => [r.provider, r.model, r.reasoningEffort]), [
    ['provider-a', 'model-a', 'max'], ['provider-b', 'model-b', undefined], ['provider-a', 'model-a', 'max'],
  ])
})

test('an adapter-default header does not turn a previous default effort into an explicit override', async () => {
  const f = fixture([complete()])
  session(f, options.sessionId, f.state.selection, {
    config: { provider: 'session-provider', model: 'session-model', reasoningEffort: 'high' },
    adapterDefaults: { reasoningEffort: true },
  })
  await f.judge.call(options)
  assert.equal(f.requests[0].model, 'session-model')
  assert.equal(Object.hasOwn(f.requests[0], 'reasoningEffort'), false)
})

test('unavailable optional host APIs fall back to the live default without borrowing partial selections', async () => {
  const f = fixture([complete(), complete()])
  f.state.unavailable.add('agents')
  await f.judge.call(options)
  assert.equal(f.requests[0].reasoningEffort, 'max')
  f.state.unavailable.clear()
  f.state.unavailable.add('sessionProjections')
  session(f, options.sessionId, { reasoningEffort: 'low' })
  f.state.selection = { provider: 'fallback-provider', model: 'fallback-model' }
  await f.judge.call(options)
  assert.equal(f.requests[1].provider, 'fallback-provider')
  assert.equal(Object.hasOwn(f.requests[1], 'reasoningEffort'), false)
})

test('unconfigured discovery has no effort override and cannot hide a later explicit selection', async () => {
  const f = fixture([complete(), complete()])
  f.state.selection = null
  await f.judge.call(options)
  assert.equal(f.requests[0].model, 'fixture-fast-model')
  assert.equal(Object.hasOwn(f.requests[0], 'reasoningEffort'), false)
  f.state.selection = { provider: 'fixture-provider', model: 'selected-model', reasoningEffort: 'max' }
  await f.judge.call(options)
  assert.equal(f.requests[1].model, 'selected-model')
  assert.equal(f.requests[1].reasoningEffort, 'max')
})

test('unreadable session configuration falls back safely to the live default', async () => {
  const f = fixture([complete()])
  f.state.unavailable.add('sessionProjections')
  f.state.agents.set(options.sessionId, {
    session: { id: options.sessionId, requestHeader() { throw new Error('Synthetic unavailable header') } },
    get options() { throw new Error('Synthetic unavailable creation options') },
  })
  assert.equal((await f.judge.call(options)).ok, true)
  assert.equal(f.requests[0].provider, 'fixture-provider')
  assert.equal(f.requests[0].reasoningEffort, 'max')
})

test('a JSON retry retains its route snapshot while the session selection changes', async () => {
  const f = fixture([() => {
    const pending = f.state.pending.get(options.sessionId)
    Object.assign(pending, { provider: 'changed-provider', model: 'changed-model', reasoningEffort: 'low' })
    return limited()
  }, complete(), complete()])
  session(f, options.sessionId, f.state.selection)
  f.state.pending.set(options.sessionId, { provider: 'first-provider', model: 'first-model', reasoningEffort: 'max' })
  assert.equal((await f.judge.json(options)).ok, true)
  await f.judge.call(options)
  assert.deepEqual(f.requests.map(r => [r.provider, r.model, r.reasoningEffort]), [
    ['first-provider', 'first-model', 'max'], ['first-provider', 'first-model', 'max'],
    ['changed-provider', 'changed-model', 'low'],
  ])
})

test('call preserves a real max-token terminal signal when all output was reasoning', async () => {
  const f = fixture([limited()])
  const result = await f.judge.call(options)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'model-output-limit')
  assert.equal(result.finishKind, 'max-tokens')
  assert.equal(f.requests.length, 1)
})

test('empty max-token JSON gets exactly one bounded larger attempt on the same route', async () => {
  const f = fixture([limited(), [text('{"actionable":true}'), finish('stop')]])
  const result = await f.judge.json(options)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.data, { actionable: true })
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests[1].maxTokens >= 1_200 && f.requests[1].maxTokens <= 2_000)
  assert.ok(f.requests[1].maxTokens > f.requests[0].maxTokens)
  for (const key of ['provider', 'model', 'sessionId', 'temperature', 'reasoningEffort']) assert.equal(f.requests[1][key], f.requests[0][key], `retry preserves ${key}`)
  assert.equal(f.requests[0].provider, 'fixture-provider')
  assert.equal(f.requests[0].model, 'fixture-reasoning-model')
  assert.equal(f.requests[0].sessionId, 'fixture-session')
  assert.equal(f.requests[0].reasoningEffort, 'max')
  assert.deepEqual(f.requests[1].messages, f.requests[0].messages)
})

test('partially emitted JSON with a max-token terminal signal uses only one larger retry', async () => {
  const f = fixture([limited('{"actionable":'), [text('{"actionable":false}'), finish('stop')]])
  const result = await f.judge.json(options)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { actionable: false })
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests[1].maxTokens >= 1_200 && f.requests[1].maxTokens <= 2_000)
})

test('valid complete JSON remains usable at a max-token boundary without another charge', async () => {
  const f = fixture([[text('{"actionable":true}'), finish('max-tokens')]])
  const result = await f.judge.json(options)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { actionable: true })
  assert.equal(result.finishKind, 'max-tokens')
  assert.equal(f.requests.length, 1)
})

test('two consecutive max-token failures remain failures without a third attempt', async () => {
  const f = fixture([limited(), limited()])
  const result = await f.judge.json(options)
  assert.equal(result.ok, false)
  assert.equal(result.finishKind, 'max-tokens')
  assert.equal(f.requests.length, 2)
})

test('empty normal finishes, provider errors, aborts and throws never trigger a token retry', async () => {
  for (const response of [
    [finish('stop')],
    [{ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'Synthetic quota error' } } }],
    [text('{"partial":"must not become success"}'), { type: 'finish', reason: { kind: 'error', failure: { message: 'Synthetic provider failure' } } }],
    [finish('aborted')],
    new Error('Synthetic transport failure'),
    Object.assign(new Error('Synthetic abort'), { name: 'AbortError' }),
    [],
  ]) {
    const f = fixture([response])
    const result = await f.judge.json(options)
    assert.equal(result.ok, false)
    assert.equal(f.requests.length, 1)
  }
})

test('ordinary non-JSON text keeps its existing single bounded formatting retry', async () => {
  const f = fixture([[text('not JSON'), finish('stop')], [text('{"fixed":true}'), finish('stop')]])
  const result = await f.judge.json(options)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { fixed: true })
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests[1].maxTokens <= 1_200)
})

test('a format retry that itself hits the token limit cannot add a third attempt', async () => {
  const f = fixture([[text('not JSON'), finish('stop')], limited()])
  const result = await f.judge.json(options)
  assert.equal(result.ok, false)
  assert.equal(result.finishKind, 'max-tokens')
  assert.equal(f.requests.length, 2)
})

test('a token retry producing invalid ordinary JSON fails without a format third attempt', async () => {
  const f = fixture([limited(), [text('still not JSON'), finish('stop')]])
  const result = await f.judge.json(options)
  assert.equal(result.ok, false)
  assert.equal(f.requests.length, 2)
})
