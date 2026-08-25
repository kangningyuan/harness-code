import fg from 'fast-glob'
import { buildTool, textToolResult } from '../../Tool.js'
export const GlobTool = buildTool<Record<string, unknown>, unknown>({ name: 'GlobTool', inputJSONSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] }, maxResultSizeChars: 30_000, isReadOnly: () => true, isConcurrencySafe: () => true,
  async call(input, context) { const files = await fg(String(input.pattern), { cwd: String(input.path ?? context.cwd), dot: false, onlyFiles: true, ignore: ['**/node_modules/**','**/.git/**'], absolute: false }); return { data: files.slice(0, 500), result: files.slice(0, 500).join('\n') } },
  description: input => `glob ${String(input.pattern ?? '')}`, prompt: () => 'Find files matching a glob pattern.', mapToolResultToToolResultBlockParam: textToolResult, renderToolUseMessage: input => String(input.pattern ?? '')
})
