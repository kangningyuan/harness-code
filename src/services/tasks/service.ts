import { newTaskId } from '../protocol/ids.js'
import { findUnblocked, dependenciesComplete, validateTaskDependencies } from './graph.js'
import { TaskStore } from './store.js'
import type { TaskMutationResult, TaskRecord } from './types.js'

const DEFAULT_LEASE_MS = 15 * 60_000
function copy(task: TaskRecord): TaskRecord { return { ...task, blockedBy: [...task.blockedBy] } }

export class TaskService {
  constructor(readonly store: TaskStore, private readonly leaseMs = DEFAULT_LEASE_MS) {}
  create(subject: string, description = '', blockedBy: string[] = [], sessionId?: string): TaskMutationResult {
    if (!subject.trim()) return { ok: false, error: 'Task subject is required' }
    return this.store.mutate(() => {
      const tasks = this.store.list(); const error = validateTaskDependencies(tasks, '__new__', blockedBy)
      if (error) return { ok: false, error }
      const task = this.store.create(subject.trim(), description.trim(), blockedBy, sessionId)
      return { ok: true, task: copy(task) }
    })
  }
  list(sessionId?: string): TaskRecord[] { return this.store.list().filter(task => !sessionId || !task.sessionId || task.sessionId === sessionId).map(copy) }
  get(id: string): TaskRecord | null { const task = this.store.get(id); return task ? copy(task) : null }
  canStart(id: string): boolean { const task = this.store.get(id); if (!task) return false; const byId = new Map(this.store.list().map(value => [value.id, value])); return task.status === 'pending' && dependenciesComplete(task, byId) }
  claim(id: string, owner: string, sessionId?: string): TaskMutationResult { return this.store.mutate(() => { const task = this.store.get(id); if (!task) return { ok: false, error: 'Task not found' }; if (sessionId && task.sessionId && task.sessionId !== sessionId) return { ok: false, error: 'Task belongs to another session' }; const all = this.store.list(); const byId = new Map(all.map(value => [value.id, value])); if (task.status !== 'pending') return { ok: false, error: `Task is ${task.status}` }; if (task.owner) return { ok: false, error: `Task is owned by ${task.owner}` }; if (!dependenciesComplete(task, byId)) return { ok: false, error: 'Task is blocked by incomplete dependencies' }; const now = Date.now(); task.owner = owner; task.status = 'in_progress'; task.attempts++; task.leaseUntil = now + this.leaseMs; task.updatedAt = now; task.version++; this.store.save(task); return { ok: true, task: copy(task) } }) }
  complete(id: string, owner: string): TaskMutationResult { return this.finish(id, owner, 'completed') }
  fail(id: string, owner: string, error: string): TaskMutationResult { return this.finish(id, owner, 'failed', error) }
  cancel(id: string, owner: string): TaskMutationResult { return this.finish(id, owner, 'cancelled') }
  bindWorktree(id: string, worktreeId: string, owner: string): TaskMutationResult { return this.store.mutate(() => { const task = this.store.get(id); if (!task) return { ok: false, error: 'Task not found' }; if (task.owner && task.owner !== owner) return { ok: false, error: 'Only the task owner can bind a worktree' }; task.worktreeId = worktreeId; task.updatedAt = Date.now(); task.version++; this.store.save(task); return { ok: true, task: copy(task) } }) }
  reconcile(now = Date.now()): TaskRecord[] { return this.store.mutate(() => { const changed: TaskRecord[] = []; for (const task of this.store.list()) if (task.status === 'in_progress' && task.leaseUntil !== undefined && task.leaseUntil < now) { task.status = 'pending'; delete task.owner; delete task.leaseUntil; task.error = 'Previous owner lease expired'; task.updatedAt = now; task.version++; this.store.save(task); changed.push(copy(task)) } return changed }) }
  unblocked(sessionId?: string): TaskRecord[] { return findUnblocked(this.list(sessionId)) }
  private finish(id: string, owner: string, status: TaskRecord['status'], error?: string): TaskMutationResult { return this.store.mutate(() => { const task = this.store.get(id); if (!task) return { ok: false, error: 'Task not found' }; if (task.owner !== owner) return { ok: false, error: 'Only the task owner can change this task' }; if (task.status !== 'in_progress') return { ok: false, error: `Task is ${task.status}` }; task.status = status; task.error = error; delete task.leaseUntil; task.updatedAt = Date.now(); task.version++; this.store.save(task); return { ok: true, task: copy(task), unblocked: this.unblocked(task.sessionId) } }) }
}

export function createTaskService(cwd: string, leaseMs?: number): TaskService { return new TaskService(new TaskStore(cwd), leaseMs) }
