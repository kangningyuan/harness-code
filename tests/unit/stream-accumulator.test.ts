import { StreamAccumulator, consumeSse, parseSseLines } from '../../src/services/api/stream.js'

describe('StreamAccumulator', () => {
  it('accumulates text, tool JSON, stop reason, and usage', () => {
    const acc = new StreamAccumulator()
    acc.add({ type: 'message_start', message: { usage: { input_tokens: 4 } } })
    acc.add({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    acc.add({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })
    acc.add({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'Read', input: {} } })
    acc.add({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"x"}' } })
    acc.add({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
    expect(acc.finalize()).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 4, outputTokens: 3 }, content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'call_1', input: { file_path: 'x' } }] })
  })
  it('parses data events and ignores done', () => {
    const events: unknown[] = []
    parseSseLines('event: message_start\ndata: {"type":"message_start"}\n\ndata: [DONE]\n', e => events.push(e))
    expect(events).toHaveLength(1)
  })
  it('processes a final SSE event without a trailing newline', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hello"}}\n'))
        controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}'))
        controller.close()
      },
    })
    const result = await consumeSse(new Response(body), new StreamAccumulator())
    expect(result.content).toEqual([{ type: 'text', text: 'hello world' }])
  })
  it('handles chunk boundaries inside an SSE event', async () => {
    const chunks = ['data: {"type":"content_block_start","index":0,', '"content_block":{"type":"text","text":"x"}}\n']
    const body = new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close() },
    })
    const result = await consumeSse(new Response(body), new StreamAccumulator())
    expect(result.content).toEqual([{ type: 'text', text: 'x' }])
  })
})
