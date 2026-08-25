import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NotebookEditTool } from '../../src/tools/NotebookEditTool/NotebookEditTool.js'
import { FileReadTool } from '../../src/tools/FileReadTool/FileReadTool.js'
import { createFileStateCache } from '../../src/utils/file/readFileState.js'
import type { ToolUseContext } from '../../src/Tool.js'

function context(cwd: string): ToolUseContext { return { cwd, abortController: new AbortController(), readFileState: createFileStateCache() } }
describe('NotebookEditTool', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-notebook-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  it('replaces, inserts, and deletes cells after a full read', async () => {
    const path = join(dir, 'book.ipynb'); writeFileSync(path, JSON.stringify({ cells: [{ id: 'a', cell_type: 'code', source: ['one'] }, { id: 'b', cell_type: 'markdown', source: ['two'] }] }))
    const ctx = context(dir); await FileReadTool.call({ file_path: path }, ctx)
    expect((await NotebookEditTool.call({ notebook_path: path, cell_id: 'a', new_source: 'changed' }, ctx)).isError).not.toBe(true)
    expect((await NotebookEditTool.call({ notebook_path: path, cell_number: 1, new_source: 'inserted', edit_mode: 'insert' }, ctx)).isError).not.toBe(true)
    expect((await NotebookEditTool.call({ notebook_path: path, cell_id: 'b', new_source: '', edit_mode: 'delete' }, ctx)).isError).not.toBe(true)
    const notebook = JSON.parse(readFileSync(path, 'utf8')) as { cells: Array<{ source: string[] }> }
    expect(notebook.cells).toHaveLength(2)
    expect(notebook.cells[0]?.source).toEqual(['changed'])
  })
})
