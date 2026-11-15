import test from 'node:test'
import assert from 'node:assert/strict'
import { assessClosedLoop, extractToolReceipts } from '../scripts/e2e-artifacts.mjs'

// These only test the acceptance validator; they make no live-model claim.
const complete = () => ({
  runMode: 'live', model: { provider: 'deepseek-official' },
  expectedSkill: 'safe-repo-inventory', operation: 'repo-inventory', outputPath: '/report.md',
  modelCalls: [{ source: 'host-llm-stream-pass-through', usage: { inputTokens: 100, outputTokens: 20 }, chunkTypes: ['finish'], finish: { kind: 'stop' } }],
  turnEnd: { reason: { kind: 'completed' } },
  analysis: { source: 'llm', error: null, actionable: true, need: 'catalog:safe-repo-inventory' },
  audit: { status: 'current', scope: 'full-directory', fingerprint: 'a'.repeat(64), model: 'metadata-only-fixture' },
  toolReceipts: [
    { source: 'genuine-agent-session-log', callSeq: 1, name: 'skill', arguments: { name: 'safe-repo-inventory' }, result: { isError: false } },
    { source: 'genuine-agent-session-log', callSeq: 3, name: 'dsh_file_task', arguments: { operation: 'repo-inventory', output_path: '/report.md' }, result: { isError: false, value: { ok: true, operation: 'repo-inventory', outputPath: '/report.md' } } },
  ],
  artifactChecks: [{ passed: true }],
})

test('acceptance validator rejects stub mode despite an apparently correct artifact', () => {
  assert.equal(assessClosedLoop({ ...complete(), runMode: 'stub' }).passed, false)
})
test('acceptance validator rejects missing skill load or missing actual inference', () => {
  const noLoad = complete(); noLoad.toolReceipts.shift()
  assert.equal(assessClosedLoop(noLoad).passed, false)
  assert.equal(assessClosedLoop({ ...complete(), modelCalls: [] }).passed, false)
})
test('acceptance validator rejects rejected audits, tool errors and wrong artifacts', () => {
  assert.equal(assessClosedLoop({ ...complete(), audit: { status: 'rejected' } }).passed, false)
  const denied = complete(); denied.toolReceipts[1].result.isError = true
  assert.equal(assessClosedLoop(denied).passed, false)
  assert.equal(assessClosedLoop({ ...complete(), artifactChecks: [{ passed: false }] }).passed, false)
})
test('complete evidence-shaped metadata satisfies the validator schema only', () => {
  assert.equal(assessClosedLoop(complete()).passed, true)
})
test('actual host wire shape correlates string arguments and toolCallId', () => {
  const receipts = extractToolReceipts([
    { type: 'tool/call', seq: 2, data: { callId: 'a', name: 'dsh_file_task', arguments: '{"operation":"repo-inventory"}' } },
    { type: 'tool/result', seq: 3, data: { message: { toolCallId: 'a', isError: false, content: [{ type: 'text', text: '{"ok":true,"operation":"repo-inventory"}' }] } } },
  ])
  assert.equal(receipts[0].arguments.operation, 'repo-inventory')
  assert.equal(receipts[0].result.value.ok, true)
  assert.equal(receipts[0].resultSeq, 3)
})
test('well-formed tool result with ok false never counts as task success', () => {
  const record = complete(); record.toolReceipts[1].result.value.ok = false
  assert.equal(assessClosedLoop(record).passed, false)
})
test('an exact artifact does not hide an interrupted final conversation', () => {
  const record = complete(); record.turnEnd.reason = { kind: 'error', error: { message: 'test budget' } }
  assert.equal(assessClosedLoop(record).passed, false)
})
test('a tool result for a different output path cannot establish artifact provenance', () => {
  const record = complete(); record.toolReceipts[1].result.value.outputPath = '/other.md'
  assert.equal(assessClosedLoop(record).passed, false)
})
