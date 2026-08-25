import type { ContentBlock, Message, ToolResultBlock } from '../services/api/types.js'

export function collectToolResults(content: unknown): ToolResultBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ToolResultBlock => Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result'))
}

export function yieldMissingToolResultBlocks(assistantContent: ContentBlock[], existingResults: ToolResultBlock[] = []): Message | null {
  const present = new Set(existingResults.map(result => result.tool_use_id))
  const missing = assistantContent
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use' && !present.has(block.id))
    .map(block => ({ type: 'tool_result' as const, tool_use_id: block.id, content: 'Interrupted', is_error: true }))
  return missing.length ? { role: 'user', content: missing } : null
}
