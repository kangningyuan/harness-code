import { z } from 'zod'
import type { ContentBlock, Message, SystemBlock, ToolResultBlock } from './services/api/types.js'

export interface FileStateCache { get(path: string): ReadFileState | undefined; set(path: string, state: ReadFileState): void; recordRead(path: string, mtimeMs: number): void; clear(): void }
export interface ReadFileState { offset?: number; limit?: number; mtimeMs: number; isFullRead?: boolean }
export interface ToolUseContext {
  abortController: AbortController
  readFileState: FileStateCache
  cwd: string
  messages?: Message[]
  agentId?: string
  addNotification?: (msg: string) => void
  sendOSNotification?: (msg: string) => void
  permissionContext?: unknown
  resultStore?: ToolResultStore
  planApproval?: (plan: string) => Promise<boolean>
}
export type PermissionResult = { behavior: 'allow' } | { behavior: 'deny'; message?: string } | { behavior: 'ask'; message?: string } | { behavior: 'passthrough' }
export interface ToolResultReference { id: string; relativePath: string; byteLength: number; sha256: string; preview: string }
export interface ToolResultStore { persist(content: string, metadata: { toolUseId: string; toolName: string }): ToolResultReference | null }
export interface ToolResult<T = unknown> { data: T; result?: string; isError?: boolean; rawResult?: string; resultRef?: ToolResultReference }
export interface ValidationResult { ok: boolean; message?: string }
export interface ToolDefinition<I = Record<string, unknown>, O = unknown> {
  name: string; aliases?: string[]; inputSchema?: z.ZodTypeAny; inputJSONSchema?: Record<string, unknown>; maxResultSizeChars: number
  call(args: I, context: ToolUseContext): Promise<ToolResult<O>>
  description(args: I, options?: { toolUseId?: string }): string
  prompt(options?: { verbose?: boolean }): string
  checkPermissions?(args: I, context: ToolUseContext): Promise<PermissionResult>
  mapToolResultToToolResultBlockParam?(result: ToolResult<O>, toolUseId: string): ToolResultBlock[]
  mapToolResultToToolResultBlock?(result: ToolResult<O>, toolUseId: string): ToolResultBlock[]
  renderToolUseMessage(args: I): string
  isReadOnly?(args: I): boolean; isDestructive?(args: I): boolean; isConcurrencySafe?(args: I): boolean
  validateInput?(args: I, context: ToolUseContext): Promise<ValidationResult>
  isEnabled?(): boolean; isMcp?: boolean; shouldDefer?: boolean; alwaysLoad?: boolean
  userFacingName?(args?: I): string
}
export type BuiltTool<I = Record<string, unknown>, O = unknown> = ToolDefinition<I, O> & { readonly jsonSchema: Record<string, unknown> }

function defOf(schema: unknown): Record<string, unknown> { return (schema as { _def?: Record<string, unknown> })?._def ?? {} }
function typeName(schema: unknown): string {
  const d = defOf(schema); const t = d.type
  if (typeof t === 'string') return t.toLowerCase()
  const n = d.typeName
  return typeof n === 'string' ? n.replace(/^Zod/, '').toLowerCase() : ''
}
function unwrap(schema: unknown): unknown { return defOf(schema).innerType ?? defOf(schema).schema ?? defOf(schema).wrapped ?? schema }
function zodNodeToJson(schema: unknown): Record<string, unknown> {
  const type = typeName(schema); const d = defOf(schema)
  switch (type) {
    case 'object': case 'zodobject': {
      const shape = typeof d.shape === 'function' ? d.shape() : (d.shape ?? {})
      const properties: Record<string, unknown> = {}; const required: string[] = []
      for (const [key, value] of Object.entries(shape as Record<string, unknown>)) {
        properties[key] = zodNodeToJson(value)
        const childType = typeName(value)
        if (!['optional','nullable','default','zodoptional','zodnullable','zoddefault'].includes(childType)) required.push(key)
      }
      const out: Record<string, unknown> = { type: 'object', properties }
      if (required.length) out.required = required
      return out
    }
    case 'string': case 'zodstring': return { type: 'string' }
    case 'number': case 'int': case 'zodnumber': case 'zodbigint': return { type: 'number' }
    case 'boolean': case 'zodboolean': return { type: 'boolean' }
    case 'array': case 'zodarray': return { type: 'array', items: zodNodeToJson(d.element) }
    case 'enum': case 'zodenum': { const vals = d.entries && typeof d.entries === 'object' ? Object.values(d.entries as object) : Array.isArray(d.values) ? d.values : []; return { type: 'string', enum: vals } }
    case 'optional': case 'nullable': case 'default': case 'zodoptional': case 'zodnullable': case 'zoddefault': { const inner = zodNodeToJson(unwrap(schema)); return type === 'nullable' || type === 'zodnullable' ? { anyOf: [inner, { type: 'null' }] } : inner }
    case 'literal': case 'zodliteral': { const v = d.value; return { const: v, type: typeof v } }
    case 'union': case 'zodunion': return { anyOf: (Array.isArray(d.options) ? d.options : []).map(zodNodeToJson) }
    case 'record': case 'zodrecord': return { type: 'object', additionalProperties: zodNodeToJson(d.valueType ?? d.valueTypeDef) }
    case 'unknown': case 'any': return {}
    default: return { type: 'object', properties: {} }
  }
}
export function zodToJsonSchema(schema: z.ZodTypeAny | undefined): Record<string, unknown> { return schema ? zodNodeToJson(schema) : { type: 'object', properties: {} } }

export function buildTool<I, O>(def: ToolDefinition<I, O>): BuiltTool<I, O> {
  const withDefaults: ToolDefinition<I, O> = {
    isEnabled: () => true, isConcurrencySafe: () => false, isReadOnly: () => false, isDestructive: () => false,
    checkPermissions: async () => ({ behavior: 'passthrough' }), userFacingName: () => def.name, ...def,
  }
  const mapper = def.mapToolResultToToolResultBlockParam ?? def.mapToolResultToToolResultBlock
  const normalized = { ...withDefaults, mapToolResultToToolResultBlockParam: mapper ?? ((result: ToolResult<O>, toolUseId: string) => textToolResult(result, toolUseId)) }
  return Object.assign(normalized, { jsonSchema: def.inputJSONSchema ?? zodToJsonSchema(def.inputSchema) })
}

export function textToolResult<T>(result: ToolResult<T>, toolUseId: string): ToolResultBlock[] {
  const text = result.result ?? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
  return [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: result.isError }]
}

export function assistantBlocksForNextTurn(blocks: ContentBlock[]): ContentBlock[] { return blocks.filter(b => b.type === 'text' || b.type === 'tool_use') }
