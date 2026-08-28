import { consumeSse, RequestAbortedError, StreamAccumulator, StreamIncompleteError, StreamProtocolError, parseSseLines } from '../../src/services/api/stream.js'
import { encodeSse } from '../support/fakes.js'

function responseFromChunks(chunks: string[], fail?: Error): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      if (fail) controller.error(fail)
      else controller.close()
    },
  })
  return new Response(body)
}

describe('SSE stream contract', () => {
  it('preserves event ids and fragmented JSON across arbitrary chunks', async () => {
    const text = encodeSse([
      { eventId: '1', type: 'message_start', message: { usage: { input_tokens: 2 } } },
      { eventId: '2', type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hel' } },
      { eventId: '3', type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { eventId: '4', type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { eventId: '5', type: 'message_stop' },
    ])
    const result = await consumeSse(responseFromChunks([...text].map(char => char)), new StreamAccumulator())
    expect(result).toMatchObject({ lastEventId: '5', eventCount: 5, streamComplete: true, stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } })
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('accumulates fragmented tool JSON without losing block order', async () => {
    const result = await consumeSse(responseFromChunks([encodeSse([
      { type: 'message_start' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Write', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])]), new StreamAccumulator())
    expect(result.content).toEqual([{ type: 'text', text: 'before' }, { type: 'tool_use', id: 'tool-1', name: 'Write', input: { path: 'x' } }])
  })

  it('supports a final SSE line without a trailing newline and ignores malformed data in lenient mode', async () => {
    const valid = encodeSse([{ type: 'message_start' }, { type: 'message_stop' }], false)
    const response = responseFromChunks(`data: {bad}\n${valid}`.split(/(?<=\n)/))
    const result = await consumeSse(response, new StreamAccumulator())
    expect(result.streamComplete).toBe(true)
    expect(result.eventCount).toBe(2)
  })

  it('fails closed for malformed SSE in strict mode and releases the reader', async () => {
    await expect(consumeSse(responseFromChunks(['data: {bad}\n']), new StreamAccumulator(), undefined, undefined, { strict: true })).rejects.toMatchObject({ code: 'malformed_sse' })
  })

  it('rejects strict streams without message_stop and keeps partial data on reader failure', async () => {
    await expect(consumeSse(responseFromChunks(['data: {"type":"message_start"}\n']), new StreamAccumulator(), undefined, undefined, { strict: true })).rejects.toBeInstanceOf(StreamIncompleteError)
    let pullCount = 0
    const failingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount++ === 0) controller.enqueue(new TextEncoder().encode('data: {"type":"message_start"}\n'))
        else controller.error(new Error('socket reset'))
      },
    })
    const partial = await consumeSse(new Response(failingBody), new StreamAccumulator()).catch(value => value)
    expect(partial).toBeInstanceOf(StreamIncompleteError)
    expect((partial as StreamIncompleteError).partial?.partial).toBe(true)
  })

  it('distinguishes abort with content from abort before content', async () => {
    const controller = new AbortController()
    const result = await consumeSse(
      responseFromChunks(['data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"partial"}}\n']),
      new StreamAccumulator(),
      () => controller.abort(),
      controller.signal,
    )
    expect(result).toMatchObject({ partial: true, interrupted: true, streamComplete: false })
    expect(result.content).toEqual([{ type: 'text', text: 'partial' }])

    const noContentController = new AbortController(); noContentController.abort()
    await expect(consumeSse(responseFromChunks([]), new StreamAccumulator(), undefined, noContentController.signal)).rejects.toBeInstanceOf(RequestAbortedError)
  })

  it('parses CRLF, explicit ids, and [DONE] through the line helper', () => {
    const events: unknown[] = []
    parseSseLines('id: 10\r\ndata: {"type":"message_stop"}\r\ndata: [DONE]\r\n', event => events.push(event))
    expect(events).toEqual([{ type: 'message_stop', eventId: '10' }])
  })

  it('rejects API error events as protocol failures', async () => {
    await expect(consumeSse(responseFromChunks(['data: {"type":"error"}\n']), new StreamAccumulator())).rejects.toBeInstanceOf(StreamProtocolError)
  })
})
