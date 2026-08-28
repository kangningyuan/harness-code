import type { BuiltTool, ToolUseContext } from './Tool.js'
import { assistantBlocksForNextTurn } from './Tool.js'
import { ApiError, ApiClient, RequestAbortedError } from './services/api/client.js'
import { createRecoveryState, retryModelCall, type RetryPolicy } from './query/recovery.js'
import type { ContentBlock, Message, ModelResult, ToolUseBlock, Usage } from './services/api/types.js'
import { runTools, type CanUseTool, type RunToolsOptions } from './query/runTools.js'
import { yieldMissingToolResultBlocks } from './query/abort.js'
import type { BackgroundTaskManager } from './services/background/manager.js'
import { newRequestId } from './services/protocol/ids.js'
import type { CorrelationContext } from './services/protocol/types.js'

export type QueryExitReason = 'completed' | 'aborted_streaming' | 'aborted_tools' | 'max_turns' | 'prompt_too_long' | 'error'
export type SystemPromptValue = string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
export interface QueryResult { reason: QueryExitReason; messages: Message[]; error?: string; errorCode?: string; partial?: ModelResult; contextCompacted?: boolean }
export interface QueryDeps {
  client: ApiClient
  tools: BuiltTool[]
  systemPrompt: SystemPromptValue | (() => SystemPromptValue)
  model: string
  correlation?: CorrelationContext
  fallbackModel?: string
  retryPolicy?: Partial<RetryPolicy>
  maxOutputTokens: number
  maxTurns: number
  context: ToolUseContext
  canUseTool: CanUseTool
  backgroundManager?: BackgroundTaskManager
  backgroundSessionId?: string
  beforeModel?: () => Promise<void>
  autoCompact?: (messages: Message[]) => Promise<Message[] | null>
  reactiveCompact?: (messages: Message[]) => Promise<Message[] | null>
  compact?: (messages: Message[]) => Promise<Message[] | null>
  runToolsOptions?: Omit<RunToolsOptions, 'canUseTool'>
  prepareContext?: (messages: Message[]) => Message[] | Promise<Message[]>
  onRecovery?: (info: { kind: string; attempt?: number; model?: string; delayMs?: number }) => void
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
const CONTINUATION_PROMPT = 'Continue from where you left off. Do not repeat completed work.'

function systemValue(value: QueryDeps['systemPrompt']): SystemPromptValue { return typeof value === 'function' ? value() : value }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export async function query(initialMessages: Message[], deps: QueryDeps): Promise<QueryResult> {
  let messages = [...initialMessages]
  let turns = 0
  let outputOverride: number | undefined
  let contextCompacted = false
  const recovery = createRecoveryState(deps.model)
  while (true) {
    if (deps.context.abortController.signal.aborted) return { reason: 'aborted_streaming', messages, contextCompacted }
    if (turns >= deps.maxTurns) return { reason: 'max_turns', messages, contextCompacted }
    try { await deps.beforeModel?.() } catch (error) { return { reason: 'error', messages, error: errorMessage(error), contextCompacted } }

    const notifications = deps.backgroundManager?.drainNotifications(deps.backgroundSessionId) ?? []
    if (notifications.length) messages = [...messages, ...notifications.map(notification => ({ role: 'user' as const, content: notification }))]
    const queued = deps.injectMessages?.() ?? []
    if (queued.length) messages = [...messages, ...queued]
    if (deps.prepareContext) {
      try {
        const before = JSON.stringify(messages)
        messages = await deps.prepareContext(messages)
        if (JSON.stringify(messages) !== before) contextCompacted = true
      } catch (error) { return { reason: 'error', messages, error: errorMessage(error), contextCompacted } }
    }
    if (deps.autoCompact) {
      const compacted = await deps.autoCompact(messages).catch(() => null)
      if (compacted) {
        messages = compacted
        contextCompacted = true
        if (deps.prepareContext) {
          try { messages = await deps.prepareContext(messages) } catch (error) { return { reason: 'error', messages, error: errorMessage(error), contextCompacted } }
        }
      }
    }

    let requestId = newRequestId()
    deps.context.eventLogger?.record('model_request_start', deps.correlation, { model: recovery.currentModel })
    const modelResult = await retryModelCall(model => {
      requestId = newRequestId()
      if (deps.correlation) deps.correlation.requestId = requestId
      return deps.client.callModel({
        model,
        messages,
        system: systemValue(deps.systemPrompt),
        tools: deps.tools.map(tool => ({ name: tool.name, description: tool.prompt(), input_schema: tool.jsonSchema })),
        max_tokens: outputOverride ?? deps.maxOutputTokens,
      }, {
        onEvent: event => { deps.onStreamEvent?.(event); if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') deps.onTextDelta?.(event.delta.text ?? '') },
        signal: deps.context.abortController.signal,
        requestId,
        sessionId: deps.correlation?.sessionId,
        turnId: deps.correlation?.turnId,
      })
    }, {
      state: recovery,
      policy: deps.retryPolicy,
      fallbackModel: deps.fallbackModel,
      signal: deps.context.abortController.signal,
      onRetry: info => { deps.onRecovery?.({ kind: 'retry', attempt: info.attempt, model: info.model, delayMs: info.delayMs }) },
    }).catch(error => ({ error }))

    if ('error' in modelResult) {
      const error = modelResult.error
      deps.context.eventLogger?.record('model_request_error', deps.correlation, { error: errorMessage(error), code: error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : undefined })
      if (error instanceof RequestAbortedError) return { reason: 'aborted_streaming', messages, contextCompacted }
      if (error instanceof ApiError && error.isPromptTooLong) {
        if (!recovery.reactiveCompactUsed && (deps.reactiveCompact ?? deps.compact ?? deps.autoCompact)) {
          recovery.reactiveCompactUsed = true
          deps.onRecovery?.({ kind: 'reactive_compact' })
          const compact = deps.reactiveCompact ?? deps.compact ?? deps.autoCompact
          const compacted = await compact!(messages).catch(() => null)
          if (compacted) { messages = compacted; contextCompacted = true; continue }
        }
        return { reason: 'prompt_too_long', messages, error: error.message, errorCode: error.code, contextCompacted }
      }
      if (error instanceof ApiError && error.isMaxOutputTokens) {
        if (!recovery.hasEscalated) {
          recovery.hasEscalated = true
          outputOverride = MAX_OUTPUT_TOKENS_ESCALATION
          deps.onRecovery?.({ kind: 'output_escalation', model: recovery.currentModel })
          continue
        }
        if (recovery.outputRecoveries < MAX_OUTPUT_TOKEN_RECOVERIES) {
          recovery.outputRecoveries++
          messages = [...messages, { role: 'user', content: CONTINUATION_PROMPT }]
          deps.onRecovery?.({ kind: 'continuation', attempt: recovery.outputRecoveries, model: recovery.currentModel })
          continue
        }
      }
      const partial = error && typeof error === 'object' && 'partial' in error ? (error as { partial?: ModelResult }).partial : undefined
      return { reason: 'error', messages, error: errorMessage(error), errorCode: error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : undefined, partial, contextCompacted }
    }

    const result = modelResult.value
    deps.context.eventLogger?.record('model_request_end', deps.correlation ? { ...deps.correlation, requestId: result.requestId, attempt: recovery.networkAttempts } : undefined, { model: modelResult.model, stopReason: result.stopReason, partial: result.partial })
    turns++
    if (result.usage) deps.onUsage?.(modelResult.model, result.usage)
    if (result.interrupted || result.partial) return { reason: result.interrupted ? 'aborted_streaming' : 'error', messages, error: result.interrupted ? 'Request interrupted' : 'Incomplete model response', errorCode: result.interrupted ? 'aborted' : 'incomplete_stream', partial: result, contextCompacted }

    const assistantBlocks = result.content
    messages = [...messages, { role: 'assistant', content: assistantBlocksForNextTurn(assistantBlocks) }]
    if (result.stopReason === 'max_tokens') {
      if (!recovery.hasEscalated) {
        recovery.hasEscalated = true
        outputOverride = MAX_OUTPUT_TOKENS_ESCALATION
        deps.onRecovery?.({ kind: 'output_escalation', model: modelResult.model })
        continue
      }
      if (recovery.outputRecoveries < MAX_OUTPUT_TOKEN_RECOVERIES) {
        recovery.outputRecoveries++
        messages = [...messages, { role: 'user', content: CONTINUATION_PROMPT }]
        deps.onRecovery?.({ kind: 'continuation', attempt: recovery.outputRecoveries, model: modelResult.model })
        continue
      }
    } else {
      recovery.hasEscalated = false
      recovery.outputRecoveries = 0
      outputOverride = undefined
    }

    const toolUse = assistantBlocks.filter((block): block is ToolUseBlock => block.type === 'tool_use')
    if (!toolUse.length) return { reason: 'completed', messages, contextCompacted }
    try {
      const toolMessages = await runTools(toolUse, deps.tools, deps.context, { ...deps.runToolsOptions, backgroundManager: deps.backgroundManager, canUseTool: deps.canUseTool, onPreToolUse: deps.onPreToolUse, onPostToolUse: deps.onPostToolUse, onToolStart: deps.onToolStart, onToolEnd: deps.onToolEnd })
      messages = [...messages, ...toolMessages]
    } catch (error) {
      const synthetic = yieldMissingToolResultBlocks(assistantBlocks, [])
      if (synthetic) messages = [...messages, synthetic]
      if (deps.context.abortController.signal.aborted || error instanceof RequestAbortedError) return { reason: 'aborted_tools', messages, contextCompacted }
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
