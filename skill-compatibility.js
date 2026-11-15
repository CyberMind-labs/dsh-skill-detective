import { FILE_RECIPE_OPERATIONS, FILE_RECIPE_TOOL, readRecipeContract } from './file-recipes.js'

const VERSION = 1
const SCRIPT = /\.(?:py|pyw|js|cjs|mjs|jsx|ts|tsx|sh|bash|zsh|fish|ps1|bat|cmd|rb|pl|lua|r|go|rs|java|kt|swift|c|cc|cpp|cs|wasm|exe|dll|node)$/i
const DEPENDENCY = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(?:\.lock)?|Gemfile(?:\.lock)?|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|Dockerfile|Makefile)$/i
const NEGATION = /(?:禁止|无需|不要|不得|不允许|不应|不能|不需要|do not|must not|never|without|cannot).{0,32}$/i
const clip = value => String(value).trim().slice(0, 220)
const entry = (path, line, excerpt, kind) => ({ path, line, excerpt: clip(excerpt), kind })

/** Static observations are requirement evidence, not a proof of all behavior. */
export function analyzeSkillCompatibility(files, environment = {}, options = {}) {
  const basis = options.basis || 'full-directory'
  const complete = options.complete === true
  const requirements = []
  const knownPolicy = environment.protected === true && environment.toolMode === 'native'
  const capabilities = new Set(Array.isArray(environment.tools) ? environment.tools : [])
  const add = (capability, reason, evidence, requested = 'blocked') => {
    let existing = requirements.find(item => item.capability === capability)
    if (!existing) { existing = { capability, status: knownPolicy ? requested : 'unknown', reason, evidence: [] }; requirements.push(existing) }
    if (evidence && existing.evidence.length < 8) existing.evidence.push(evidence)
    return existing
  }
  const result = (status, summary) => ({ version: VERSION, status, summary, reason: summary,
    reasons: [...new Set([summary, ...requirements.map(item => item.reason)])],
    required: requirements.map(item => item.capability), requirements, basis, complete,
    checkedAt: Date.now(), effectValidation: 'unverified',
    environment: { protected: environment.protected === true, protectionMode: environment.protectionMode || null,
      toolMode: environment.toolMode || null, platform: environment.platform || null },
  })

  if (!complete || !Array.isArray(files) || !files.length) return result('unknown', '尚未取得完整技能目录，先检查实际文件与当前会话能力')
  if (files.length > 40 || files.some(file => !file || typeof file.path !== 'string' || typeof file.text !== 'string')
    || new Set(files.map(file => file.path)).size !== files.length || !files.some(file => file.path === 'SKILL.md')) return result('unknown', '完整文件输入缺失、重复或超出可核验范围')
  if (files.some(file => Buffer.byteLength(file.text, 'utf8') > 256 * 1024)
    || files.reduce((sum, file) => sum + Buffer.byteLength(file.text, 'utf8'), 0) > 512 * 1024) return result('unknown', '完整技能内容超过兼容性检查限额')

  const recipe = readRecipeContract(files)
  if (recipe.ok) {
    const evidence = entry('skill-detective.json', 1, JSON.stringify({ adapter: recipe.adapter, operations: recipe.operations }), 'verified-contract')
    const required = add(FILE_RECIPE_TOOL, '固定操作必须通过宿主受控文件工具执行', evidence, 'supported')
    if (!knownPolicy) return result('unknown', '先为有效原生工具会话开启运行保护，再检查受控操作是否可用')
    if (!capabilities.has(FILE_RECIPE_TOOL)) { required.status = 'blocked'; required.reason = '当前会话没有可核验的受控文件工具'; return result('blocked', required.reason) }
    if (!Array.isArray(environment.recipeOperations)) { required.status = 'unknown'; return result('unknown', '宿主尚未提供已验证的受控操作清单') }
    if (!environment.recipeOperations.includes(recipe.operation)) {
      required.status = 'blocked'; required.reason = `宿主未提供 ${recipe.operation} 的受限实现`
      return result('blocked', required.reason)
    }
    required.status = 'supported'
    return result('supported', '固定执行契约与宿主受限实现一致；仅表示执行路径支持，实际效果仍需验收')
  }

  for (const file of files) {
    if (SCRIPT.test(file.path) || file.mode === '100755') add('script-execution', '目录含脚本、可执行文件或可执行权限；当前保护不提供通用执行通道', entry(file.path, 1, file.path, 'file-type'))
    if (DEPENDENCY.test(file.path)) add('dependency-installation', '目录含依赖或构建清单；当前保护不会安装依赖或运行构建', entry(file.path, 1, file.path, 'manifest'))
    const lines = file.text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      const inspect = (pattern, capability, reason) => {
        const match = pattern.exec(line)
        if (!match) return
        const prefix = line.slice(0, match.index)
        if (NEGATION.test(prefix)) return
        add(capability, reason, entry(file.path, index + 1, line, 'instruction'))
      }
      inspect(/(?:\b(?:python(?:3)?|node|bash|zsh|pwsh|powershell|cmd\.exe|pandoc|ffmpeg|git|make|npm|pnpm|yarn|npx|uv|pip(?:3)?)\s+(?:--?[a-z]|[\w./\\])|(?:执行|运行|调用).{0,12}(?:脚本|命令|终端))/i,
        'script-execution', '正文包含命令或脚本执行步骤，受限会话会拒绝该执行通道')
      inspect(/(?:\b(?:curl|wget|web_fetch|web_search|fetch\s*\(|requests\.(?:get|post)|https?\.request)|(?:下载|访问|请求|上传|抓取|联网).{0,35}https?:\/\/|(?:调用|使用|打开).{0,12}(?:浏览器|互联网|网页搜索))/i,
        'network-access', '正文包含网络工具、请求或下载步骤，当前会话禁止外联工具')
      inspect(/(?:\b(?:pip(?:3)?|npm|pnpm|yarn|uv|cargo|go)\s+(?:install|add|get|build)\b|(?:安装|下载).{0,12}(?:依赖|软件包|工具链))/i,
        'dependency-installation', '正文要求安装依赖或构建，当前受限实现不支持此步骤')
      inspect(/\b(?:run_code|PTC)\b|\b(?:eval|exec)\s*\(/i,
        'arbitrary-code', '正文要求任意代码或 PTC 通道，当前保护明确拒绝')
      if (/https?:\/\//i.test(line) && !requirements.some(item => item.capability === 'network-access')) add('external-reference', '存在外部引用；单凭 URL 无法确认它只是文档还是运行依赖', entry(file.path, index + 1, line, 'reference'), 'unknown')
    }
  }
  if (files.some(file => file.path === 'skill-detective.json')) add('unverified-contract', recipe.reason || '执行契约无法验证', entry('skill-detective.json', 1, '未匹配宿主固定操作契约', 'invalid-contract'), 'unknown')
  if (!knownPolicy) return result('unknown', '尚未确认有效会话、原生工具模式与运行保护，不能判定执行兼容')
  if (requirements.some(item => item.status === 'blocked')) return result('blocked', '完整目录显示需要当前受限会话不支持的能力')
  return result('unknown', '自然语言技能缺少可逐项验证的封闭执行契约；没有命中限制词不代表已支持')
}

/** Consent never grants a blocked capability or removes runtime enforcement. */
export function compatibilityDecision(compatibility, { consent = false, protected: protectedSession = false } = {}) {
  if (compatibility?.status === 'blocked') return { ok: false, code: 'execution-incompatible', message: compatibility.reason, compatibility }
  if (compatibility?.status === 'supported') return { ok: true, compatibility }
  if (consent === true && protectedSession === true) return { ok: true, compatibility, restrictedTrial: true }
  return { ok: false, code: 'compatibility-confirmation-required', message: '执行兼容性无法确认；请先检查，再明确选择在现有运行保护下受限试用', compatibility }
}

export { FILE_RECIPE_OPERATIONS }
