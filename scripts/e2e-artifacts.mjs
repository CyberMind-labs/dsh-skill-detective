import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Correlate the host's real toolCallId and JSON argument wire format. */
export function extractToolReceipts(events) {
  const results = new Map(events.filter(event => event.type === 'tool/result').map(event => [event.data.message.toolCallId, event]))
  return events.filter(event => event.type === 'tool/call').map(event => {
    const result = results.get(event.data.callId)
    let args = event.data.arguments
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = null } }
    const text = result?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    let value = null
    if (text) { try { value = JSON.parse(text) } catch { /* Skill/read output is text, not a JSON tool value. */ } }
    return { source: 'genuine-agent-session-log', callSeq: event.seq, resultSeq: result?.seq, name: event.data.name, arguments: args,
      result: result ? { isError: result.data.message.isError === true, meta: result.data.meta, text, value } : null }
  })
}

/** Independent assertions over sealed fixture identities and generated files. */
export async function checkArtifact(task, fixtureRoot, expectations) {
  const checks = [], expect = (label, ok, actual) => checks.push({ label, passed: Boolean(ok), actual })
  let text
  try { text = await readFile(task.outputPath, 'utf8') }
  catch (error) { return [{ label: 'requested output exists', passed: false, actual: error.code }] }
  if (task.id === 'repo-inventory') {
    const entries = await Promise.all(expectations.files.map(async path => ({ path, bytes: (await readFile(join(fixtureRoot, path))).length })))
    expect('file count is exact', new RegExp(`文件数[：:]\\s*${entries.length}(?:\\D|$)`).test(text), entries.length)
    expect('directory count excludes the input root', new RegExp(`目录数[：:]\\s*${expectations.directoryCount}(?:\\D|$)`).test(text), expectations.directoryCount)
    const total = entries.reduce((sum, file) => sum + file.bytes, 0)
    expect('total bytes match sealed source files', new RegExp(`总字节[：:]\\s*${total}(?:\\D|$)`).test(text), total)
    for (const entry of entries) expect(`exact file and byte row: ${entry.path}`, text.split(/\r?\n/).some(line => line.includes(entry.path) && line.split('|').some(cell => cell.trim() === String(entry.bytes))), entry.bytes)
    expect('inventory has no model-invented path rows', text.split(/\r?\n/).filter(line => /^\|[^|]+\|\s*\d+\s*\|$/.test(line)).every(line => entries.some(entry => line.includes(entry.path))), null)
  } else if (task.id === 'todo-report') {
    expect('marker count is exact', new RegExp(`标记数[：:]\\s*${expectations.markers.length}(?:\\D|$)`).test(text), expectations.markers.length)
    for (const marker of expectations.markers) expect(`exact marker location ${marker.path}:${marker.line}:${marker.marker}`, text.split(/\r?\n/).some(line => line.includes(marker.path) && line.includes(marker.text) && line.split('|').some(cell => cell.trim() === String(marker.line))), marker)
  } else {
    const change = expectations.javascriptChange
    const original = await readFile(join(fixtureRoot, change.path), 'utf8')
    const actual = await readFile(join(task.repository, change.path), 'utf8')
    expect('only the authorized default string changed', actual === original.replace(change.from, change.to), actual === original ? 'unchanged' : 'changed')
    expect('report identifies a syntax check', /语法|syntax|--check/i.test(text), null)
    expect('report does not claim unit tests passed', !/(?:单元测试|unit tests?).{0,12}(?:通过|passed|success)/i.test(text), null)
  }
  for (const path of expectations.files) {
    if (task.id === 'javascript-check' && path === expectations.javascriptChange.path) continue
    const before = await readFile(join(fixtureRoot, path)), after = await readFile(join(task.repository, path))
    expect(`unrelated source unchanged: ${path}`, before.equals(after), null)
  }
  const actualPaths = []
  async function walk(path, prefix = '') {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const label = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) await walk(join(path, item.name), label)
      else actualPaths.push(item.isFile() ? label : `unsupported:${label}`)
    }
  }
  await walk(task.repository)
  expect('repository has exactly the sealed file identities', JSON.stringify(actualPaths.sort()) === JSON.stringify([...expectations.files].sort()), actualPaths)
  return checks
}

/** Missing observed stages remain failures even if an output file looks right. */
export function assessClosedLoop(record) {
  const checks = [], add = (label, passed) => checks.push({ label, passed: Boolean(passed) })
  add('run is explicitly live', record.runMode === 'live' && record.model?.provider === 'deepseek-official')
  add('actual inference was observed', record.modelCalls?.some(call => call.source === 'host-llm-stream-pass-through' && call.usage?.inputTokens > 0 && call.usage?.outputTokens > 0 && call.chunkTypes?.includes('finish') && call.finish?.kind === 'stop'))
  add('real model selected the matching catalog entry', record.analysis?.source === 'llm' && record.analysis.error === null && record.analysis.actionable === true && record.analysis.need === `catalog:${record.expectedSkill}`)
  add('agent conversation completed within the test budget', !record.executionError && record.turnEnd?.reason?.kind === 'completed')
  add('full final directory was audited', record.audit?.status === 'current' && record.audit.scope === 'full-directory' && /^[a-f0-9]{64}$/.test(record.audit.fingerprint || '') && Boolean(record.audit.model))
  const loaded = record.toolReceipts?.find(receipt => receipt.name === 'skill' && receipt.arguments?.name === record.expectedSkill && receipt.result && receipt.result.isError === false)
  add('host skill tool actually loaded the selected skill', loaded?.source === 'genuine-agent-session-log')
  const executed = record.toolReceipts?.find(receipt => receipt.name === 'dsh_file_task' && receipt.arguments?.operation === record.operation && receipt.result && receipt.result.isError === false && receipt.result.value?.ok === true && receipt.result.value?.operation === record.operation && typeof receipt.arguments.output_path === 'string' && typeof receipt.result.value.outputPath === 'string' && typeof record.outputPath === 'string' && resolve(receipt.arguments.output_path) === resolve(record.outputPath) && resolve(receipt.result.value.outputPath) === resolve(record.outputPath) && receipt.callSeq > loaded?.callSeq)
  add('real controlled task operation ran after skill loading', executed?.source === 'genuine-agent-session-log')
  if (record.operation === 'javascript-check') add('syntax parser succeeded without executing repository code', executed?.result.value.summary?.syntaxPassed === true && executed.result.value.summary.executedCode === false)
  add('independent artifact checks all pass', record.artifactChecks?.length > 0 && record.artifactChecks.every(check => check.passed))
  return { passed: checks.every(check => check.passed), checks }
}
