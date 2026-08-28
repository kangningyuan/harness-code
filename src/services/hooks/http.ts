import type { HookCommand, HookEvent, HookInput, HookOutcome } from './types.js'
import type { HookRunOptions } from './runner.js'

function safeInput(input: HookInput): HookInput {
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => /key|token|secret|password|authorization|credential/i.test(key) ? [key, '[redacted]'] : [key, redact(child)]))
  }
  return { ...input, input: input.input ? redact(input.input) as Record<string, unknown> : undefined, toolResult: input.toolResult === undefined ? undefined : redact(input.toolResult) }
}
function failed(message: string, options: HookRunOptions): HookOutcome { return options.failClosed ? { decision: 'block', reason: message } : {} }
function valid(value: unknown): value is HookOutcome { return Boolean(value && typeof value === 'object' && ((value as { decision?: unknown }).decision === undefined || (value as { decision?: unknown }).decision === 'approve' || (value as { decision?: unknown }).decision === 'block')) }

export async function runHttpHook(command: HookCommand, event: HookEvent, input: HookInput, options: HookRunOptions = {}): Promise<HookOutcome> {
  if (!command.url) return failed('HTTP hook URL is missing', options)
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), command.timeout ?? 10_000)
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true })
  try {
    if (options.signal?.aborted) return failed('HTTP hook aborted', options)
    const response = await fetch(command.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(command.headers ?? {}) }, body: JSON.stringify({ event, ...safeInput(input) }), signal: controller.signal })
    if (!response.ok) return failed(`HTTP hook returned ${response.status}`, options)
    let value: unknown
    try { value = await response.json() } catch { return failed('HTTP hook returned invalid JSON', options) }
    return valid(value) ? value as HookOutcome : failed('HTTP hook returned invalid decision', options)
  } catch (error) { return failed(error instanceof Error ? error.message : String(error), options) }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
}
