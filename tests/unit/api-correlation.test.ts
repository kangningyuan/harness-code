import { ApiClient } from '../../src/services/api/client.js'

describe('API correlation', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('propagates request identifiers and captures SSE event metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('id: 1\ndata: {"type":"message_start"}\nid: 2\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"ok"}}\nid: 3\ndata: {"type":"message_stop"}\n', { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'remote-1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ apiKey: 'secret', baseURL: 'https://example.test', model: 'model', smallModel: 'small', maxOutputTokens: 32, timeoutMs: 1000 })
    const result = await client.callModel({ model: 'model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }, { requestId: 'local-1', sessionId: 'session-1', turnId: 'turn-1' })
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['x-harness-request-id']).toBe('local-1')
    expect(headers['x-harness-session-id']).toBe('session-1')
    expect(headers['x-harness-turn-id']).toBe('turn-1')
    expect(result).toMatchObject({ requestId: 'local-1', remoteRequestId: 'remote-1', lastEventId: '3', streamComplete: true })
    expect(result.eventCount).toBe(3)
  })
})
