import { ApiError, RequestAbortedError } from '../../src/services/api/client.js'
import { createRecoveryState, retryModelCall } from '../../src/query/recovery.js'
import { buildTool } from '../../src/Tool.js'
import { query } from '../../src/query.js'
import type { ApiClient } from '../../src/services/api/client.js'

function context() {
  return { abortController: new AbortController(), cwd: process.cwd(), readFileState: { get: () => undefined, set: () => undefined, recordRead: () => undefined, clear: () => undefined } }
}

describe('query recovery', () => {
  it('retries transient errors with bounded attempts', async () => {
    const calls: string[] = []
    let count = 0
    const state = createRecoveryState('primary')
    const result = await retryModelCall(async model => { calls.push(model); if (count++ === 0) throw new ApiError('busy', 429, 'rate_limit_error'); return 'ok' }, { state, policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
    expect(result).toEqual({ value: 'ok', model: 'primary' })
    expect(calls).toEqual(['primary', 'primary'])
  })

  it('switches once to a fallback after consecutive overloads', async () => {
    const calls: string[] = []
    let count = 0
    const state = createRecoveryState('primary')
    const result = await retryModelCall(async model => { calls.push(model); if (count++ < 2) throw new ApiError('overloaded', 529, 'overloaded'); return 'ok' }, { state, fallbackModel: 'fallback', policy: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
    expect(result).toEqual({ value: 'ok', model: 'fallback' })
    expect(calls).toEqual(['primary', 'primary', 'fallback'])
  })

  it('aborts while waiting for retry backoff', async () => {
    const controller = new AbortController()
    const state = createRecoveryState('primary')
    await expect(retryModelCall(async () => { controller.abort(); throw new ApiError('busy', 503) }, { state, signal: controller.signal, policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 } })).rejects.toBeInstanceOf(RequestAbortedError)
  })

  it('escalates max_tokens before continuation', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens' })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' })
    const result = await query([{ role: 'user', content: 'hello' }], {
      client: { callModel } as unknown as ApiClient,
      tools: [],
      systemPrompt: [],
      model: 'primary',
      maxOutputTokens: 10,
      maxTurns: 3,
      context: context(),
      canUseTool: async () => ({ behavior: 'allow' as const }),
      retryPolicy: { maxAttempts: 1 },
    })
    expect(result.reason).toBe('completed')
    expect(callModel.mock.calls.map(call => call[0].max_tokens)).toEqual([10, 64_000])
  })

  it('does not execute a tool more than once when the model request retries', async () => {
    let request = 0
    const call = vi.fn()
    const tool = buildTool({ name: 'Effect', inputJSONSchema: { type: 'object' }, maxResultSizeChars: 100, call, isConcurrencySafe: () => false, description: () => '', prompt: () => '', renderToolUseMessage: () => '' })
    const client = { callModel: vi.fn(async () => { request++; if (request === 1) throw new ApiError('busy', 503); if (request === 2) return { content: [{ type: 'tool_use', id: 'one', name: 'Effect', input: {} }], stopReason: 'tool_use' }; return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' } }) }
    const result = await query([{ role: 'user', content: 'do it' }], { client: client as unknown as ApiClient, tools: [tool], systemPrompt: [], model: 'primary', maxOutputTokens: 100, maxTurns: 3, context: context(), canUseTool: async () => ({ behavior: 'allow' as const }), retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
    expect(result.reason).toBe('completed')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
