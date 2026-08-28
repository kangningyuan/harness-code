import { ApiError, RequestAbortedError, RequestTimeoutError } from '../services/api/client.js'
import type { ModelResult } from '../services/api/types.js'

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio: number
  retryStatuses?: readonly number[]
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 32_000,
  jitterRatio: 0.25,
}

export interface RecoveryState {
  currentModel: string
  networkAttempts: number
  consecutive529: number
  fallbackUsed: boolean
  hasEscalated: boolean
  outputRecoveries: number
  reactiveCompactUsed: boolean
  lastError?: string
}

export function createRecoveryState(model: string): RecoveryState {
  return {
    currentModel: model,
    networkAttempts: 0,
    consecutive529: 0,
    fallbackUsed: false,
    hasEscalated: false,
    outputRecoveries: 0,
    reactiveCompactUsed: false,
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof RequestAbortedError || (error instanceof Error && error.name === 'AbortError')
}

function hasPartialResult(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'partial' in error && (error as { partial?: ModelResult }).partial)
}

export function isRetryableModelError(error: unknown, policy: RetryPolicy = DEFAULT_RETRY_POLICY): boolean {
  if (isAbortLike(error) || hasPartialResult(error)) return false
  if (error instanceof ApiError) {
    if (error.isPromptTooLong || error.isMaxOutputTokens) return false
    if (policy.retryStatuses?.length && !policy.retryStatuses.includes(error.status)) return false
    return error.isRetryable
  }
  if (error instanceof RequestTimeoutError) return true
  if (!(error instanceof Error)) return false
  if (error.name === 'TypeError') return true
  return /fetch failed|network|socket|econnreset|econnrefused|enotfound|eai_again/i.test(error.message)
}

function delayFor(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** attempt))
  const requested = retryAfterMs === undefined ? exponential : Math.max(exponential, retryAfterMs)
  const jitter = requested * Math.max(0, policy.jitterRatio) * Math.random()
  return Math.min(policy.maxDelayMs, requested + jitter)
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new RequestAbortedError()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => { settled = true; signal?.removeEventListener('abort', onAbort); resolve() }, Math.max(0, ms))
    const onAbort = () => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new RequestAbortedError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

export interface RetryCallOptions {
  state: RecoveryState
  policy?: Partial<RetryPolicy>
  fallbackModel?: string
  signal?: AbortSignal
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; model: string }) => void
}

export async function retryModelCall<T>(call: (model: string) => Promise<T>, options: RetryCallOptions): Promise<{ value: T; model: string }> {
  const supplied = options.policy ?? {}
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...(supplied.maxAttempts === undefined ? {} : { maxAttempts: supplied.maxAttempts }),
    ...(supplied.baseDelayMs === undefined ? {} : { baseDelayMs: supplied.baseDelayMs }),
    ...(supplied.maxDelayMs === undefined ? {} : { maxDelayMs: supplied.maxDelayMs }),
    ...(supplied.jitterRatio === undefined ? {} : { jitterRatio: supplied.jitterRatio }),
    ...(supplied.retryStatuses === undefined ? {} : { retryStatuses: supplied.retryStatuses }),
  }
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts))
  let attempt = 0
  while (true) {
    if (options.signal?.aborted) throw new RequestAbortedError()
    try {
      const value = await call(options.state.currentModel)
      options.state.networkAttempts = 0
      options.state.consecutive529 = 0
      return { value, model: options.state.currentModel }
    } catch (error) {
      options.state.lastError = error instanceof Error ? error.message : String(error)
      if (!isRetryableModelError(error, policy) || attempt + 1 >= maxAttempts) throw error
      if (error instanceof ApiError && error.isOverloaded) options.state.consecutive529++
      if (options.state.consecutive529 >= 2 && options.fallbackModel && !options.state.fallbackUsed) {
        options.state.currentModel = options.fallbackModel
        options.state.fallbackUsed = true
        options.state.consecutive529 = 0
      }
      const retryAfterMs = error instanceof ApiError ? error.retryAfterMs : undefined
      const delayMs = delayFor(attempt, policy, retryAfterMs)
      attempt++
      options.state.networkAttempts = attempt
      options.onRetry?.({ attempt, delayMs, error, model: options.state.currentModel })
      await abortableDelay(delayMs, options.signal)
    }
  }
}
