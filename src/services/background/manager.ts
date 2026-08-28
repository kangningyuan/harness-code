import type { ToolResult } from '../../Tool.js'
import { newRequestId } from '../protocol/ids.js'
import { formatToolResultReference } from '../tool-results/store.js'
import { BackgroundTaskStore } from './store.js'
import type { BackgroundEvent, BackgroundRunResult, BackgroundStartOptions, BackgroundTask } from './types.js'

function clone(task: BackgroundTask): BackgroundTask { return { ...task } }
function resultText(result: ToolResult): string { return result.rawResult ?? result.result ?? (typeof result.data === 'string' ? result.data : JSON.stringify(result.data) ?? String(result.data)) }
function summary(text: string): string { return text.replace(/\s+/g, ' ').trim().slice(0, 300) }
const terminal = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'orphaned'])

export class BackgroundTaskManager {
  private readonly tasks = new Map<string, BackgroundTask>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly notifications: Array<{ sessionId: string; text: string }> = []
  private readonly listeners = new Set<(event: BackgroundEvent) => void>()
  private shuttingDown = false
  constructor(private readonly store?: BackgroundTaskStore, loadExisting = true, private readonly scopeSessionId?: string) {
    for (const loaded of loadExisting ? store?.list() ?? [] : []) {
      const task = clone(loaded)
      if (task.status === 'running' || task.status === 'queued') { task.status = 'orphaned'; task.error = 'Process was not recoverable after restart'; task.finishedAt = Date.now(); store?.save(task); this.notifications.push({ sessionId: task.sessionId, text: `[Background task ${task.id} orphaned after restart]` }) }
      this.tasks.set(task.id, task)
    }
  }
  shouldRun(toolName: string, input: Record<string, unknown>): boolean { return (toolName === 'BashTool' || toolName === 'Bash') && input.run_in_background === true }
  subscribe(listener: (event: BackgroundEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  list(sessionId?: string): BackgroundTask[] { return [...this.tasks.values()].filter(task => !sessionId || task.sessionId === sessionId).map(clone) }
  get(id: string): BackgroundTask | null { const task = this.tasks.get(id); return task ? clone(task) : null }

  start(options: BackgroundStartOptions): BackgroundTask {
    if (this.shuttingDown) throw new Error('Background task manager is shutting down')
    const id = newRequestId('bg')
    const now = Date.now()
    const task: BackgroundTask = { id, sessionId: options.correlation.sessionId, turnId: options.correlation.turnId, toolUseId: options.correlation.toolUseId ?? 'unknown', toolName: options.toolName, command: options.command, cwd: options.cwd, status: 'queued', createdAt: now, owner: options.correlation.agentId }
    this.tasks.set(id, task)
    const controller = new AbortController(); this.controllers.set(id, controller)
    task.status = 'running'; task.startedAt = Date.now(); this.persist(task); this.emit({ type: 'started', task, notification: `[Background task ${id} started]${options.command ? ` ${options.command.slice(0, 120)}` : ''}` })
    void this.execute(id, options, controller)
    return clone(task)
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task || terminal.has(task.status)) return false
    task.status = 'cancelled'; task.finishedAt = Date.now(); task.error = 'Cancelled by user'; this.persist(task); this.controllers.get(id)?.abort(); this.emit({ type: 'cancelled', task, notification: `[Background task ${id} cancelled]` }); return true
  }
  cancelAll(sessionId = this.scopeSessionId): number { let count = 0; for (const task of this.tasks.values()) if ((!sessionId || task.sessionId === sessionId) && this.cancel(task.id)) count++; return count }
  drainNotifications(sessionId?: string): string[] { const selected: string[] = []; const remaining: Array<{ sessionId: string; text: string }> = []; for (const notification of this.notifications) { if (!sessionId || notification.sessionId === sessionId) selected.push(notification.text); else remaining.push(notification) } this.notifications.length = 0; this.notifications.push(...remaining); return selected }
  async shutdown(graceMs = 2_000): Promise<void> { this.shuttingDown = true; this.cancelAll(); const deadline = Date.now() + graceMs; while ([...this.tasks.values()].some(task => task.status === 'running' || task.status === 'queued') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)) }

  private async execute(id: string, options: BackgroundStartOptions, controller: AbortController): Promise<void> {
    const task = this.tasks.get(id); if (!task) return
    try {
      const outcome: BackgroundRunResult = await options.run(controller.signal)
      if (task.status === 'cancelled' || controller.signal.aborted) return
      const result = outcome.result
      const text = resultText(result)
      const reference = result.resultRef ?? outcome.context?.resultStore?.persist(text, { toolUseId: task.toolUseId, toolName: task.toolName }) ?? undefined
      if (reference) result.resultRef = reference
      task.status = result.isError ? 'failed' : 'completed'; task.error = result.isError ? summary(text) : undefined; task.summary = summary(text); task.resultRef = reference; task.finishedAt = Date.now(); this.persist(task)
      try { options.onResult?.(result, clone(task)) } catch { /* result observers must not change task state */ }
      const notification = reference ? `[Background task ${id} ${task.status}] ${formatToolResultReference(reference).slice(0, 800)}` : `[Background task ${id} ${task.status}] ${task.summary || '(no output)'}`
      this.emit({ type: task.status, task, notification })
    } catch (error) {
      if (task.status === 'cancelled' || controller.signal.aborted) return
      task.status = error instanceof Error && /timeout/i.test(error.message) ? 'timed_out' : 'failed'; task.error = summary(error instanceof Error ? error.message : String(error)); task.finishedAt = Date.now(); this.persist(task); this.emit({ type: task.status, task, notification: `[Background task ${id} ${task.status}] ${task.error}` })
    } finally { this.controllers.delete(id) }
  }

  private persist(task: BackgroundTask): void { try { this.store?.save(task) } catch { /* task execution remains authoritative; diagnostics are emitted through status */ } }
  private emit(event: BackgroundEvent): void {
    const task = this.tasks.get(event.task.id); if (!task) return
    const snapshot = clone(task); const next = { ...event, task: snapshot }
    if (event.type !== 'started') this.notifications.push({ sessionId: event.task.sessionId, text: event.notification })
    for (const listener of this.listeners) { try { listener(next) } catch { /* observers cannot break manager */ } }
  }
}
