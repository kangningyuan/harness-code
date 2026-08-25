import { readFileSync, statSync, existsSync } from 'node:fs'
import { extname } from 'node:path'
import { buildTool, textToolResult, type ToolUseContext } from '../../Tool.js'
import { canonicalPath } from '../../utils/file/canonicalPath.js'
import { isFullRead } from '../../utils/file/readFileState.js'
const binary = new Set(['.exe','.bin','.dll','.so','.dylib','.o','.a','.class','.jar','.war','.pyc','.pyo','.wasm','.obj','.lib','.pdb'])
const blocked = new Set(['/dev/zero','/dev/random','/dev/urandom','/dev/stdin','/dev/tty','/proc/self/fd/0','/proc/self/fd/1','/proc/self/fd/2'])
export const FILE_UNCHANGED_STUB = '<system-reminder>File content unchanged since last read</system-reminder>'
interface NotebookCell { id?: string; cell_type?: string; metadata?: { id?: string }; source?: string | string[] }
function notebookText(raw: Buffer): string {
  const notebook = JSON.parse(raw.toString('utf8')) as { cells?: NotebookCell[] }
  if (!Array.isArray(notebook.cells)) throw new Error('Invalid notebook: cells must be an array')
  return notebook.cells.map((cell, index) => {
    const id = cell.id ?? cell.metadata?.id ?? `c${index}`
    const type = cell.cell_type ?? 'code'
    const source = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '')
    return `<cell id="${id}" type="${type}">\n${source}\n</cell>`
  }).join('\n')
}
export const FileReadTool = buildTool({
  name: 'FileReadTool', inputSchema: undefined, inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, pages: { type: 'string' } }, required: ['file_path'] }, maxResultSizeChars: Infinity, isReadOnly: () => true, isConcurrencySafe: () => true,
  async validateInput(input: Record<string, unknown>, context: ToolUseContext) { const rawPath = String(input.file_path ?? ''); if (/^[\\/]{2}[^\\/]+[\\/]/.test(rawPath)) return { ok: false, message: 'UNC paths are not allowed' }; const path = canonicalPath(rawPath, context.cwd); if (blocked.has(path) || blocked.has(rawPath)) return { ok: false, message: 'Device path is not allowed' }; if (binary.has(extname(rawPath).toLowerCase())) return { ok: false, message: 'Binary files are not supported' }; if (input.pages !== undefined && extname(rawPath).toLowerCase() !== '.pdf') return { ok: false, message: 'pages is only valid for PDF files' }; return { ok: true } },
  async call(input: Record<string, unknown>, context: ToolUseContext) {
    const path = canonicalPath(String(input.file_path), context.cwd); if (!existsSync(path)) return { data: null, result: `File not found: ${path}`, isError: true }; const stat = statSync(path); if (!stat.isFile()) return { data: null, result: `Not a file: ${path}`, isError: true }
    const previous = context.readFileState.get(path); if (previous && isFullRead(previous) && previous.mtimeMs === stat.mtimeMs) return { data: FILE_UNCHANGED_STUB, result: FILE_UNCHANGED_STUB }
    if (stat.size > 2 * 1024 * 1024) return { data: null, result: 'File is too large; use offset/limit or GrepTool', isError: true }
    const raw = readFileSync(path); const extension = extname(path).toLowerCase()
    if (['.png','.jpg','.jpeg','.gif','.webp','.bmp'].includes(extension)) {
      if (raw.byteLength > 2 * 1024 * 1024) return { data: null, result: 'Image is too large', isError: true }
      const mediaType = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1)
      context.readFileState.recordRead(path, stat.mtimeMs)
      return { data: `<image src="data:image/${mediaType};base64,${raw.toString('base64')}"/>` }
    }
    if (extension === '.ipynb') {
      try {
        const output = notebookText(raw)
        context.readFileState.recordRead(path, stat.mtimeMs)
        return { data: output, result: `cat -n ${path}\n${output}` }
      } catch (error) { return { data: null, result: error instanceof Error ? error.message : String(error), isError: true } }
    }
    const lines = raw.toString('utf8').split(/\r?\n/); const hasOffset = input.offset !== undefined; const hasLimit = input.limit !== undefined; const start = hasOffset ? Number(input.offset) : 1; const count = hasLimit ? Number(input.limit) : lines.length - start + 1; const end = Math.min(lines.length, Math.max(start - 1, start - 1 + count)); const output = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(6)}\t${line}`).join('\n'); const fullRead = !hasOffset && !hasLimit; context.readFileState.set(path, { offset: hasOffset ? start : undefined, limit: hasLimit ? Number(input.limit) : undefined, mtimeMs: stat.mtimeMs, isFullRead: fullRead }); if (fullRead) context.readFileState.recordRead(path, stat.mtimeMs); return { data: output, result: `cat -n ${path}\n${output}` }
  },
  description: input => `read ${String(input.file_path ?? '')}`, prompt: () => 'Read file contents with line numbers.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => String(input.file_path ?? '')
})
