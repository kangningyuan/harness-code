import { ApiClient, ApiError, RequestAbortedError, RequestTimeoutError } from '../../src/services/api/client.js'

describe('ApiClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts an Anthropic-compatible streaming request and parses the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ apiKey: 'secret', baseURL: 'https://example.test/api', model: 'test', smallModel: 'small', maxOutputTokens: 32, timeoutMs: 1000 })
    const result = await client.callModel({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 })
    expect(result).toMatchObject({ stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { outputTokens: 2 } })
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/v1/messages', expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-api-key': 'secret', authorization: 'Bearer secret', accept: 'text/event-stream' }) }))
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({ stream: true, model: 'test' })
  })

  it('classifies structured HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { type: 'prompt_too_long', message: 'context length exceeded' } }), { status: 413, headers: { 'content-type': 'application/json' } })))
    const client = new ApiClient({ apiKey: 'secret', baseURL: 'https://example.test', model: 'test', smallModel: 'small', maxOutputTokens: 32, timeoutMs: 1000 })
    const error = await client.callModel({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }).catch(value => value)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 413, code: 'prompt_too_long' })
    expect((error as ApiError).isPromptTooLong).toBe(true)
  })

  it('distinguishes caller abort from request timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
      const signal = init.signal
      if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'))
      else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      void resolve
    })))
    const config = { apiKey: 'secret', baseURL: 'https://example.test', model: 'test', smallModel: 'small', maxOutputTokens: 32, timeoutMs: 10 }
    const client = new ApiClient(config)
    const caller = new AbortController()
    caller.abort()
    await expect(client.callModel({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }, { signal: caller.signal })).rejects.toBeInstanceOf(RequestAbortedError)
    await expect(client.callModel({ model: 'test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 })).rejects.toBeInstanceOf(RequestTimeoutError)
  })
})
