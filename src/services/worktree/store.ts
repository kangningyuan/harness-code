import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../../utils/file/atomicWrite.js'
import { projectStateDir } from '../session/paths.js'
import { withFileLock } from '../tasks/lock.js'
import { newWorktreeId } from '../protocol/ids.js'
import type { WorktreeRecord } from './types.js'

function isRecord(value: unknown): value is WorktreeRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string' && typeof item.branch === 'string' && typeof item.repoRoot === 'string' && typeof item.status === 'string' && typeof item.createdAt === 'number' && typeof item.updatedAt === 'number'
}

export class WorktreeStore {
  readonly dir: string
  readonly lockPath: string
  constructor(cwd: string) { this.dir = join(projectStateDir(cwd), 'worktrees'); this.lockPath = join(projectStateDir(cwd), 'worktrees.lock'); mkdirSync(this.dir, { recursive: true }) }
  list(): WorktreeRecord[] { if (!existsSync(this.dir)) return []; return readdirSync(this.dir).filter(name => name.endsWith('.json')).map(name => { try { const value: unknown = JSON.parse(readFileSync(join(this.dir, name), 'utf8')); return isRecord(value) ? { ...value } : null } catch { return null } }).filter((record): record is WorktreeRecord => record !== null) }
  get(idOrName: string): WorktreeRecord | null { const records = this.list().filter(item => item.id === idOrName || item.name === idOrName).sort((a, b) => b.updatedAt - a.updatedAt); const active = records.find(item => item.status !== 'removed') ?? records[0]; return active ? { ...active } : null }
  mutate<T>(fn: () => T): T { return withFileLock(this.lockPath, fn) }
  save(record: WorktreeRecord): void { atomicWriteFile(join(this.dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n') }
  newId(): string { return newWorktreeId() }
}
