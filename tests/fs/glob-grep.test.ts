import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GlobTool } from '../../src/tools/GlobTool/GlobTool.js'
import { GrepTool } from '../../src/tools/GrepTool/GrepTool.js'
import { createFileStateCache } from '../../src/utils/file/readFileState.js'
import type { ToolUseContext } from '../../src/Tool.js'

function context(cwd: string): ToolUseContext { return { cwd, abortController: new AbortController(), readFileState: createFileStateCache() } }
describe('GlobTool and GrepTool', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join('/tmp', 'harness-glob-')); mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'one.ts'), 'needle\nother'); writeFileSync(join(dir, 'src', 'two.txt'), 'needle'); mkdirSync(join(dir, 'node_modules')); writeFileSync(join(dir, 'node_modules', 'ignored.ts'), 'needle') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('finds files while excluding node_modules', async () => {
    const result = await GlobTool.call({ pattern: '**/*' }, context(dir))
    expect(result.data).toEqual(expect.arrayContaining(['src/one.ts', 'src/two.txt']))
    expect(result.data).not.toContain('node_modules/ignored.ts')
  })
  it('supports content, file, and count grep modes', async () => {
    const ctx = context(dir)
    expect((await GrepTool.call({ pattern: 'needle', path: 'src', output_mode: 'content' }, ctx)).result).toContain('one.ts')
    expect((await GrepTool.call({ pattern: 'needle', path: 'src', output_mode: 'files_with_matches' }, ctx)).data).toEqual(expect.arrayContaining([expect.stringContaining('one.ts')]))
    expect((await GrepTool.call({ pattern: 'needle', path: 'src', output_mode: 'count' }, ctx)).result).toContain(':1')
  })
})
