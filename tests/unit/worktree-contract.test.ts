import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorktreeService } from '../../src/services/worktree/service.js'
import { createTaskService } from '../../src/services/tasks/service.js'
import { fakeGit } from '../support/fixtures.js'
import type { GitResult } from '../../src/services/worktree/types.js'

function result(overrides: Partial<GitResult> = {}): GitResult { return { ok: true, stdout: '', stderr: '', exitCode: 0, ...overrides } }
function gitForCreate(add: Partial<GitResult> = {}) {
  const git = fakeGit()
  git.results.push(result(), result({ ok: false }), result(add))
  return git
}

describe('worktree service contract', () => {
  let home: string
  let repo: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'harness-worktree-contract-')); repo = join(home, 'repo'); mkdirSync(repo, { recursive: true }); execFileSync('git', ['init', '-q'], { cwd: repo }); vi.stubEnv('HOME', home) })
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

  it('uses argv-only GitRunner calls and persists a kept worktree', () => {
    const git = gitForCreate(); const service = createWorktreeService(repo, git)
    const created = service.create('feature', { owner: 'lead', sessionId: 's', baseRef: 'main' })
    expect(created).toMatchObject({ ok: true, worktree: { name: 'feature', branch: 'harness/feature', baseRef: 'main', status: 'active' } })
    expect(git.calls).toEqual([
      ['rev-parse', '--is-inside-work-tree'],
      ['show-ref', '--verify', '--quiet', 'refs/heads/harness/feature'],
      ['worktree', 'add', expect.stringContaining('.harness-code/worktrees/feature'), '-b', 'harness/feature', 'main'],
    ])
    mkdirSync(created.worktree!.path, { recursive: true })
    const kept = service.keep('feature', 'lead')
    expect(kept.worktree).toMatchObject({ status: 'kept' })
    expect(service.get('feature')?.leaseUntil).toBeUndefined()
  })

  it.each(['', '.', '..', '../escape', 'a/b', 'a\\b', 'a\\u0000b', 'x'.repeat(65)])('rejects unsafe worktree name %s without Git calls', name => {
    const git = fakeGit(); const service = createWorktreeService(repo, git)
    expect(service.create(name).ok).toBe(false)
    expect(git.calls).toEqual([])
  })

  it('marks Git add failure as an error and does not report success', () => {
    const git = gitForCreate({ ok: false, stderr: 'add failed', exitCode: 1 }); const service = createWorktreeService(repo, git)
    const created = service.create('broken')
    expect(created).toMatchObject({ ok: false, error: 'add failed' })
    expect(service.get('broken')).toMatchObject({ status: 'error', error: 'add failed' })
  })

  it('protects branch collisions, dirty trees, and active owners', () => {
    const branchGit = fakeGit(); branchGit.results.push(result(), result({ ok: true }))
    expect(createWorktreeService(repo, branchGit).create('same')).toMatchObject({ ok: false, error: 'Branch already exists: harness/same' })

    const git = gitForCreate(); const service = createWorktreeService(repo, git)
    expect(service.create('dirty').ok).toBe(true)
    const path = service.get('dirty')!.path
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'changes.txt'), 'dirty')
    // The default fake reports a clean status; explicitly queue dirty responses.
    git.results.push(result({ stdout: ' M changes.txt\n' }), result({ stdout: '0\n' }))
    expect(service.remove('dirty')).toMatchObject({ ok: false })

    git.results.push(result(), result({ ok: false }), result())
    const owned = service.create('owned', { owner: 'lead' })
    expect(owned.ok).toBe(true)
    expect(service.remove('owned', { owner: 'other', discardChanges: true })).toMatchObject({ ok: false, error: 'Only the worktree owner can remove it' })
  })

  it('removes clean worktrees, cleans the branch, and is idempotent', () => {
    const git = gitForCreate(); const service = createWorktreeService(repo, git)
    expect(service.create('clean').ok).toBe(true)
    // create has consumed its three calls; remove now consumes status, rev-list, remove, branch.
    git.results.push(result({ stdout: '' }), result({ stdout: '0\n' }), result(), result())
    const removed = service.remove('clean')
    expect(removed).toMatchObject({ ok: true, worktree: { status: 'removed' } })
    expect(service.remove('clean')).toMatchObject({ ok: true, worktree: { status: 'removed' } })
    expect(git.calls.at(-2)).toEqual(['worktree', 'remove', expect.stringContaining('clean')])
    expect(git.calls.at(-1)).toEqual(['branch', '-d', 'harness/clean'])
  })

  it('rolls back task binding when the task owner does not match', () => {
    const tasks = createTaskService(repo)
    const task = tasks.create('task').task!
    expect(tasks.claim(task.id, 'other').ok).toBe(true)
    const git = gitForCreate(); const service = createWorktreeService(repo, git, tasks)
    const created = service.create('task-tree', { taskId: task.id, owner: 'lead' })
    expect(created).toMatchObject({ ok: false, error: 'Only the task owner can bind a worktree' })
    expect(service.get('task-tree')).toMatchObject({ status: 'error' })
    expect(git.calls.some(call => call[0] === 'worktree' && call[1] === 'remove')).toBe(true)
  })

  it('reconciles metadata whose Git worktree has disappeared', () => {
    const git = gitForCreate(); const service = createWorktreeService(repo, git)
    expect(service.create('orphan').ok).toBe(true)
    const path = service.get('orphan')!.path
    rmSync(path, { recursive: true, force: true })
    git.results.push(result({ stdout: 'worktree /some/other/path\nbranch refs/heads/main\n' }))
    expect(service.reconcile().map(item => item.name)).toContain('orphan')
    expect(service.get('orphan')?.status).toBe('orphaned')
    expect(existsSync(path)).toBe(false)
  })
})
