import type { Message, ContentBlock, SystemBlock } from '../../services/api/types.js'

export interface ContextBudgetOptions {
  maxToolResultChars?: number
  preserveRecentToolResults?: number
  maxMessages?: number
}

const COMPACTED_TOOL_RESULT = '[Earlier tool result compacted. Re-run the tool if needed.]'

function blocksOf(message: Message): ContentBlock[] { return Array.isArray(message.content) ? message.content : [] }
function isToolResult(block: ContentBlock): block is Extract<ContentBlock, { type: 'tool_result' }> { return block.type === 'tool_result' }
function hasToolUse(message: Message): boolean { return blocksOf(message).some(block => block.type === 'tool_use') }
function isToolResultMessage(message: Message): boolean { return message.role === 'user' && blocksOf(message).some(isToolResult) }
function blockContentLength(block: Extract<ContentBlock, { type: 'tool_result' }>): number { return typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length }
function cloneMessage(message: Message): Message { return Array.isArray(message.content) ? { ...message, content: message.content.map(block => ({ ...block })) } : { ...message } }

export function estimateContextTokens(messages: Message[], system?: string | SystemBlock[], tools?: unknown): number {
  const messageChars = JSON.stringify(messages).length
  const systemChars = system === undefined ? 0 : JSON.stringify(system).length
  const toolChars = tools === undefined ? 0 : JSON.stringify(tools).length
  return (messageChars + systemChars + toolChars) / 4
}

export function toolResultBudget(messages: Message[], maxChars = 200_000, preserveRecent = 3): Message[] {
  const next = messages.map(cloneMessage)
  const refs: Array<{ block: Extract<ContentBlock, { type: 'tool_result' }>; length: number }> = []
  for (const message of next) for (const block of blocksOf(message)) if (isToolResult(block)) refs.push({ block, length: blockContentLength(block) })
  let total = refs.reduce((sum, item) => sum + item.length, 0)
  if (total <= maxChars || refs.length <= preserveRecent) return next
  for (const item of refs.slice(0, Math.max(0, refs.length - preserveRecent)).sort((a, b) => b.length - a.length)) {
    if (total <= maxChars) break
    if (typeof item.block.content === 'string' && item.block.content.startsWith('<persisted-tool-result>')) {
      total -= item.length - item.block.content.length
      continue
    }
    item.block.content = COMPACTED_TOOL_RESULT
    total -= item.length - COMPACTED_TOOL_RESULT.length
  }
  return next
}

export function microCompact(messages: Message[], options: Pick<ContextBudgetOptions, 'maxToolResultChars' | 'preserveRecentToolResults'> = {}): Message[] {
  return toolResultBudget(messages, options.maxToolResultChars ?? 200_000, options.preserveRecentToolResults ?? 3)
}

export function snipCompact(messages: Message[], maxMessages = 50): Message[] {
  if (messages.length <= maxMessages) return messages.map(cloneMessage)
  let headEnd = Math.min(3, messages.length)
  while (headEnd < messages.length && hasToolUse(messages[headEnd - 1]!)) {
    if (!isToolResultMessage(messages[headEnd]!)) break
    headEnd++
  }
  const tailCount = Math.max(0, maxMessages - headEnd - 1)
  let tailStart = Math.max(headEnd, messages.length - tailCount)
  if (tailStart > 0 && tailStart < messages.length && isToolResultMessage(messages[tailStart]!) && hasToolUse(messages[tailStart - 1]!)) tailStart--
  if (headEnd >= tailStart) return messages.map(cloneMessage)
  const omitted = tailStart - headEnd
  return [
    ...messages.slice(0, headEnd).map(cloneMessage),
    { role: 'user', content: `[snipped ${omitted} messages; earlier details are available in the session transcript]` },
    ...messages.slice(tailStart).map(cloneMessage),
  ]
}

export function prepareContext(messages: Message[], options: ContextBudgetOptions = {}): Message[] {
  const budgeted = microCompact(messages, options)
  return snipCompact(budgeted, options.maxMessages ?? 50)
}
