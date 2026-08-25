import type { ApiClient } from '../api/client.js'
import type { Message } from '../api/types.js'

export const DEFAULT_CONTEXT_WINDOW = 400_000
export const SUMMARY_OUTPUT_BUDGET = 20_000
export const COMPACT_BUFFER = 13_000
export const MAX_CONSECUTIVE_FAILURES = 3
let consecutiveFailures = 0
export function resetCompactionState(): void { consecutiveFailures = 0 }
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
export function estimateTokens(messages: Message[]): number { return messages.reduce((sum, message) => sum + blockText(message.content).length, 0) / 4 }
export function shouldAutoCompact(messages: Message[], contextWindow = DEFAULT_CONTEXT_WINDOW): boolean { return estimateTokens(messages) >= contextWindow - SUMMARY_OUTPUT_BUDGET - COMPACT_BUFFER }
function transcript(messages: Message[]): string { return messages.map(message => `[${message.role === 'user' ? 'User' : 'Assistant'}]\n${blockText(message.content).slice(0, 2000)}`).join('\n\n').slice(0, 100_000) }
export interface CompactOptions { client: ApiClient; model: string; hooks?: { pre?: (messages: Message[]) => Promise<void>; post?: (messages: Message[]) => Promise<void> } }
export async function compactConversation(messages: Message[], options: CompactOptions): Promise<Message[] | null> {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null
  const keepCount = Math.min(2, messages.length); const toSummarize = messages.slice(0, -keepCount); const keep = messages.slice(-keepCount)
  if (!toSummarize.length) return null
  await options.hooks?.pre?.(toSummarize).catch(() => undefined)
  try {
    const result = await options.client.callOnce({ model: options.model, max_tokens: Math.min(SUMMARY_OUTPUT_BUDGET, 8192), system: 'Summarize the conversation, preserving files, decisions, current task, and unresolved questions. Output only the summary.', messages: [{ role: 'user', content: transcript(toSummarize) }] })
    const summary = blockText(result.content).trim()
    if (!summary) throw new Error('Empty summary')
    consecutiveFailures = 0
    const compacted: Message[] = [{ role: 'user', content: `<context_compaction>\nThis conversation was compacted. Summary of earlier turns:\n\n${summary}\n</context_compaction>` }, ...keep]
    await options.hooks?.post?.(compacted).catch(() => undefined)
    return compacted
  } catch { consecutiveFailures++; return null }
}
export function createAutoCompact(options: CompactOptions & { contextWindow?: number }) { return (messages: Message[]) => shouldAutoCompact(messages, options.contextWindow ?? DEFAULT_CONTEXT_WINDOW) ? compactConversation(messages, options) : Promise.resolve(null) }
