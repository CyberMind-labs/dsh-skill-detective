import test from 'node:test'
import assert from 'node:assert/strict'
import { executeFileRecipe, parseRecipeCsv, buildRecipeFiles, readRecipeContract, FILE_RECIPE_CATALOG } from '../file-recipes.js'

const file = (path, text) => ({ path, text, bytes: Buffer.byteLength(text, 'utf8') })

test('core catalog entries are real host recipes with exact, closed execution contracts', () => {
  assert.deepEqual(FILE_RECIPE_CATALOG.map(entry => entry.name), ['safe-repo-inventory', 'safe-todo-report', 'safe-javascript-check'])
  for (const entry of FILE_RECIPE_CATALOG) {
    assert.equal(entry.author, 'CyberMind-labs')
    assert.equal(entry.installs, 0)
    assert.deepEqual(readRecipeContract(buildRecipeFiles(entry.recipeOperation)), { ok: true, version: 1, adapter: 'file-recipes', operation: entry.recipeOperation, operations: [entry.recipeOperation] })
  }
})

test('repo inventory reports exact deterministic paths, sizes and directory scope', () => {
  const input = { files: [file('src/b.js', 'const b = 2\n'), file('README.md', '# 项目\n'), file('docs/plan.md', 'Plan\n'), file('src/a.js', 'export const a = 1\n')] }
  const result = executeFileRecipe('repo-inventory', input)
  assert.deepEqual(result.summary, { fileCount: 4, directoryCount: 2, totalBytes: input.files.reduce((n, item) => n + item.bytes, 0), byExtension: { '.md': 2, '.js': 2 } })
  assert.match(result.text, /文件数：4\n目录数：2/)
  assert.ok(result.text.indexOf('README.md') < result.text.indexOf('docs/plan.md'))
  assert.ok(result.text.indexOf('src/a.js') < result.text.indexOf('src/b.js'))
  assert.equal(result.mediaType, 'text/markdown')
})

test('TODO report preserves original source lines and exact one-based positions', () => {
  const result = executeFileRecipe('todo-report', { files: [file('src/a.js', 'const a = 1\n// TODO: name this\n// FIXME and XXX\n'), file('docs/plan.md', '# Plan\nTODO: document\n')] })
  assert.deepEqual(result.summary, { fileCount: 2, markerCount: 4, filesWithMarkers: 2 })
  assert.match(result.text, /\| src\/a.js \| 2 \| TODO \| \/\/ TODO: name this \|/)
  assert.match(result.text, /\| src\/a.js \| 3 \| FIXME \| \/\/ FIXME and XXX \|/)
  assert.match(result.text, /\| src\/a.js \| 3 \| XXX \| \/\/ FIXME and XXX \|/)
  assert.match(result.text, /\| docs\/plan.md \| 2 \| TODO \| TODO: document \|/)
})

test('repository reports reject incomplete and ambiguous walker input', () => {
  for (const input of [
    { truncated: true, files: [] },
    { files: [{ path: '../escape.js', bytes: 1 }] },
    { files: [{ path: '/absolute.js', bytes: 1 }] },
    { files: [{ path: 'C:/absolute.js', bytes: 1 }] },
    { files: [{ path: 'src/a.js', bytes: 1 }, { path: 'src/a.js', bytes: 1 }] },
    { files: [{ path: 'src/a.js', bytes: -1 }] },
    { directories: 0, files: [{ path: 'src/a.js', bytes: 1 }] },
  ]) assert.throws(() => executeFileRecipe('repo-inventory', input), { code: 'file-recipe-invalid' })
  assert.throws(() => executeFileRecipe('todo-report', { files: [{ path: 'a.js', bytes: 1 }] }), /完整源码/)
  assert.throws(() => executeFileRecipe('todo-report', { files: [{ path: 'a.js', text: 'TODO', bytes: 1 }] }), /完整或超限/)
})

test('source text cannot turn a report into active Markdown links or HTML', () => {
  const result = executeFileRecipe('todo-report', { files: [file('a.js', '// TODO: ![image](https://example.invalid) <script>alert(1)</script>\n')] })
  assert.ok(!result.text.includes('![image]('))
  assert.ok(!result.text.includes('<script>'))
  assert.match(result.text, /&lt;script&gt;/)
})

test('JavaScript checking cannot silently fall back to evaluating source', () => {
  assert.throws(() => executeFileRecipe('javascript-check', 'throw new Error("MUST_NOT_EXECUTE")'), /宿主固定 node --check/)
  assert.throws(() => executeFileRecipe('repo-inventory', { files: [] }, { command: 'anything' }), /额外执行参数/)
})

test('CSV parsing handles quoted commas, quotes and embedded newlines losslessly', () => {
  const input = 'name,note,score\r\nAlice,"one,two",2\r\nBob,"line1\nline2 ""quoted""",3\r\n'
  assert.deepEqual(parseRecipeCsv(input), { headers: ['name', 'note', 'score'], rows: [['Alice', 'one,two', '2'], ['Bob', 'line1\nline2 "quoted"', '3']] })
  const result = executeFileRecipe('csv-filter', input, { columns: ['note', 'name'], filter: { column: 'score', operator: 'gt', value: 2 } })
  assert.deepEqual(parseRecipeCsv(result.text), { headers: ['note', 'name'], rows: [['line1\nline2 "quoted"', 'Bob']] })
  assert.deepEqual(result.summary, { inputRows: 2, outputRows: 1, columnCount: 2 })
})

test('CSV malformed records and duplicate headers fail instead of shifting columns', () => {
  for (const input of ['', 'a,a\n1,2', 'a, a\n1,2', 'a,b\n1', 'a,b\n1,2,3', 'a\n"unterminated', 'a\n"x"tail', 'a\nabc"def']) {
    assert.throws(() => parseRecipeCsv(input), { code: 'file-recipe-invalid' })
  }
  assert.throws(() => executeFileRecipe('csv-filter', 'a\n1\n', { filter: { column: 'a', operator: 'eval', value: 'process.exit()' } }), /字面值/)
  assert.throws(() => executeFileRecipe('csv-filter', 'a\n1\n', { columns: ['missing'] }), /输出字段/)
})

test('CSV profiling counts blanks and finite numeric values without executing cells', () => {
  const result = JSON.parse(executeFileRecipe('csv-profile', 'name,value\nA,2\nB,\nC,-4\nD,=RUN()\n').text)
  assert.equal(result.rowCount, 4)
  assert.deepEqual(result.columns[1], { name: 'value', emptyCount: 1, nonEmptyCount: 3, numericCount: 2, min: -4, max: 2 })
})

test('Markdown outline ignores metadata and fenced headings, and disambiguates repeated anchors', () => {
  const source = '---\ntitle: Example\n---\n# Intro\n```js\n# fake\n```\n## Detail\n~~~\n## also fake\n~~~\n# Intro\n'
  const result = executeFileRecipe('markdown-outline', source)
  assert.equal(result.text, '- [Intro](#intro)\n  - [Detail](#detail)\n- [Intro](#intro-1)\n')
  assert.deepEqual(result.summary, { headingCount: 3 })
})
