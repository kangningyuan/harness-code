import type { ContentBlock, ModelResult, StreamEvent, ToolUseBlock, Usage } from './types.js'

export class RequestAbortedError extends Error {
  constructor(message = 'Request aborted') { super(message); this.name = 'RequestAbortedError' }
}

function usageFrom(value: Record<string, unknown> | undefined): Usage | undefined {
  if (!value) return undefined
  const n = (key: string) => typeof value[key] === 'number' ? value[key] as number : 0
  return { inputTokens: n('input_tokens'), outputTokens: n('output_tokens'), cacheReadInputTokens: n('cache_read_input_tokens'), cacheCreationInputTokens: n('cache_creation_input_tokens') }
}

export class StreamAccumulator {
  private content: ContentBlock[] = []
  private stopReason: string | null = null
  private usage: Usage | undefined
  private currentIndex = -1
  private toolJson = ''
  private toolBlock: ToolUseBlock | undefined
  private started = false

  add(event: StreamEvent): void {
    this.started = true
    if (event.type === 'message_start') {
      const usage = event.message?.usage as Record<string, unknown> | undefined
      this.usage = usageFrom(usage)
      return
    }
    if (event.type === 'content_block_start') {
      this.currentIndex = event.index ?? this.content.length
      const block = event.content_block
      if (block?.type === 'tool_use') {
        this.toolJson = ''
        this.toolBlock = { type: 'tool_use', id: block.id, name: block.name, input: {} }
        this.content[this.currentIndex] = this.toolBlock
      } else if (block?.type === 'text') {
        this.toolBlock = undefined
        this.content[this.currentIndex] = { type: 'text', text: block.text }
      } else if (block) {
        this.toolBlock = undefined
        this.content[this.currentIndex] = block
      }
      return
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta ?? {}
      if (delta.type === 'text_delta') {
        const existing = this.content[this.currentIndex]
        if (existing?.type === 'text') existing.text += delta.text ?? ''
        else this.content[this.currentIndex] = { type: 'text', text: delta.text ?? '' }
      } else if (delta.type === 'input_json_delta') {
        this.toolJson += delta.partial_json ?? ''
        if (this.toolBlock) {
          try { this.toolBlock.input = JSON.parse(this.toolJson) as Record<string, unknown> } catch { /* partial JSON */ }
        }
      }
      return
    }
    if (event.type === 'message_delta') {
      const delta = event.delta ?? {}
      if (delta.stop_reason !== undefined) this.stopReason = delta.stop_reason ?? null
      const usage = event.usage ?? (event.delta?.usage as Record<string, unknown> | undefined)
      const parsed = usageFrom(usage)
      if (parsed) this.usage = {
        inputTokens: parsed.inputTokens || this.usage?.inputTokens || 0,
        outputTokens: parsed.outputTokens || this.usage?.outputTokens || 0,
        cacheReadInputTokens: parsed.cacheReadInputTokens || this.usage?.cacheReadInputTokens || 0,
        cacheCreationInputTokens: parsed.cacheCreationInputTokens || this.usage?.cacheCreationInputTokens || 0,
      }
      return
    }
    if (event.type === 'message_stop') return
  }

  finalize(): ModelResult {
    return { content: this.content.filter((block): block is ContentBlock => Boolean(block)), stopReason: this.stopReason, usage: this.usage }
  }
  hasContent(): boolean { return this.content.length > 0 || this.started }
}

export function parseSseLines(text: string, onEvent: (event: StreamEvent) => void): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try { onEvent(JSON.parse(data) as StreamEvent) } catch { /* ignore malformed SSE data */ }
  }
}

export async function consumeSse(response: Response, accumulator: StreamAccumulator, onEvent?: (event: StreamEvent) => void, signal?: AbortSignal): Promise<ModelResult> {
  if (!response.body) throw new Error('API response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consumeLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const event = JSON.parse(data) as StreamEvent
      accumulator.add(event)
      onEvent?.(event)
    } catch { /* malformed event is ignored */ }
  }
  try {
    while (true) {
      if (signal?.aborted) throw new RequestAbortedError()
      const { done, value } = await reader.read()
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) consumeLine(line)
      if (done) {
        // SSE producers are allowed to close without a final newline.
        if (buffer) consumeLine(buffer)
        buffer = ''
        break
      }
    }
  } catch (error) {
    if (error instanceof RequestAbortedError || signal?.aborted) {
      if (accumulator.finalize().content.length > 0) return accumulator.finalize()
      throw new RequestAbortedError()
    }
    throw error
  } finally { reader.releaseLock() }
  return accumulator.finalize()
}
