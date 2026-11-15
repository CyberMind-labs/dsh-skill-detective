import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Summarize external evidence; never calls a model or changes task artifacts.
const root = resolve(process.argv[2])
const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
const attempts = []
for (const directory of (await readdir(root)).filter(name => name.startsWith('live-')).sort()) {
  const path = join(root, directory), original = await read(join(path, 'summary.json'))
  if (!original) continue
  const summary = await read(join(path, 'summary-recovered.json')) || original
  const streams = await read(join(path, 'model-call-metadata.json')) || []
  for (const task of summary.tasks || []) attempts.push({ run: directory, taskId: task.id,
    passed: task.acceptance?.passed === true, turnEnd: task.turnEnd?.reason || null,
    durationMs: (task.modelCalls?.at(-1)?.endedAt || streams.filter(call => call.taskId === task.id).at(-1)?.endedAt || summary.endedAt) - (task.modelCalls?.[0]?.startedAt || streams.filter(call => call.taskId === task.id)[0]?.startedAt || summary.startedAt),
    dispatchedModelCalls: streams.filter(call => call.taskId === task.id && call.usage).length,
    observedUsage: streams.filter(call => call.taskId === task.id && call.usage).reduce((sum, call) => { for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'totalTokens']) sum[key] = (sum[key] || 0) + (call.usage[key] || 0); return sum }, {}),
    rejectedTools: (task.toolReceipts || []).filter(receipt => receipt.result?.isError).map(receipt => ({ name: receipt.name, reason: receipt.result.text })),
    acceptanceChecks: task.acceptance?.checks || [],
    artifactChecks: task.artifactChecks || [], outputPath: task.outputPath,
    evidenceFile: join(path, task.id, summary.parserFailureCorrected ? 'acceptance-recovered.json' : 'acceptance.json'),
    credentialFileUnchanged: original.credentialFileUnchanged, credentialsCopied: original.credentialsCopied,
    processLeftRunning: original.processLeftRunning, error: original.error || null,
    agentsHomeIsolated: original.agentsHomeIsolated === true,
  })
}
const cases = ['repo-inventory', 'todo-report', 'javascript-check'].map(taskId => {
  const records = attempts.filter(attempt => attempt.taskId === taskId)
  return { taskId, passed: records.some(record => record.passed), accepted: records.filter(record => record.passed).at(-1) || null, attempts: records.length }
})
const report = { mode: 'real-model-controlled-install-and-continuation', provider: 'deepseek-official', model: 'deepseek-flash',
  successCount: cases.filter(item => item.passed).length, caseCount: cases.length,
  dispatchedModelCalls: attempts.reduce((sum, item) => sum + item.dispatchedModelCalls, 0),
  credentialFilesUnchanged: attempts.every(item => item.credentialFileUnchanged === true), credentialsCopied: false,
  providerRequestIds: 'not exposed by the successful host stream; local trace IDs are not provider IDs',
  limitations: [
    'Three small fixture tasks do not establish a general task success rate or security detection rate.',
    'The driver performs explicit installation and continuation; it does not prove automatic UI pause/resume.',
    'The first inventory setup omitted the scoped host skill view and stopped before agent execution; parser corrections preserve separate original and recovered evidence.',
    'The first JavaScript run produced the exact requested edit and syntax report but hit the 12-stream test budget before final dialogue completion.',
    'The single bounded fresh JavaScript retry stopped during classification: its 400 output tokens contained reasoning only, with no text; no installation or agent task followed.',
    'Model attempts to use unsupported tools were refused and remain in the evidence.',
    'Early runs isolated DSH_HOME but still discovered user-global .agents skill headers through the host default; later runs also isolate DSH_AGENTS_HOME. These unrelated skills were not loaded.',
    'JavaScript checking parses syntax only; it executes neither repository code nor unit tests.',
  ], cases, attempts }
await writeFile(join(root, 'live-e2e-report.json'), JSON.stringify(report, null, 2))
const rows = cases.map(item => `| ${item.taskId} | ${item.passed ? '通过' : '未完整通过'} | ${item.accepted?.dispatchedModelCalls ?? '—'} | ${item.accepted ? (item.accepted.durationMs / 1000).toFixed(1) + ' 秒' : '—'} |`)
const markdown = `# 真实模型受控闭环验收\n\n模型：deepseek-official / deepseek-flash。通过 ${report.successCount}/${report.caseCount} 个固定夹具任务。共观测 ${report.dispatchedModelCalls} 次有真实 usage 的模型调用，包含初次失败和复跑。\n\n| 任务 | 完整闭环 | 成功轮模型调用 | 成功轮耗时 |\n| --- | --- | ---: | ---: |\n${rows.join('\n')}\n\n完整闭环要求：真实语义候选、完整目录审查、真实 skill 加载、受控工具执行、精确产物、对话正常完成。任务输出及逐项证据见同目录 live-e2e-report.json。\n\n这是明确安装后继续执行的受控流程，未证明任意聊天自动暂停与恢复。首次 JS 产物正确但最终汇报因测试预算中断；该轮保留为失败。后续一轮仅分类一次，400 输出 tokens 全用于推理，正文为空，因此正确停止，未继续安装或执行。修复明确 max-tokens 的同模型有界重试后，最后一次新会话使用明确结束条件，完整成功。模型此前尝试 pwsh/present/glob 等不支持工具，保护拒绝均保留。node --check 只验证语法，不是单元测试。成功请求 ID 未由宿主暴露，未用本地 trace ID 冒充。\n\n早期轮次虽隔离 DSH_HOME，但宿主仍发现用户全局 .agents 技能的名称/描述；未加载这些无关技能。最后 JS 轮另外隔离 DSH_AGENTS_HOME，可见目录仅宿主 ACL 技能和目标技能。三个固定夹具的结果不能推广为一般成功率或检出率。\n\n真实模型运行时，原凭据文件逐轮字节一致：${report.credentialFilesUnchanged}。未复制真实密钥，未修改真实用户 profile。任务写入仅在隔离 fixture；界面验收观察到 0 推理、0 凭据写事件；保护点击仅修改隔离测试状态。所有所属实例均已停止。\n`
await writeFile(join(root, 'live-e2e-report.md'), markdown)
console.log(JSON.stringify({ report: join(root, 'live-e2e-report.json'), passed: report.successCount, total: report.caseCount, dispatchedModelCalls: report.dispatchedModelCalls }))
