import { readFile, readdir, writeFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractToolReceipts, checkArtifact, assessClosedLoop } from './e2e-artifacts.mjs'

// Reassess persisted genuine host events after a parser correction. No host,
// model call, tool invocation or artifact mutation is performed here.
const runDir = resolve(process.argv[2]), repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'))
const expectations = JSON.parse(await readFile(join(repo, 'fixtures/e2e/expectations.json'), 'utf8'))
const allFiles = await readdir(join(runDir, 'dsh-home/sessions'), { recursive: true })
for (const task of summary.tasks) {
  const file = allFiles.find(path => path.includes(task.sessionId) && path.endsWith('.zstd'))
  if (!file) throw new Error('No genuine persisted session log for task')
  let remaining = await readFile(join(runDir, 'dsh-home/sessions', file)), text = ''
  while (remaining.length) {
    const frame = zstdDecompressSync(remaining, { info: true })
    if (!(frame.engine.bytesWritten > 0)) throw new Error('Invalid host session compression frame')
    text += frame.buffer.toString('utf8'); remaining = remaining.subarray(frame.engine.bytesWritten)
  }
  const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  task.toolReceipts = extractToolReceipts(events)
  task.finalText = events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || ''
  task.artifactChecks = await checkArtifact(task, join(repo, 'fixtures/e2e/sample-repo'), expectations)
  task.acceptance = assessClosedLoop(task)
  task.evidenceReassessment = { source: 'persisted-genuine-host-session', reason: 'Corrected harness parser to use message.toolCallId and JSON argument wire format', performedAt: Date.now(), newModelCalls: 0 }
  await writeFile(join(runDir, task.id, 'acceptance-recovered.json'), JSON.stringify(task, null, 2))
}
summary.reassessedAt = Date.now(); summary.parserFailureCorrected = true
await writeFile(join(runDir, 'summary-recovered.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary.tasks.map(task => ({ task: task.id, passed: task.acceptance.passed, tools: task.toolReceipts.map(receipt => ({ name: receipt.name, isError: receipt.result?.isError, valueOk: receipt.result?.value?.ok })) }))))
