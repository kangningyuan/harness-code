import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import { createFileStateCache } from '../../src/utils/file/readFileState.js'
import type { ToolUseContext } from '../../src/Tool.js'

function context(cwd: string): ToolUseContext { return { cwd, abortController: new AbortController(), readFileState: createFileStateCache() } }
describe('FileReadTool', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-fileread-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('reads text with line numbers and honors limit as a count', async () => {
    const path = join(dir, 'file.txt'); writeFileSync(path, 'one\ntwo\nthree\n')
    const ctx = context(dir)
    const result = await FileReadTool.call({ file_path: path, offset: 2, limit: 1 }, ctx)
    expect(result.result).toContain('     2\ttwo')
    expect(result.result).not.toContain('three')
  })
  it('returns an unchanged stub after a full read', async () => {
    const path = join(dir, 'file.txt'); writeFileSync(path, 'one\ntwo\n')
    const ctx = context(dir)
    await FileReadTool.call({ file_path: path }, ctx)
    expect(await FileReadTool.call({ file_path: path }, ctx)).toMatchObject({ result: '<system-reminder>File content unchanged since last read</system-reminder>' })
  })
  it('renders notebooks as cells', async () => {
    const path = join(dir, 'book.ipynb'); writeFileSync(path, JSON.stringify({ cells: [{ id: 'cell-1', cell_type: 'code', source: ['print(1)\n'] }, { cell_type: 'markdown', source: ['# title'] }] }))
    const result = await FileReadTool.call({ file_path: path }, context(dir))
    expect(result.result).toContain('<cell id="cell-1" type="code">')
    expect(result.result).toContain('<cell id="c1" type="markdown">')
  })
  it('rejects UNC and binary/device paths before reading', async () => {
    const ctx = context(dir)
    await expect(FileReadTool.validateInput?.({ file_path: '\\\\server\\share\\file.txt' }, ctx)).resolves.toMatchObject({ ok: false })
    await expect(FileReadTool.validateInput?.({ file_path: '/dev/zero' }, ctx)).resolves.toMatchObject({ ok: false })
    await expect(FileReadTool.validateInput?.({ file_path: 'program.exe' }, ctx)).resolves.toMatchObject({ ok: false })
  })
})
