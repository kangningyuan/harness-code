import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileEditTool } from '../../src/tools/FileEditTool/FileEditTool.js'
import { FileWriteTool } from '../../src/tools/FileWriteTool/FileWriteTool.js'
import { createFileStateCache } from '../../src/utils/file/readFileState.js'
import type { ToolUseContext } from '../../src/Tool.js'

function context(cwd: string): ToolUseContext { return { cwd, abortController: new AbortController(), readFileState: createFileStateCache() } }
describe('FileEditTool and FileWriteTool', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-fileedit-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('requires a full read and fresh mtime before editing', async () => {
    const path = join(dir, 'file.txt'); writeFileSync(path, 'before')
    const ctx = context(dir)
    expect((await FileEditTool.call({ file_path: path, old_string: 'before', new_string: 'after' }, ctx)).isError).toBe(true)
    await FileReadToolForTest(path, ctx)
    writeFileSync(path, 'external change')
    expect((await FileEditTool.call({ file_path: path, old_string: 'before', new_string: 'after' }, ctx)).result).toContain('modified')
  })
  it('edits after a full read and supports quote normalization', async () => {
    const path = join(dir, 'file.txt'); writeFileSync(path, 'const value = “old”')
    const ctx = context(dir); await FileReadToolForTest(path, ctx)
    const result = await FileEditTool.call({ file_path: path, old_string: '"old"', new_string: '"new"' }, ctx)
    expect(result.isError).not.toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('"new"')
  })
  it('creates new files, writes LF line endings, and rejects UNC paths', async () => {
    const ctx = context(dir)
    const created = join(dir, 'new.txt')
    expect((await FileEditTool.call({ file_path: created, old_string: '', new_string: 'x' }, ctx)).isError).not.toBe(true)
    const written = join(dir, 'write.txt')
    expect((await FileWriteTool.call({ file_path: written, content: 'a\r\nb\r' }, ctx)).isError).not.toBe(true)
    expect(readFileSync(written, 'utf8')).toBe('a\nb\n')
    expect(await FileWriteTool.validateInput?.({ file_path: '\\\\server\\share\\write.txt' }, ctx)).toMatchObject({ ok: false })
  })
})
async function FileReadToolForTest(path: string, context: ToolUseContext): Promise<void> {
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.js')
  await FileReadTool.call({ file_path: path }, context)
}
