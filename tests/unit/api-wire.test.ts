import { ApiClient, ApiError, RequestAbortedError, RequestTimeoutError } from '../../src/services/api/client.js'

function client(overrides: Partial<{ timeoutMs: number; strictStreamProtocol: boolean }> = {}): ApiClient {
  return new ApiClient({ apiKey: 'test-key', baseURL: 'https://example.test/', model: 'model', smallModel: 'small', maxOutputTokens: 128, timeoutMs: overrides.timeoutMs ?? 1_000, strictStreamProtocol: overrides.strictStreamProtocol ?? true })
}

describe('API wire contract', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('normalizes the messages endpoint and sends a stream body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('id: e1\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2}}}\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\ndata: {"type":"message_stop"}\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)
    await client().callModel({ model: 'model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 128 }, { requestId: 'req', sessionId: 'session', turnId: 'turn' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/v1/messages')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'model', stream: true })
    expect((init.headers as Record<string, string>)['x-harness-request-id']).toBe('req')
  })

  it.each([
    [429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate_limit_error'],
    [503, { message: 'overloaded' }, undefined],
    [400, 'plain failure', undefined],
  ])('maps HTTP %s responses to ApiError', async (status, body, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', 'retry-after': '2' } })))
    const error = await client().callModel({ model: 'model', messages: [], max_tokens: 1 }).catch(value => value)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status, code, retryAfterMs: 2_000 })
    expect((error as ApiError).isRetryable).toBe(status === 429 || status === 503)
  })

  it('parses retry-after HTTP dates without producing negative delays', async () => {
    const future = new Date(Date.now() + 3_000).toUTCString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429, headers: { 'retry-after': future } })))
    const error = await client().callModel({ model: 'model', messages: [], max_tokens: 1 }).catch(value => value) as ApiError
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(0)
    expect(error.retryAfterMs).toBeLessThanOrEqual(3_000)
  })

  it('distinguishes caller abort from the client timeout', async () => {
    const caller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      caller.signal.addEventListener('abort', () => undefined, { once: true })
    })))
    const pending = client({ timeoutMs: 500 }).callModel({ model: 'model', messages: [], max_tokens: 1 }, { signal: caller.signal })
    caller.abort()
    await expect(pending).rejects.toBeInstanceOf(RequestAbortedError)

    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))))
    await expect(client({ timeoutMs: 1 }).callModel({ model: 'model', messages: [], max_tokens: 1 })).rejects.toBeInstanceOf(RequestTimeoutError)
  })

  it('maps non-stream callOnce content and usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'msg-1', model: 'model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 4, output_tokens: 5 } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await client().callOnce({ model: 'small', messages: [{ role: 'user', content: 'x' }], max_tokens: 10 })
    expect(result).toMatchObject({ id: 'msg-1', model: 'model', stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 5 } })
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toMatchObject({ stream: false })
  })
})
