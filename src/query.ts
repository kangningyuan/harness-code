import type { BuiltTool, ToolUseContext } from './Tool.js'
import { assistantBlocksForNextTurn } from './Tool.js'
import { ApiError, ApiClient, RequestAbortedError } from './services/api/client.js'
import type { ContentBlock, Message, ToolUseBlock, Usage } from './services/api/types.js'
import { runTools, type CanUseTool, type RunToolsOptions } from './query/runTools.js'
import { yieldMissingToolResultBlocks } from './query/abort.js'

export type QueryExitReason = 'completed' | 'aborted_streaming' | 'aborted_tools' | 'max_turns' | 'prompt_too_long' | 'error'
export interface QueryResult { reason: QueryExitReason; messages: Message[]; error?: string }
export interface QueryDeps {
  client: ApiClient
  tools: BuiltTool[]
  systemPrompt: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  model: string
  maxOutputTokens: number
  maxTurns: number
  context: ToolUseContext
  canUseTool: CanUseTool
  autoCompact?: (messages: Message[]) => Promise<Message[] | null>
  compact?: (messages: Message[]) => Promise<Message[] | null>
  runToolsOptions?: Omit<RunToolsOptions, 'canUseTool'>
  onPreToolUse?: RunToolsOptions['onPreToolUse']
  onPostToolUse?: RunToolsOptions['onPostToolUse']
  onStreamEvent?: (event: unknown) => void
  onTextDelta?: (text: string) => void
  onToolStart?: (name: string, input: unknown) => void
  onToolEnd?: (name: string, input: unknown, result: unknown, isError: boolean) => void
  onUsage?: (model: string, usage: Usage) => void
  injectMessages?: () => Message[]
}
const MAX_OUTPUT_TOKENS_ESCALATION = 64_000
const MAX_OUTPUT_TOKEN_RECOVERIES = 3

export async function query(initialMessages: Message[], deps: QueryDeps): Promise<QueryResult> {
  let messages = [...initialMessages]
  let turns = 0
  let recoveries = 0
  let outputOverride: number | undefined
  let compactAttempted = false
  while (true) {
    if (turns >= deps.maxTurns) return { reason: 'max_turns', messages }
    if (deps.autoCompact) { const compacted = await deps.autoCompact(messages).catch(() => null); if (compacted) messages = compacted }
    const queued = deps.injectMessages?.() ?? []
    if (queued.length) messages = [...messages, ...queued]
    let result
    try {
      result = await deps.client.callModel({ model: deps.model, messages, system: deps.systemPrompt, tools: deps.tools.map(tool => ({ name: tool.name, description: tool.prompt(), input_schema: tool.jsonSchema })), max_tokens: outputOverride ?? deps.maxOutputTokens }, {
        onEvent: event => { deps.onStreamEvent?.(event); if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') deps.onTextDelta?.(event.delta.text ?? '') },
        signal: deps.context.abortController.signal,
      })
    } catch (error) {
      if (error instanceof RequestAbortedError) return { reason: 'aborted_streaming', messages }
      if (error instanceof ApiError && error.isPromptTooLong) {
        if (!compactAttempted && (deps.compact ?? deps.autoCompact)) { compactAttempted = true; const compacted = await (deps.compact ?? deps.autoCompact)!(messages).catch(() => null); if (compacted) { messages = compacted; continue } }
        return { reason: 'prompt_too_long', messages, error: error.message }
      }
      if (error instanceof ApiError && error.isMaxOutputTokens) {
        if (outputOverride === undefined) { outputOverride = MAX_OUTPUT_TOKENS_ESCALATION; continue }
        if (recoveries < MAX_OUTPUT_TOKEN_RECOVERIES) { recoveries++; messages = [...messages, { role: 'user', content: 'Continue from where you left off.' }]; continue }
      }
      return { reason: 'error', messages, error: error instanceof Error ? error.message : String(error) }
    }
    turns++
    if (result.usage) deps.onUsage?.(deps.model, result.usage)
    const assistantBlocks = result.content
    messages = [...messages, { role: 'assistant', content: assistantBlocksForNextTurn(assistantBlocks) }]
    const toolUse = assistantBlocks.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    if (!toolUse.length) {
      if (result.stopReason === 'max_tokens' && recoveries < MAX_OUTPUT_TOKEN_RECOVERIES) { recoveries++; messages = [...messages, { role: 'user', content: 'Continue from where you left off.' }]; continue }
      return { reason: 'completed', messages }
    }
    try {
      const toolMessages = await runTools(toolUse, deps.tools, deps.context, { ...deps.runToolsOptions, canUseTool: deps.canUseTool, onPreToolUse: deps.onPreToolUse, onPostToolUse: deps.onPostToolUse, onToolStart: deps.onToolStart, onToolEnd: deps.onToolEnd })
      messages = [...messages, ...toolMessages]
    } catch (error) {
      const synthetic = yieldMissingToolResultBlocks(assistantBlocks, [])
      if (synthetic) messages = [...messages, synthetic]
      if (deps.context.abortController.signal.aborted || error instanceof RequestAbortedError) return { reason: 'aborted_tools', messages }
    }
  }
}

export function getFinalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    return message.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
  }
  return ''
}
