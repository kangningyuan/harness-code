import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../../utils/file/atomicWrite.js'
import { projectStateDir } from '../session/paths.js'
import { newTaskId } from '../protocol/ids.js'
import { withFileLock } from './lock.js'
import type { TaskRecord } from './types.js'

function isTask(value: unknown): value is TaskRecord {
  if (!value || typeof value !== 'object') return false
  const task = value as Record<string, unknown>
  return typeof task.id === 'string' && typeof task.subject === 'string' && typeof task.description === 'string' && typeof task.status === 'string' && Array.isArray(task.blockedBy) && typeof task.createdAt === 'number' && typeof task.updatedAt === 'number' && typeof task.version === 'number' && typeof task.attempts === 'number'
}

export class TaskStore {
  readonly dir: string
  readonly lockPath: string
  constructor(cwd: string) { this.dir = join(projectStateDir(cwd), 'tasks'); this.lockPath = join(projectStateDir(cwd), 'tasks.lock'); mkdirSync(this.dir, { recursive: true }) }
  list(): TaskRecord[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).filter(name => name.endsWith('.json')).map(name => { try { const value: unknown = JSON.parse(readFileSync(join(this.dir, name), 'utf8')); return isTask(value) ? { ...value, blockedBy: [...value.blockedBy] } : null } catch { return null } }).filter((task): task is TaskRecord => task !== null)
  }
  get(id: string): TaskRecord | null { const task = this.list().find(value => value.id === id); return task ? { ...task, blockedBy: [...task.blockedBy] } : null }
  mutate<T>(fn: () => T): T { return withFileLock(this.lockPath, fn) }
  save(task: TaskRecord): void { atomicWriteFile(join(this.dir, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n') }
  create(subject: string, description: string, blockedBy: string[], sessionId?: string): TaskRecord { const now = Date.now(); const task: TaskRecord = { id: newTaskId(), subject, description, status: 'pending', blockedBy: [...blockedBy], sessionId, createdAt: now, updatedAt: now, version: 1, attempts: 0 }; this.save(task); return task }
}
