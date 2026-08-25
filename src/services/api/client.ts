import type { ApiConfig, MessageCreateParams, ModelResult, StreamEvent } from './types.js'
import { consumeSse, RequestAbortedError, StreamAccumulator } from './stream.js'

export { RequestAbortedError }

export class RequestTimeoutError extends Error {
  constructor(message = 'API request timed out') { super(message); this.name = 'RequestTimeoutError' }
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(message: string, status = 0, code?: string) { super(message); this.name = 'ApiError'; this.status = status; this.code = code }
  get isPromptTooLong(): boolean { return this.status === 413 || this.code === 'prompt_too_long' || /prompt.?too.?long|context.?length/i.test(this.message) }
  get isMaxOutputTokens(): boolean { return this.code === 'max_output_tokens' || this.code === 'output_length' || /max.?output|output.?length/i.test(this.message) }
}

export interface CallModelOptions { onEvent?: (event: StreamEvent) => void; signal?: AbortSignal }

function endpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return /\/v\d+\/messages$/.test(base) ? base : `${base}/v1/messages`
}
function jsonError(value: unknown): { message: string; code?: string } {
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const nested = obj.error && typeof obj.error === 'object' ? obj.error as Record<string, unknown> : obj
    return { message: String(nested.message ?? obj.message ?? 'API request failed'), code: typeof nested.type === 'string' ? nested.type : typeof nested.code === 'string' ? nested.code : undefined }
  }
  return { message: String(value ?? 'API request failed') }
}
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' }

export class ApiClient {
  constructor(private readonly config: ApiConfig) {}

  async callModel(params: MessageCreateParams, options: CallModelOptions = {}): Promise<ModelResult> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.config.timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(endpoint(this.config.baseURL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': this.config.apiKey ?? '',
          authorization: `Bearer ${this.config.apiKey ?? ''}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ ...params, stream: true }),
        signal: controller.signal,
      })
      if (!response.ok) {
        let body: unknown = undefined
        try { body = await response.json() } catch { body = await response.text().catch(() => undefined) }
        const parsed = jsonError(body)
        throw new ApiError(parsed.message, response.status, parsed.code)
      }
      return await consumeSse(response, new StreamAccumulator(), options.onEvent, options.signal)
    } catch (error) {
      if (options.signal?.aborted) throw new RequestAbortedError()
      if (timedOut) throw new RequestTimeoutError()
      if (isAbortError(error)) throw new RequestAbortedError()
      throw error
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async callOnce(params: Omit<MessageCreateParams, 'stream'>): Promise<ModelResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const response = await fetch(endpoint(this.config.baseURL), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': this.config.apiKey ?? '', authorization: `Bearer ${this.config.apiKey ?? ''}`, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ ...params, stream: false }),
        signal: controller.signal,
      })
      if (!response.ok) {
        let body: unknown
        try { body = await response.json() } catch { body = await response.text().catch(() => undefined) }
        const parsed = jsonError(body); throw new ApiError(parsed.message, response.status, parsed.code)
      }
      const raw = await response.json() as Record<string, unknown>
      const content = Array.isArray(raw.content) ? raw.content : []
      const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage as Record<string, number> : undefined
      return {
        content: content as ModelResult['content'],
        stopReason: typeof raw.stop_reason === 'string' ? raw.stop_reason : null,
        usage: usage ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0, cacheReadInputTokens: usage.cache_read_input_tokens ?? 0, cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0 } : undefined,
        id: typeof raw.id === 'string' ? raw.id : undefined,
        model: typeof raw.model === 'string' ? raw.model : undefined,
      }
    } catch (error) {
      if (isAbortError(error)) throw new RequestTimeoutError()
      throw error
    } finally { clearTimeout(timer) }
  }
}
