import { buildTool, type BuiltTool } from '../../src/Tool.js'
import { query, getFinalText } from '../../src/query.js'
import type { ApiClient } from '../../src/services/api/client.js'
import type { Message } from '../../src/services/api/types.js'

function context() {
  const map = new Map<string, { mtimeMs: number }>()
  return { abortController: new AbortController(), cwd: process.cwd(), readFileState: { get: (p: string) => map.get(p), set: (p: string, v: { mtimeMs: number }) => map.set(p, v), recordRead: (p: string, m: number) => map.set(p, { mtimeMs: m }), clear: () => map.clear() } }
}
function tool(name: string, safe = false): BuiltTool {
  return buildTool({ name, inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, isConcurrencySafe: () => safe, call: async () => ({ data: 'ok', result: 'ok' }), description: () => name, prompt: () => name, mapToolResultToToolResultBlockParam: (r, id) => [{ type: 'tool_result', tool_use_id: id, content: r.result ?? '' }], renderToolUseMessage: () => name })
}

describe('query loop', () => {
  it('completes a text response and extracts final text', async () => {
    const client = { callModel: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }) } as unknown as ApiClient
    const result = await query([{ role: 'user', content: 'hi' }], { client, tools: [], systemPrompt: [], model: 'test', maxOutputTokens: 100, maxTurns: 3, context: context(), canUseTool: async () => ({ behavior: 'allow' }) })
    expect(result.reason).toBe('completed'); expect(getFinalText(result.messages)).toBe('done')
  })
  it('runs a tool and then completes', async () => {
    const client = { callModel: vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }], stopReason: 'tool_use' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'finished' }], stopReason: 'end_turn' }) } as unknown as ApiClient
    const result = await query([{ role: 'user', content: 'read' }], { client, tools: [tool('Read')], systemPrompt: [], model: 'test', maxOutputTokens: 100, maxTurns: 3, context: context(), canUseTool: async () => ({ behavior: 'allow' }) })
    expect(result.reason).toBe('completed'); expect(client.callModel).toHaveBeenCalledTimes(2); expect(result.messages.some(m => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')).toBe(true)
  })
})
