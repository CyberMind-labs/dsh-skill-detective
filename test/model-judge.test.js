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
  const llm = {
    listProviders: () => [{ id: 'fixture-provider' }],
    stream(request) {
      requests.push(request)
      const response = responses[requests.length - 1]
      if (response === undefined) throw new Error('UNEXPECTED_EXTRA_MODEL_ATTEMPT')
      return (async function* () {
        if (response instanceof Error) throw response
        yield* response
      })()
    },
  }
  const ctx = { get(name) { return name === 'llm' ? llm : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-reasoning-model' }) } : undefined }, logger: { info() {} } }
  const judge = new __test.SkillDetective(ctx).judge
  return { judge, requests }
}

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
