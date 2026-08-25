import { existsSync, statSync } from 'node:fs'
import { buildTool, textToolResult, type ToolUseContext } from '../../Tool.js'
import { canonicalPath } from '../../utils/file/canonicalPath.js'
import { isFullRead } from '../../utils/file/readFileState.js'
import { atomicWriteFile } from '../../utils/file/atomicWrite.js'
export const FileWriteTool = buildTool<Record<string, unknown>, unknown>({ name: 'FileWriteTool', inputJSONSchema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path','content'] }, maxResultSizeChars: 10_000,
  async validateInput(input: Record<string, unknown>) { if (/^[\\/]{2}[^\\/]+[\\/]/.test(String(input.file_path ?? ''))) return { ok: false, message: 'UNC paths are not allowed' }; return { ok: true } },
  async call(input: Record<string, unknown>, context: ToolUseContext) { const path = canonicalPath(String(input.file_path), context.cwd); if (existsSync(path)) { const state = context.readFileState.get(path); if (!isFullRead(state)) return { data: null, result: `Must read the file ${path} before writing`, isError: true }; if (statSync(path).mtimeMs !== state?.mtimeMs) return { data: null, result: 'File was modified since last read', isError: true } } const content = String(input.content ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); atomicWriteFile(path, content); context.readFileState.recordRead(path, statSync(path).mtimeMs); return { data: content, result: `Wrote ${path}` } },
  description: input => `write ${String(input.file_path ?? '')}`, prompt: () => 'Write complete file contents. Read existing files first.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => String(input.file_path ?? '')
})
