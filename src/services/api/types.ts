export type Role = 'user' | 'assistant'

export interface TextBlock { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
export interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
export interface RedactedThinkingBlock { type: 'redacted_thinking'; data: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ToolResultBlock
export type MessageContent = string | ContentBlock[]
export interface Message { role: Role; content: MessageContent }
export type SystemBlock = TextBlock

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}

export interface ApiConfig {
  apiKey?: string
  baseURL: string
  model: string
  smallModel: string
  maxOutputTokens: number
  timeoutMs: number
  models?: ModelEntry[]
  fallbackModel?: string
  maxRetries?: number
  retryBaseDelayMs?: number
  strictStreamProtocol?: boolean
  configFilePath?: string
}
export interface ModelEntry { id: string; name?: string; maxOutputTokens?: number }

export interface MessageCreateParams {
  model: string
  messages: Message[]
  system?: string | SystemBlock[]
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  max_tokens: number
  stream?: boolean
}

export interface ModelResult {
  content: ContentBlock[]
  stopReason: string | null
  usage?: Usage
  id?: string
  model?: string
  requestId?: string
  remoteRequestId?: string
  lastEventId?: string
  eventCount?: number
  partial?: boolean
  interrupted?: boolean
  streamComplete?: boolean
  errorCode?: string
}

export interface StreamEvent {
  type: string
  eventId?: string
  index?: number
  message?: { content?: ContentBlock[]; usage?: Record<string, unknown>; stop_reason?: string | null }
  content_block?: ContentBlock
  delta?: Record<string, unknown> & { type?: string; text?: string; partial_json?: string; stop_reason?: string | null }
  usage?: Record<string, unknown>
}
