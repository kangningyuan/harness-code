import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { findCanonicalGitRoot } from '../../memdir/paths.js'
import { newWorktreeId } from '../protocol/ids.js'
import type { TaskService } from '../tasks/service.js'
import { WorktreeStore } from './store.js'
import { ExecGitRunner } from './gitRunner.js'
import type { GitRunner, WorktreeRecord, WorktreeResult } from './types.js'

const NAME = /^[A-Za-z0-9._-]{1,64}$/
const LEASE_MS = 15 * 60_000
function copy(record: WorktreeRecord): WorktreeRecord { return { ...record } }
function validateName(name: string): string | null { if (!name || name === '.' || name === '..' || !NAME.test(name)) return 'Invalid worktree name; use 1-64 letters, digits, dots, underscores, or dashes'; return null }

export class WorktreeService {
  readonly repoRoot: string
  readonly store: WorktreeStore
  constructor(cwd: string, private readonly git: GitRunner = new ExecGitRunner(), private readonly tasks?: TaskService) {
    this.repoRoot = findCanonicalGitRoot(cwd) ?? resolve(cwd)
    this.store = new WorktreeStore(this.repoRoot)
  }
  list(sessionId?: string): WorktreeRecord[] { return this.store.list().filter(record => !sessionId || !record.sessionId || record.sessionId === sessionId).map(copy) }
  get(idOrName: string): WorktreeRecord | null { const record = this.store.get(idOrName); return record ? copy(record) : null }
  create(name: string, options: { owner?: string; sessionId?: string; taskId?: string; baseRef?: string } = {}): WorktreeResult {
    const invalid = validateName(name); if (invalid) return { ok: false, error: invalid }
    return this.store.mutate(() => {
      if (!this.isRepository()) return { ok: false, error: 'Not a Git repository' }
      if (this.store.list().some(record => record.name === name && record.status !== 'removed')) return { ok: false, error: 'Worktree name already exists' }
      const root = join(this.repoRoot, '.harness-code', 'worktrees'); const path = join(root, name); mkdirSync(root, { recursive: true })
      if (existsSync(path)) return { ok: false, error: 'Worktree path already exists' }
      const rel = relative(this.repoRoot, path); if (rel.startsWith('..') || rel.includes('/') && rel.split('/').some(part => part === '..')) return { ok: false, error: 'Worktree path escapes repository' }
      const baseRef = options.baseRef ?? 'HEAD'; const id = newWorktreeId(); const branch = `harness/${name}`
      if (this.git.run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: this.repoRoot }).ok) return { ok: false, error: `Branch already exists: ${branch}` }
      const now = Date.now(); const record: WorktreeRecord = { id, name, path, branch, baseRef, repoRoot: this.repoRoot, taskId: options.taskId, owner: options.owner, sessionId: options.sessionId, status: 'creating', createdAt: now, updatedAt: now, leaseUntil: options.owner ? now + LEASE_MS : undefined }
      this.store.save(record)
      const added = this.git.run(['worktree', 'add', path, '-b', branch, baseRef], { cwd: this.repoRoot })
      if (!added.ok) { record.status = 'error'; record.error = added.stderr || added.stdout || 'git worktree add failed'; record.updatedAt = Date.now(); this.store.save(record); return { ok: false, error: record.error } }
      record.status = 'active'; record.updatedAt = Date.now(); this.store.save(record)
      if (options.taskId && options.owner && this.tasks) { const bound = this.tasks.bindWorktree(options.taskId, id, options.owner); if (!bound.ok) { this.git.run(['worktree', 'remove', path, '--force'], { cwd: this.repoRoot }); record.status = 'error'; record.error = bound.error; this.store.save(record); return { ok: false, error: bound.error } } }
      return { ok: true, worktree: copy(record) }
    })
  }
  keep(idOrName: string, owner?: string): WorktreeResult { return this.store.mutate(() => { const record = this.store.get(idOrName); if (!record) return { ok: false, error: 'Worktree not found' }; if (!existsSync(record.path)) return { ok: false, error: 'Worktree path no longer exists' }; if (record.owner && owner && record.owner !== owner) return { ok: false, error: 'Only the worktree owner can keep it' }; record.status = 'kept'; delete record.leaseUntil; record.updatedAt = Date.now(); this.store.save(record); return { ok: true, worktree: copy(record) } }) }
  remove(idOrName: string, options: { owner?: string; discardChanges?: boolean } = {}): WorktreeResult { return this.store.mutate(() => { const record = this.store.get(idOrName); if (!record) return { ok: false, error: 'Worktree not found' }; if (record.status === 'removed') return { ok: true, worktree: copy(record) }; if (record.owner && options.owner && record.owner !== options.owner) return { ok: false, error: 'Only the worktree owner can remove it' }; if (record.leaseUntil && record.leaseUntil > Date.now() && !options.discardChanges) return { ok: false, error: 'Worktree has an active lease; keep or explicitly discard it' }; const status = this.git.run(['status', '--porcelain'], { cwd: record.path }); const commits = this.git.run(['rev-list', '--count', `${record.baseRef}..${record.branch}`], { cwd: this.repoRoot }); if (!options.discardChanges && ((!status.ok) || status.stdout.trim() || !commits.ok || Number(commits.stdout.trim() || '0') > 0)) return { ok: false, error: 'Worktree has changes or its status could not be verified; use discardChanges only with explicit approval' }; record.status = 'removing'; record.updatedAt = Date.now(); this.store.save(record); const removed = this.git.run(['worktree', 'remove', ...(options.discardChanges ? ['--force'] : []), record.path], { cwd: this.repoRoot }); if (!removed.ok) { record.status = 'error'; record.error = removed.stderr || removed.stdout || 'git worktree remove failed'; record.updatedAt = Date.now(); this.store.save(record); return { ok: false, error: record.error } } this.git.run(['branch', options.discardChanges ? '-D' : '-d', record.branch], { cwd: this.repoRoot }); record.status = 'removed'; delete record.leaseUntil; record.updatedAt = Date.now(); this.store.save(record); return { ok: true, worktree: copy(record) } }) }
  reconcile(): WorktreeRecord[] { return this.store.mutate(() => { const listed = this.git.run(['worktree', 'list', '--porcelain'], { cwd: this.repoRoot }); if (!listed.ok) return []; const paths = new Set(listed.stdout.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))); const changed: WorktreeRecord[] = []; for (const record of this.store.list()) if (record.status !== 'removed' && !paths.has(record.path)) { record.status = 'orphaned'; record.updatedAt = Date.now(); this.store.save(record); changed.push(copy(record)) } return changed }) }
  private isRepository(): boolean { return this.git.run(['rev-parse', '--is-inside-work-tree'], { cwd: this.repoRoot }).ok }
}

export function createWorktreeService(cwd: string, git?: GitRunner, tasks?: TaskService): WorktreeService { return new WorktreeService(cwd, git, tasks) }
