import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../../utils/file/atomicWrite.js'
import { projectStateDir } from '../session/paths.js'
import type { BackgroundTask } from './types.js'

function valid(value: unknown): value is BackgroundTask { if (!value || typeof value !== 'object') return false; const task = value as Record<string, unknown>; return typeof task.id === 'string' && typeof task.sessionId === 'string' && typeof task.turnId === 'string' && typeof task.toolUseId === 'string' && typeof task.toolName === 'string' && typeof task.cwd === 'string' && typeof task.status === 'string' && typeof task.createdAt === 'number' }
function copy(task: BackgroundTask): BackgroundTask { return { ...task } }

export class BackgroundTaskStore {
  readonly dir: string
  constructor(cwd: string) { this.dir = join(projectStateDir(cwd), 'background'); mkdirSync(this.dir, { recursive: true }) }
  save(task: BackgroundTask): void { atomicWriteFile(join(this.dir, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n') }
  get(id: string): BackgroundTask | null { try { const value: unknown = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')); return valid(value) ? copy(value) : null } catch { return null } }
  list(sessionId?: string): BackgroundTask[] { if (!existsSync(this.dir)) return []; return readdirSync(this.dir).filter(name => name.endsWith('.json')).map(name => this.get(name.slice(0, -5))).filter((task): task is BackgroundTask => Boolean(task && (!sessionId || task.sessionId === sessionId))) }
}
