import { buildTool, type BuiltTool, type ToolUseContext } from '../../src/Tool.js'
import { query } from '../../src/query.js'
import { ApiError } from '../../src/services/api/client.js'
import type { ApiClient } from '../../src/services/api/client.js'
import type { ModelResult } from '../../src/services/api/types.js'

function context(): ToolUseContext {
  return {
    abortController: new AbortController(),
    cwd: process.cwd(),
    readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined },
  }
}
function fakeTool(name: string, call: BuiltTool['call'] = async () => ({ data: 'ok', result: 'ok' }), safe = false): BuiltTool {
  return buildTool({ name, inputJSONSchema: { type: 'object' }, maxResultSizeChars: 50, isConcurrencySafe: () => safe, call, description: () => name, prompt: () => name, renderToolUseMessage: () => name })
}
function deps(client: ApiClient, extra: Partial<Parameters<typeof query>[1]> = {}): Parameters<typeof query>[1] {
  return { client, tools: [], systemPrompt: [], model: 'model', maxOutputTokens: 100, maxTurns: 10, context: context(), canUseTool: async () => ({ behavior: 'allow' as const }), retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }, ...extra }
}

const completed = (text = 'done'): ModelResult => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' })

describe('query contract and recovery boundaries', () => {
  it('returns max_turns without making a model request', async () => {
    const callModel = vi.fn()
    const result = await query([{ role: 'user', content: 'hello' }], deps({ callModel } as unknown as ApiClient, { maxTurns: 0 }))
    expect(result.reason).toBe('max_turns')
    expect(callModel).not.toHaveBeenCalled()
  })

  it('returns aborted_streaming before a request when already interrupted', async () => {
    const ctx = context(); ctx.abortController.abort()
    const callModel = vi.fn()
    const result = await query([], deps({ callModel } as unknown as ApiClient, { context: ctx }))
    expect(result.reason).toBe('aborted_streaming')
    expect(callModel).not.toHaveBeenCalled()
  })

  it('turns beforeModel and prepareContext failures into explicit query errors', async () => {
    const before = await query([], deps({ callModel: vi.fn() } as unknown as ApiClient, { beforeModel: async () => { throw new Error('gate failed') } }))
    expect(before).toMatchObject({ reason: 'error', error: 'gate failed' })
    const prepared = await query([], deps({ callModel: vi.fn() } as unknown as ApiClient, { prepareContext: () => { throw new Error('budget failed') } }))
    expect(prepared).toMatchObject({ reason: 'error', error: 'budget failed' })
  })

  it('injects queued messages before the request and evaluates a dynamic system prompt', async () => {
    const callModel = vi.fn().mockResolvedValue(completed())
    const injected = { role: 'user' as const, content: 'queued' }
    let promptCalls = 0
    await query([{ role: 'user', content: 'initial' }], deps({ callModel } as unknown as ApiClient, { systemPrompt: () => { promptCalls++; return 'dynamic' }, injectMessages: () => [injected] }))
    expect(promptCalls).toBeGreaterThan(0)
    expect(callModel.mock.calls[0]?.[0].messages).toEqual([{ role: 'user', content: 'initial' }, injected])
    expect(callModel.mock.calls[0]?.[0].system).toBe('dynamic')
  })

  it('does not append an incomplete model response to the successful transcript', async () => {
    const partial = { content: [{ type: 'text', text: 'half' }], stopReason: null, partial: true, streamComplete: false }
    const result = await query([{ role: 'user', content: 'hello' }], deps({ callModel: vi.fn().mockResolvedValue(partial) } as unknown as ApiClient))
    expect(result.reason).toBe('error')
    expect(result.errorCode).toBe('incomplete_stream')
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(result.partial?.content).toEqual(partial.content)
  })

  it('compacts once for prompt-too-long and then reports if it remains too large', async () => {
    const callModel = vi.fn().mockRejectedValue(new ApiError('context length exceeded', 413, 'prompt_too_long'))
    const compact = vi.fn().mockResolvedValue(null)
    const result = await query([{ role: 'user', content: 'large' }], deps({ callModel } as unknown as ApiClient, { compact, reactiveCompact: compact }))
    expect(result.reason).toBe('prompt_too_long')
    expect(compact).toHaveBeenCalledTimes(1)
    expect(callModel).toHaveBeenCalledTimes(1)
  })

  it('escalates output once and performs at most three continuations', async () => {
    const callModel = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'part' }], stopReason: 'max_tokens' })
    const recoveries: string[] = []
    const result = await query([{ role: 'user', content: 'write' }], deps({ callModel } as unknown as ApiClient, { maxTurns: 10, onRecovery: info => recoveries.push(info.kind) }))
    expect(result.reason).toBe('completed')
    expect(callModel).toHaveBeenCalledTimes(5)
    expect(callModel.mock.calls[0]?.[0].max_tokens).toBe(100)
    expect(callModel.mock.calls[1]?.[0].max_tokens).toBe(64_000)
    expect(recoveries.filter(kind => kind === 'continuation')).toHaveLength(3)
  })

  it('preserves exactly one result per tool-use and rejects duplicate ids', async () => {
    const call = vi.fn().mockResolvedValue({ data: 'called', result: 'called' })
    const tool = fakeTool('Effect', call)
    const callModel = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'same', name: 'Effect', input: {} }, { type: 'tool_use', id: 'same', name: 'Effect', input: {} }], stopReason: 'tool_use' })
      .mockResolvedValueOnce(completed())
    const result = await query([{ role: 'user', content: 'do' }], deps({ callModel } as unknown as ApiClient, { tools: [tool] }))
    const toolResults = result.messages.find(message => message.role === 'user' && Array.isArray(message.content))
    expect(call).toHaveBeenCalledTimes(1)
    expect(toolResults?.content).toHaveLength(2)
    expect((toolResults?.content as Array<{ is_error?: boolean }>).filter(block => block.is_error)).toHaveLength(1)
  })
})
