import type { ApiClient } from '../api/client.js'
import type { Message } from '../api/types.js'

export const DEFAULT_CONTEXT_WINDOW = 400_000
export const SUMMARY_OUTPUT_BUDGET = 20_000
export const COMPACT_BUFFER = 13_000
export const MAX_CONSECUTIVE_FAILURES = 3
export interface CompactionState { consecutiveFailures: number; lastFailure?: string }
let legacyState: CompactionState = { consecutiveFailures: 0 }
export function resetCompactionState(): void { legacyState = { consecutiveFailures: 0 } }
function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (!block || typeof block !== 'object') return ''
    const value = block as Record<string, unknown>
    if (value.type === 'text') return String(value.text ?? '')
    if (value.type === 'tool_use') return `[tool_use: ${String(value.name ?? '')}] ${JSON.stringify(value.input ?? {}).slice(0, 500)}`
    if (value.type === 'tool_result') return `[tool_result] ${String(value.content ?? '').slice(0, 1000)}`
    return ''
  }).join('\n')
}
function hasToolUse(message: Message): boolean { return Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use') }
function isToolResultMessage(message: Message): boolean { return message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result') }
function recentMessages(messages: Message[], count: number): Message[] {
  let start = Math.max(0, messages.length - count)
  if (start > 0 && isToolResultMessage(messages[start]!) && hasToolUse(messages[start - 1]!)) start--
  return messages.slice(start)
}
export function estimateTokens(messages: Message[]): number { return messages.reduce((sum, message) => sum + blockText(message.content).length, 0) / 4 }
export function shouldAutoCompact(messages: Message[], contextWindow = DEFAULT_CONTEXT_WINDOW): boolean { return estimateTokens(messages) >= contextWindow - SUMMARY_OUTPUT_BUDGET - COMPACT_BUFFER }
function transcript(messages: Message[]): string { return messages.map(message => `[${message.role === 'user' ? 'User' : 'Assistant'}]\n${blockText(message.content).slice(0, 2000)}`).join('\n\n').slice(0, 100_000) }
export interface CompactOptions { client: ApiClient; model: string; state?: CompactionState; hooks?: { pre?: (messages: Message[]) => Promise<void>; post?: (messages: Message[]) => Promise<void> } }

export async function reactiveCompactConversation(messages: Message[], options: CompactOptions): Promise<Message[] | null> {
  const state = options.state ?? legacyState
  const keepCount = Math.min(5, messages.length)
  const keep = recentMessages(messages, keepCount)
  const toSummarize = messages.slice(0, messages.length - keep.length)
  if (!toSummarize.length) return null
  await options.hooks?.pre?.(toSummarize).catch(() => undefined)
  let summary = ''
  try {
    const result = await options.client.callOnce({ model: options.model, max_tokens: Math.min(SUMMARY_OUTPUT_BUDGET, 8192), system: 'Summarize enough context to recover from a prompt-too-long error. Preserve the goal, files, decisions, and unresolved work. Output only the summary.', messages: [{ role: 'user', content: transcript(toSummarize) }] })
    summary = blockText(result.content).trim()
    if (!summary) throw new Error('Empty summary')
    state.consecutiveFailures = 0
    state.lastFailure = undefined
  } catch (error) {
    state.consecutiveFailures++
    state.lastFailure = error instanceof Error ? error.message : String(error)
    summary = 'Earlier context was trimmed after a prompt-too-long error; continue from the preserved recent messages.'
  }
  const compacted: Message[] = [{ role: 'user', content: `<context_compaction>\n${summary}\n</context_compaction>` }, ...keep]
  await options.hooks?.post?.(compacted).catch(() => undefined)
  return compacted
}

export async function compactConversation(messages: Message[], options: CompactOptions): Promise<Message[] | null> {
  const state = options.state ?? legacyState
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null
  const keepCount = Math.min(2, messages.length); const keep = recentMessages(messages, keepCount); const toSummarize = messages.slice(0, messages.length - keep.length)
  if (!toSummarize.length) return null
  await options.hooks?.pre?.(toSummarize).catch(() => undefined)
  try {
    const result = await options.client.callOnce({ model: options.model, max_tokens: Math.min(SUMMARY_OUTPUT_BUDGET, 8192), system: 'Summarize the conversation, preserving files, decisions, current task, and unresolved questions. Output only the summary.', messages: [{ role: 'user', content: transcript(toSummarize) }] })
    const summary = blockText(result.content).trim()
    if (!summary) throw new Error('Empty summary')
    state.consecutiveFailures = 0
    state.lastFailure = undefined
    const compacted: Message[] = [{ role: 'user', content: `<context_compaction>\nThis conversation was compacted. Summary of earlier turns:\n\n${summary}\n</context_compaction>` }, ...keep]
    await options.hooks?.post?.(compacted).catch(() => undefined)
    return compacted
  } catch (error) { state.consecutiveFailures++; state.lastFailure = error instanceof Error ? error.message : String(error); return null }
}
export function createAutoCompact(options: CompactOptions & { contextWindow?: number; estimate?: (messages: Message[]) => number }) { return (messages: Message[]) => (options.estimate ? options.estimate(messages) >= (options.contextWindow ?? DEFAULT_CONTEXT_WINDOW) - SUMMARY_OUTPUT_BUDGET - COMPACT_BUFFER : shouldAutoCompact(messages, options.contextWindow ?? DEFAULT_CONTEXT_WINDOW)) ? compactConversation(messages, options) : Promise.resolve(null) }
