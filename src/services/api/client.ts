import type { ApiConfig, MessageCreateParams, ModelResult, StreamEvent } from './types.js'
import { newRequestId } from '../protocol/ids.js'
import { consumeSse, RequestAbortedError, StreamAccumulator, StreamIncompleteError } from './stream.js'

export { RequestAbortedError }

export class RequestTimeoutError extends Error {
  constructor(message = 'API request timed out') { super(message); this.name = 'RequestTimeoutError' }
}

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly retryAfterMs?: number
  constructor(message: string, status = 0, code?: string, retryAfterMs?: number) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.retryAfterMs = retryAfterMs }
  get isPromptTooLong(): boolean { return this.status === 413 || this.code === 'prompt_too_long' || /prompt.?too.?long|context.?length/i.test(this.message) }
  get isMaxOutputTokens(): boolean { return this.code === 'max_output_tokens' || this.code === 'output_length' || /max.?output|output.?length/i.test(this.message) }
  get isRateLimited(): boolean { return this.status === 429 || /rate.?limit|too.?many.?requests/i.test(this.code ?? '') }
  get isOverloaded(): boolean { return this.status === 529 || /overload|capacity/i.test(this.code ?? '') }
  get isRetryable(): boolean { return this.status === 408 || this.status === 409 || this.status === 429 || (this.status >= 500 && this.status <= 599) || this.code === 'overloaded' || this.code === 'rate_limit_error' }
}

export interface CallModelOptions { onEvent?: (event: StreamEvent) => void; signal?: AbortSignal; requestId?: string; sessionId?: string; turnId?: string }
export interface CallOnceOptions { signal?: AbortSignal }

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
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

export class ApiClient {
  constructor(private readonly config: ApiConfig) {}

  async callModel(params: MessageCreateParams, options: CallModelOptions = {}): Promise<ModelResult> {
    const controller = new AbortController()
    const requestId = options.requestId ?? newRequestId()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.config.timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) controller.abort()
    try {
      const response = await fetch(endpoint(this.config.baseURL), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-api-key': this.config.apiKey ?? '',
          authorization: `Bearer ${this.config.apiKey ?? ''}`,
          'anthropic-version': '2023-06-01',
          'x-harness-request-id': requestId,
          ...(options.sessionId ? { 'x-harness-session-id': options.sessionId } : {}),
          ...(options.turnId ? { 'x-harness-turn-id': options.turnId } : {}),
        },
        body: JSON.stringify({ ...params, stream: true }),
        signal: controller.signal,
      })
      if (!response.ok) {
        let body: unknown = undefined
        try { body = await response.json() } catch { body = await response.text().catch(() => undefined) }
        const parsed = jsonError(body)
        throw new ApiError(parsed.message, response.status, parsed.code, parseRetryAfter(response.headers.get('retry-after')))
      }
      const result = await consumeSse(response, new StreamAccumulator(), options.onEvent, options.signal, { strict: this.config.strictStreamProtocol })
      return { ...result, requestId, remoteRequestId: response.headers.get('x-request-id') ?? undefined }
    } catch (error) {
      if (options.signal?.aborted) throw new RequestAbortedError()
      if (timedOut) { if (error instanceof StreamIncompleteError && error.partial) throw error; throw new RequestTimeoutError() }
      if (isAbortError(error)) throw new RequestAbortedError()
      throw error
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort)
    }
  }

  async callOnce(params: Omit<MessageCreateParams, 'stream'>, options: CallOnceOptions = {}): Promise<ModelResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) controller.abort()
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
        const parsed = jsonError(body); throw new ApiError(parsed.message, response.status, parsed.code, parseRetryAfter(response.headers.get('retry-after')))
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
      if (options.signal?.aborted) throw new RequestAbortedError()
      if (isAbortError(error)) throw new RequestTimeoutError()
      throw error
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort) }
  }
}
