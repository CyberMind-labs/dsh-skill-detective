/** Bounded data transformations. No filesystem, network, shell or eval. */
export const FILE_RECIPE_TOOL = 'dsh_file_task'
export const FILE_RECIPE_LIMITS = Object.freeze({ inputBytes: 512 * 1024, rows: 10_000, columns: 100 })
const fail = message => Object.assign(new Error(message), { code: 'file-recipe-invalid' })
const record = value => value && typeof value === 'object' && !Array.isArray(value)

const specifications = Object.freeze({
  'repo-inventory': {
    id: 'safe-repo-inventory', title: '仓库文件清单', category: '开发',
    description: '在受限工作区内列出源码文件清单、数量与字节，不执行仓库代码。',
    body: '# 仓库文件清单\n\n仅检查用户明确指定的工作区目录。\n\n1. 确认目录，调用 dsh_file_task，operation 固定为 repo-inventory，input_path 为该目录。\n2. 用户要求保存时才传 output_path；否则展示工具返回的文件清单。\n3. 如实报告已扫描的文件数、目录数、字节数与被排除的范围；这不是完整依赖、安全或构建检查。\n4. 工具拒绝、目录超限或内容无法核验时明确报告失败，不改用其他执行通道。',
  },
  'todo-report': {
    id: 'safe-todo-report', title: '仓库 TODO 报告', category: '开发',
    description: '从受限源码目录汇总 TODO、FIXME、XXX 的文件、行号与文本。',
    body: '# 仓库 TODO 报告\n\n仅扫描用户明确指定的工作区源码目录。\n\n1. 确认目录，调用 dsh_file_task，operation 固定为 todo-report，input_path 为该目录。\n2. 用户要求保存时才传 output_path；否则展示工具返回的标记报告。\n3. 报告扫描范围、标记数量、文件路径、实际行号与原文；标记检索不代表代码语义或缺陷已经验证。\n4. 空报告只表示已扫描文本中没有这些标记，不能称为代码没有问题。工具拒绝或超限时明确报告失败，不改用其他执行通道。',
  },
  'javascript-check': {
    id: 'safe-javascript-check', title: 'JavaScript 语法检查', category: '开发',
    description: '使用宿主固定的 node --check 检查本地 JavaScript 语法，不执行仓库正文或测试。',
    body: '# JavaScript 语法检查\n\n仅检查用户明确指定的工作区 JavaScript 文件。\n\n1. 先读取用户指定的文件。仅在用户明确要求修改且会话允许写入时，使用原生文件工具做该修改。\n2. 调用 dsh_file_task，operation 固定为 javascript-check，input_path 为该 JavaScript 文件；不接受额外命令或参数。\n3. 用户要求保存报告时才传 output_path；否则展示工具结果。\n4. 该操作仅由宿主固定调用 node --check，不执行仓库正文、脚本、安装依赖或单元测试。通过只说明语法检查通过，不保证行为正确。\n5. 如实报告检查成功或失败及实际诊断；工具拒绝时不改用其他执行通道。',
  },
  'csv-profile': {
    id: 'safe-csv-profile', title: '本地 CSV 概况', category: '数据',
    description: '使用固定受控操作统计 CSV 行列、空值与数值范围；无需脚本或联网。',
    body: '# 本地 CSV 概况\n\n仅处理用户明确指定的工作区 CSV 文件。\n\n1. 确认输入文件，调用 dsh_file_task，operation 固定为 csv-profile，input_path 为该文件路径。\n2. 用户要求保存时才传 output_path；未指定时在回复中展示工具返回的概况。\n3. 根据返回结果报告数据行数、字段数、每列空值与数值范围。不得编造工具没有返回的统计。\n4. 文件不存在、格式无效或工具被拒绝时，明确报告失败；不改用其他执行通道。',
  },
  'csv-filter': {
    id: 'safe-csv-filter', title: '本地 CSV 筛选', category: '数据',
    description: '使用固定字段选择和字面值比较筛选 CSV，保留正确的引号与换行。',
    body: '# 本地 CSV 筛选\n\n仅处理用户明确指定的工作区 CSV 文件，不解释筛选表达式。\n\n1. 确认输入文件、输出字段、筛选条件及是否保存。\n2. 调用 dsh_file_task，operation 固定为 csv-filter，input_path 为输入文件路径。columns 可选，为按输出顺序排列的字段名数组。\n3. filter 可选，固定为 {column, operator, value}；operator 仅支持 eq、neq、contains、gt、gte、lt、lte，value 仅为字符串或有限数值。\n4. 用户要求保存时才传 output_path；否则展示工具返回的 CSV。报告输入和输出行数。\n5. 未知字段、重复表头、坏行或工具拒绝时明确报告失败，不改用其他执行通道。',
  },
  'markdown-outline': {
    id: 'safe-markdown-outline', title: '本地 Markdown 目录', category: '文档',
    description: '使用固定受控操作生成 Markdown 标题目录，忽略代码围栏中的标题。',
    body: '# 本地 Markdown 目录\n\n仅处理用户明确指定的工作区 Markdown 文件。\n\n1. 确认输入文件，调用 dsh_file_task，operation 固定为 markdown-outline，input_path 为该文件路径。\n2. 用户要求保存时才传 output_path；否则展示工具返回的目录。\n3. 目录按实际标题层级生成，跳过代码围栏和开头的文档元数据；重复标题使用顺序后缀。\n4. 报告实际发现的标题数。文件无法读取或工具拒绝时明确报告失败，不改用其他执行通道。',
  },
})

export const FILE_RECIPE_OPERATIONS = Object.freeze(Object.keys(specifications))
export const FILE_RECIPE_CATALOG = Object.freeze(Object.entries(specifications).filter(([operation]) => ['repo-inventory', 'todo-report', 'javascript-check'].includes(operation)).map(([operation, spec]) => Object.freeze({
  name: spec.id, version: '1.0.0', category: spec.category, author: 'CyberMind-labs', installs: 0,
  perm: 'files', source: `builtin/file-recipes/${operation}`, description: spec.description,
  whenToUse: spec.description, body: spec.body, recipeOperation: operation,
})))

export function buildRecipeFiles(operation, name = specifications[operation]?.id) {
  const spec = specifications[operation]
  if (!spec || typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw fail('未知受控操作或技能名')
  return [
    { path: 'SKILL.md', text: `---\nname: ${name}\ndescription: ${JSON.stringify(spec.description)}\n---\n\n${spec.body}\n` },
    { path: 'skill-detective.json', text: JSON.stringify({ version: 1, adapter: 'file-recipes', operations: [operation] }, null, 2) + '\n' },
  ]
}

/** The supported claim applies only to the exact host-owned instruction form. */
export function matchesRecipeInstructions(text, operation) {
  const spec = specifications[operation]
  const match = typeof text === 'string' && /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!spec || !match) return false
  const fields = new Map()
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description|disable-model-invocation): (.+)$/.exec(line)
    if (!field || fields.has(field[1])) return false
    fields.set(field[1], field[2])
  }
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.get('name') || '')
    && fields.get('description') === JSON.stringify(spec.description)
    && (!fields.has('disable-model-invocation') || /^(true|false)$/.test(fields.get('disable-model-invocation')))
    && match[2].trim().replaceAll('\r\n', '\n') === spec.body
}

export function readRecipeContract(files) {
  const rejected = reason => ({ ok: false, reason })
  if (!Array.isArray(files) || files.length !== 2 || files.some(file => !file || typeof file.path !== 'string' || typeof file.text !== 'string' || file.mode && file.mode !== '100644')) return rejected('受控操作只接受固定正文与完整契约文件')
  const main = files.find(file => file.path === 'SKILL.md'), manifest = files.find(file => file.path === 'skill-detective.json')
  if (!main || !manifest) return rejected('缺少固定正文或执行契约')
  let contract
  try { contract = JSON.parse(manifest.text) } catch { return rejected('执行契约不是有效 JSON') }
  if (!record(contract) || Object.keys(contract).some(key => !['version', 'adapter', 'operations'].includes(key))
    || contract.version !== 1 || contract.adapter !== 'file-recipes' || !Array.isArray(contract.operations)
    || contract.operations.length !== 1 || !FILE_RECIPE_OPERATIONS.includes(contract.operations[0])) return rejected('执行契约不是已实现的固定操作')
  const operation = contract.operations[0]
  if (!matchesRecipeInstructions(main.text, operation)) return rejected('技能正文与宿主固定操作说明不一致')
  return { ok: true, version: 1, adapter: 'file-recipes', operation, operations: [operation] }
}

function checkedText(input) {
  if (typeof input !== 'string' || input.includes('\0') || Buffer.byteLength(input, 'utf8') > FILE_RECIPE_LIMITS.inputBytes) throw fail('输入必须是限额内的完整文本')
  return input.startsWith('\uFEFF') ? input.slice(1) : input
}

/** Strict CSV fields, including quoted commas, escaped quotes and newlines. */
export function parseRecipeCsv(input) {
  const text = checkedText(input), rows = []
  let row = [], field = '', quoted = false, closed = false
  const endField = () => { row.push(field); field = ''; closed = false; if (row.length > FILE_RECIPE_LIMITS.columns) throw fail('CSV 字段数量超限') }
  const endRow = () => { endField(); rows.push(row); row = []; if (rows.length > FILE_RECIPE_LIMITS.rows + 1) throw fail('CSV 数据行数超限') }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++ }
        else { quoted = false; closed = true }
      } else field += char
      continue
    }
    if (char === ',') { endField(); continue }
    if (char === '\n' || char === '\r') {
      endRow(); if (char === '\r' && text[index + 1] === '\n') index++
      continue
    }
    if (closed) throw fail('CSV 引号关闭后存在非法字符')
    if (char === '"') {
      if (field !== '') throw fail('CSV 字段中存在未转义引号')
      quoted = true
    } else field += char
  }
  if (quoted) throw fail('CSV 引号未关闭')
  if (field !== '' || row.length || closed) endRow()
  if (!rows.length) throw fail('CSV 缺少表头')
  const headers = rows.shift()
  if (headers.some(value => value.trim() === '') || new Set(headers.map(value => value.trim())).size !== headers.length) throw fail('CSV 表头为空或重复')
  if (rows.some(value => value.length !== headers.length)) throw fail('CSV 数据行字段数与表头不一致')
  return { headers, rows }
}

function numeric(value) {
  const text = String(value).trim()
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null
  const result = Number(text)
  return Number.isFinite(result) ? result : null
}

function csvText(rows) {
  return rows.map(row => row.map(cell => /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(',')).join('\r\n') + '\r\n'
}

function csvFilter(table, parameters) {
  const { headers, rows } = table
  const columns = parameters.columns ?? headers
  if (!Array.isArray(columns) || !columns.length || columns.some(name => typeof name !== 'string' || !headers.includes(name)) || new Set(columns).size !== columns.length) throw fail('输出字段不存在、为空或重复')
  const indexes = columns.map(name => headers.indexOf(name))
  let predicate = () => true
  if (parameters.filter !== undefined) {
    const filter = parameters.filter
    if (!record(filter) || Object.keys(filter).some(key => !['column', 'operator', 'value'].includes(key))
      || !headers.includes(filter.column) || !['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte'].includes(filter.operator)
      || !['string', 'number'].includes(typeof filter.value) || typeof filter.value === 'number' && !Number.isFinite(filter.value)) throw fail('筛选条件必须是固定字段、运算符和字面值')
    const index = headers.indexOf(filter.column), wanted = String(filter.value)
    if (['eq', 'neq', 'contains'].includes(filter.operator)) predicate = row => filter.operator === 'eq' ? row[index] === wanted : filter.operator === 'neq' ? row[index] !== wanted : row[index].includes(wanted)
    else {
      const value = numeric(filter.value)
      if (value === null) throw fail('数值筛选值必须是有限数值')
      predicate = row => {
        const actual = numeric(row[index])
        return actual !== null && (filter.operator === 'gt' ? actual > value : filter.operator === 'gte' ? actual >= value : filter.operator === 'lt' ? actual < value : actual <= value)
      }
    }
  }
  const selected = rows.filter(predicate)
  return { text: csvText([columns, ...selected.map(row => indexes.map(index => row[index]))]), mediaType: 'text/csv', summary: { inputRows: rows.length, outputRows: selected.length, columnCount: columns.length } }
}

function markdownOutline(input) {
  let fence = null, frontmatter = input.startsWith('---\n') || input.startsWith('---\r\n')
  const lines = [], counts = new Map()
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (frontmatter) { if (index > 0 && /^---\s*$/.test(line)) frontmatter = false; continue }
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], count: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.count && marker[2].trim() === '') fence = null
      continue
    }
    if (fence) continue
    const heading = /^\s{0,3}(#{1,6})[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/.exec(line)
    if (!heading) continue
    const title = heading[2].replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').trim()
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/ +/g, '-') || 'section'
    const occurrence = counts.get(base) || 0
    counts.set(base, occurrence + 1)
    const anchor = occurrence ? `${base}-${occurrence}` : base
    const label = title.replace(/[\\\[\]]/g, value => `\\${value}`)
    lines.push(`${'  '.repeat(heading[1].length - 1)}- [${label}](#${anchor})`)
  }
  if (frontmatter) throw fail('Markdown 元数据未关闭')
  return { text: lines.length ? lines.join('\n') + '\n' : '', mediaType: 'text/markdown', summary: { headingCount: lines.length } }
}

function repositoryFiles(input, requireText) {
  if (!record(input) || !Array.isArray(input.files) || input.files.length > 400 || input.truncated === true) throw fail('仓库输入不完整或文件数量超限')
  const names = new Set(), directories = new Set()
  let textBytes = 0
  const files = input.files.map(file => {
    if (!record(file) || typeof file.path !== 'string' || !file.path || file.path.length > 500
      || /[\\\u0000-\u001f]/.test(file.path) || /^(?:\/|[a-z]:)/i.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || names.has(file.path)) throw fail('仓库文件元数据不合法')
    if (requireText && typeof file.text !== 'string') throw fail('标记扫描需要完整源码文本')
    if (typeof file.text === 'string') {
      textBytes += Buffer.byteLength(file.text, 'utf8')
      if (Buffer.byteLength(file.text, 'utf8') !== file.bytes || textBytes > FILE_RECIPE_LIMITS.inputBytes || file.text.includes('\0')) throw fail('仓库文本不完整或超限')
    }
    names.add(file.path)
    const parts = file.path.split('/')
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'))
    return file
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const directoryCount = input.directories === undefined ? directories.size : Number.isSafeInteger(input.directories) && input.directories >= directories.size ? input.directories : Array.isArray(input.directories) ? input.directories.length : -1
  if (directoryCount < directories.size) throw fail('仓库目录元数据不完整')
  return { files, directoryCount }
}

const markdownCell = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\\`\[\]()!|]/g, value => `\\${value}`).replace(/[\r\n]+/g, ' ')

function repositoryReport(operation, input) {
  const { files, directoryCount } = repositoryFiles(input, operation === 'todo-report')
  if (operation === 'repo-inventory') {
    const byExtension = {}, totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    if (!Number.isSafeInteger(totalBytes)) throw fail('仓库字节统计超限')
    for (const file of files) {
      const name = file.path.split('/').at(-1), dot = name.lastIndexOf('.')
      const extension = dot > 0 ? name.slice(dot).toLowerCase() : '(none)'
      byExtension[extension] = (byExtension[extension] || 0) + 1
    }
    return { text: ['# 仓库文件清单', '', `文件数：${files.length}`, `目录数：${directoryCount}`, `总字节：${totalBytes}`, '', '| 文件 | 字节 |', '| --- | ---: |', ...files.map(file => `| ${markdownCell(file.path)} | ${file.bytes} |`), ''].join('\n'),
      mediaType: 'text/markdown', summary: { fileCount: files.length, directoryCount, totalBytes, byExtension } }
  }
  const markers = [], matchedFiles = new Set()
  for (const file of files) for (const [index, line] of file.text.split(/\r?\n/).entries()) {
    for (const marker of line.matchAll(/\b(TODO|FIXME|XXX)\b/gi)) {
      markers.push({ path: file.path, line: index + 1, marker: marker[1].toUpperCase(), text: line.trim() })
      matchedFiles.add(file.path)
      if (markers.length > 10_000) throw fail('源码标记数量超限')
    }
  }
  return { text: ['# 仓库 TODO 报告', '', `扫描文件数：${files.length}`, `标记数：${markers.length}`, '', '| 文件 | 行 | 标记 | 文本 |', '| --- | ---: | --- | --- |', ...markers.map(item => `| ${markdownCell(item.path)} | ${item.line} | ${item.marker} | ${markdownCell(item.text)} |`), ...(markers.length ? [] : ['未发现 TODO、FIXME 或 XXX 标记。']), ''].join('\n'),
    mediaType: 'text/markdown', summary: { fileCount: files.length, markerCount: markers.length, filesWithMarkers: matchedFiles.size } }
}

/** Returns data only. The caller owns path, permission and audited-skill gates. */
export function executeFileRecipe(operation, input, parameters = {}) {
  if (!specifications[operation]) throw fail('未知受控文件操作')
  if (['repo-inventory', 'todo-report'].includes(operation)) {
    if (!record(parameters) || Object.keys(parameters).length) throw fail('仓库报告不接受额外执行参数')
    return { operation, ...repositoryReport(operation, input) }
  }
  if (operation === 'javascript-check') throw fail('JavaScript 语法检查必须由宿主固定 node --check 适配器执行')
  if (!record(parameters) || Object.keys(parameters).some(key => !['columns', 'filter'].includes(key))) throw fail('未知操作参数')
  if (operation !== 'csv-filter' && Object.keys(parameters).length) throw fail('该操作不接受筛选参数')
  const text = checkedText(input)
  if (operation === 'markdown-outline') return { operation, ...markdownOutline(text) }
  const table = parseRecipeCsv(text)
  if (operation === 'csv-filter') return { operation, ...csvFilter(table, parameters) }
  const profile = { rowCount: table.rows.length, columnCount: table.headers.length,
    columns: table.headers.map((name, index) => {
      const values = table.rows.map(row => row[index]), numbers = values.map(numeric).filter(value => value !== null)
      const emptyCount = values.filter(value => value.trim() === '').length
      return { name, emptyCount, nonEmptyCount: values.length - emptyCount, numericCount: numbers.length, min: numbers.length ? Math.min(...numbers) : null, max: numbers.length ? Math.max(...numbers) : null }
    }),
  }
  return { operation, text: JSON.stringify(profile, null, 2) + '\n', mediaType: 'application/json', summary: { rowCount: profile.rowCount, columnCount: profile.columnCount } }
}
