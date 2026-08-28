import { ApiError, RequestAbortedError, RequestTimeoutError } from '../../src/services/api/client.js'
import { createRecoveryState, isRetryableModelError, retryModelCall } from '../../src/query/recovery.js'

describe('model recovery matrix', () => {
  it.each([
    [new ApiError('bad request', 400), false],
    [new ApiError('prompt too long', 413, 'prompt_too_long'), false],
    [new ApiError('output too long', 400, 'max_output_tokens'), false],
    [new ApiError('busy', 503), true],
    [new ApiError('rate limited', 429), true],
    [new RequestTimeoutError(), true],
    [new RequestAbortedError(), false],
    [new TypeError('fetch failed'), true],
    [new Error('permission denied'), false],
    ['not an error', false],
  ])('classifies %s as retryable=%s', (error, expected) => {
    expect(isRetryableModelError(error)).toBe(expected)
  })

  it('honors an explicit status allowlist and refuses unlisted transient statuses', async () => {
    const state = createRecoveryState('primary')
    const error = new ApiError('busy', 503)
    const retry = vi.fn().mockRejectedValue(error)
    await expect(retryModelCall(retry, { state, policy: { maxAttempts: 3, retryStatuses: [429], baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })).rejects.toBe(error)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(state.networkAttempts).toBe(0)
  })

  it('resets transient counters after a successful retry', async () => {
    const state = createRecoveryState('primary')
    const retry = vi.fn().mockRejectedValueOnce(new ApiError('busy', 503)).mockResolvedValueOnce('ok')
    const result = await retryModelCall(retry, { state, policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })
    expect(result).toEqual({ value: 'ok', model: 'primary' })
    expect(state.networkAttempts).toBe(0)
    expect(state.consecutive529).toBe(0)
  })

  it('uses Retry-After but caps delay at the policy maximum', async () => {
    const state = createRecoveryState('primary')
    const error = new ApiError('busy', 429, 'rate_limit_error', 60_000)
    const call = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok')
    const retry = vi.fn()
    await retryModelCall(call, { state, policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 20, jitterRatio: 0 }, onRetry: retry })
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 20, model: 'primary' }))
  })

  it('does not retry errors carrying a partial model result', async () => {
    const state = createRecoveryState('primary')
    const error = Object.assign(new Error('socket reset'), { partial: { content: [], stopReason: null } })
    await expect(retryModelCall(vi.fn().mockRejectedValue(error), { state, policy: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })).rejects.toBe(error)
  })

  it('switches to fallback once after two overloads and never loops indefinitely', async () => {
    const calls: string[] = []
    const state = createRecoveryState('primary')
    const result = await retryModelCall(async model => { calls.push(model); throw new ApiError('capacity', 529, 'overloaded') }, { state, fallbackModel: 'fallback', policy: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }).catch(error => error)
    expect(result).toBeInstanceOf(ApiError)
    expect(calls).toEqual(['primary', 'primary', 'fallback', 'fallback'])
    expect(state.fallbackUsed).toBe(true)
  })

  it('aborts before invoking the callback and during backoff', async () => {
    const before = new AbortController(); before.abort()
    const call = vi.fn()
    await expect(retryModelCall(call, { state: createRecoveryState('model'), signal: before.signal })).rejects.toBeInstanceOf(RequestAbortedError)
    expect(call).not.toHaveBeenCalled()

    const during = new AbortController()
    const pending = retryModelCall(async () => { throw new ApiError('busy', 503) }, { state: createRecoveryState('model'), signal: during.signal, policy: { maxAttempts: 3, baseDelayMs: 10_000, maxDelayMs: 10_000, jitterRatio: 0 } })
    during.abort()
    await expect(pending).rejects.toBeInstanceOf(RequestAbortedError)
  })
})
