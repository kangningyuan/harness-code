import type { BuiltTool, ToolResult, ToolUseContext } from '../Tool.js'
import { textToolResult } from '../Tool.js'
import type { Message, ToolResultBlock, ToolUseBlock } from '../services/api/types.js'

export interface CanUseToolResult { behavior: 'allow' | 'deny'; message?: string }
export type CanUseTool = (tool: BuiltTool, input: Record<string, unknown>) => Promise<CanUseToolResult>
export interface RunToolsOptions {
  canUseTool?: CanUseTool
  onToolStart?: (name: string, input: unknown) => void
  onToolEnd?: (name: string, input: unknown, result: unknown, isError: boolean) => void
  onPreToolUse?: (name: string, input: Record<string, unknown>) => Promise<{ decision?: 'block'|'approve'; reason?: string }>
  onPostToolUse?: (name: string, input: Record<string, unknown>, result: unknown, isError: boolean) => Promise<void>
  maxResultSizeChars?: number
}

function asRecord(input: unknown): Record<string, unknown> { return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {} }
function resultText(result: ToolResult): string { return result.result ?? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data) ?? String(result.data)) }
function errorBlock(id: string, message: string): ToolResultBlock[] { return [{ type: 'tool_result', tool_use_id: id, content: message, is_error: true }] }

function jsonSchemaError(schema: Record<string, unknown>, value: unknown, path = 'input'): string | null {
  const alternatives = schema.anyOf
  if (Array.isArray(alternatives)) {
    if (alternatives.some(option => option && typeof option === 'object' && jsonSchemaError(option as Record<string, unknown>, value, path) === null)) return null
    return `${path} does not match any allowed schema`
  }
  const enumValues = schema.enum
  if (Array.isArray(enumValues) && !enumValues.some(candidate => Object.is(candidate, value))) return `${path} must be one of: ${enumValues.join(', ')}`
  const type = schema.type
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`
    const object = value as Record<string, unknown>
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (typeof key === 'string' && !(key in object)) return `${path}.${key} is required`
    }
    const properties = schema.properties
    if (properties && typeof properties === 'object') {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        if (key in object && child && typeof child === 'object') {
          const error = jsonSchemaError(child as Record<string, unknown>, object[key], `${path}.${key}`)
          if (error) return error
        }
      }
    }
    return null
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items`
    if (schema.items && typeof schema.items === 'object') {
      for (let index = 0; index < value.length; index++) {
        const error = jsonSchemaError(schema.items as Record<string, unknown>, value[index], `${path}[${index}]`)
        if (error) return error
      }
    }
    return null
  }
  if (type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string`
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} characters`
    return null
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) return `${path} must be an integer`
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) return `${path} must be at least ${schema.minimum}`
    return null
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} must be at least ${schema.minimum}`
    return null
  }
  if (type === 'boolean' && typeof value !== 'boolean') return `${path} must be a boolean`
  return null
}

function validateSchema(tool: BuiltTool, input: Record<string, unknown>): string | null {
  if (tool.inputSchema) {
    const parsed = tool.inputSchema.safeParse(input)
    return parsed.success ? null : parsed.error.issues.map(issue => issue.message).join('; ') || 'Invalid tool input'
  }
  if (tool.inputJSONSchema) return jsonSchemaError(tool.inputJSONSchema, input)
  return null
}

async function executeOne(block: ToolUseBlock, tool: BuiltTool | undefined, context: ToolUseContext, options: RunToolsOptions): Promise<ToolResultBlock[]> {
  if (!tool) return errorBlock(block.id, `Unknown tool: ${block.name}`)
  const input = asRecord(block.input)
  const schemaError = validateSchema(tool, input)
  if (schemaError) return errorBlock(block.id, `Invalid input: ${schemaError}`)
  if (tool.validateInput) {
    try {
      const validation = await tool.validateInput(input, context)
      if (!validation.ok) return errorBlock(block.id, validation.message ?? 'Invalid tool input')
    } catch (error) { return errorBlock(block.id, `Invalid input: ${error instanceof Error ? error.message : String(error)}`) }
  }
  let hookApproved = false
  if (options.onPreToolUse) {
    const outcome: { decision?: 'block'|'approve'; reason?: string } = await options.onPreToolUse(block.name, input).catch(() => ({}))
    if (outcome.decision === 'block') return errorBlock(block.id, `Blocked by PreToolUse hook${outcome.reason ? `: ${outcome.reason}` : ''}`)
    hookApproved = outcome.decision === 'approve'
  }
  if (!hookApproved && options.canUseTool) {
    let permission: CanUseToolResult
    try { permission = await options.canUseTool(tool, input) }
    catch (error) { return errorBlock(block.id, `Permission check failed: ${error instanceof Error ? error.message : String(error)}`) }
    if (permission.behavior === 'deny') return errorBlock(block.id, `Permission denied${permission.message ? `: ${permission.message}` : ''}`)
  }
  try { options.onToolStart?.(tool.name, input) } catch { /* UI callbacks must not block tools */ }
  let result: ToolResult
  try { result = await tool.call(input, context) }
  catch (error) { result = { data: null, result: error instanceof Error ? error.message : String(error), isError: true } }
  const isError = result.isError === true
  try { options.onToolEnd?.(tool.name, input, result, isError) } catch { /* UI callbacks must not block tools */ }
  try { await options.onPostToolUse?.(tool.name, input, result, isError) } catch { /* PostToolUse is observe-only */ }
  const text = resultText(result)
  const max = options.maxResultSizeChars ?? tool.maxResultSizeChars
  if (Number.isFinite(max) && text.length > max) return errorOrNormalBlock(block.id, text.slice(0, max) + `\n... (truncated, ${text.length - max} chars omitted)`, isError)
  try { return tool.mapToolResultToToolResultBlockParam?.(result, block.id) ?? textToolResult(result, block.id) }
  catch (error) { return errorBlock(block.id, `Failed to serialize tool result: ${error instanceof Error ? error.message : String(error)}`) }
}
function errorOrNormalBlock(id: string, content: string, isError: boolean): ToolResultBlock[] { return [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }
function isConcurrencySafe(tool: BuiltTool | undefined, input: unknown): boolean {
  if (!tool) return false
  try { return tool.isConcurrencySafe?.(asRecord(input)) === true } catch { return false }
}

export async function runTools(blocks: ToolUseBlock[], tools: BuiltTool[], context: ToolUseContext, options: RunToolsOptions = {}): Promise<Message[]> {
  const resolved = blocks.map(block => ({ block, tool: tools.find(candidate => candidate.name === block.name || candidate.aliases?.includes(block.name)) }))
  const safe = resolved.filter(item => isConcurrencySafe(item.tool, item.block.input))
  const unsafe = resolved.filter(item => !safe.includes(item))
  const results = new Map<string, ToolResultBlock[]>()
  const safeResults = await Promise.all(safe.map(async item => [item.block.id, await executeOne(item.block, item.tool, context, options)] as const))
  for (const [id, result] of safeResults) results.set(id, result)
  for (const item of unsafe) results.set(item.block.id, await executeOne(item.block, item.tool, context, options))
  const content = blocks.flatMap(block => results.get(block.id) ?? errorBlock(block.id, 'Tool execution produced no result'))
  return [{ role: 'user', content }]
}
