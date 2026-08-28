import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectStateDir } from '../session/paths.js'
import { withFileLock } from '../tasks/lock.js'
import type { CorrelationContext } from '../protocol/types.js'

export interface HarnessEvent { type: string; timestamp: number; correlation?: CorrelationContext; data?: Record<string, unknown> }
function safeId(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32) }
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return '[truncated]'
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => /key|token|secret|password|authorization|credential|prompt|content/i.test(key) ? [key, '[redacted]'] : [key, sanitize(child, depth + 1)]))
}

export class EventLogger {
  readonly dir: string
  constructor(cwd: string) { this.dir = join(projectStateDir(cwd), 'events'); mkdirSync(this.dir, { recursive: true }) }
  record(type: string, correlation?: CorrelationContext, data?: Record<string, unknown>): void {
    const sessionId = correlation?.sessionId ?? 'global'; const path = join(this.dir, `${safeId(sessionId)}.jsonl`); const event: HarnessEvent = { type, timestamp: Date.now(), correlation: correlation ? { ...correlation } : undefined, data: data ? sanitize(data) as Record<string, unknown> : undefined }
    try { withFileLock(`${path}.lock`, () => appendFileSync(path, JSON.stringify(event) + '\n', 'utf8')) } catch { /* observability must not block the agent */ }
  }
}
